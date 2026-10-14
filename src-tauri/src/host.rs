//! One `omp --mode rpc-ui` process per open session. Rust owns the processes so they
//! survive webview reloads; unanswered dialogs are kept and replayed when a tab attaches.

use crate::frame::{Head, Reassembler, Step, MAX_REASSEMBLED};
use crate::omp;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::value::RawValue;
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

const STDERR_TAIL: usize = 200;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const IDLE_REAP_AFTER: Duration = Duration::from_secs(10 * 60);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Dialog methods that block omp until the host answers.
const BLOCKING_METHODS: &[&str] = &["select", "confirm", "input", "editor", "ask"];

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Starting,
    Idle,
    Streaming,
    Exited,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub handle: u64,
    pub phase: Phase,
    pub needs_input: bool,
    pub session_file: Option<String>,
    pub exit: Option<String>,
}

pub struct SpawnArgs {
    /// Stable per-tab key from the webview. A reloaded webview reattaches to the process it
    /// already owns instead of spawning a duplicate omp for the same tab.
    pub key: String,
    pub cwd: String,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub extra_dirs: Vec<String>,
    pub configs: Vec<String>,
    pub extensions: Vec<String>,
    /// Per-process files the host deletes when the process is gone (the session's run overlay).
    pub owned_files: Vec<std::path::PathBuf>,
}

struct Proc {
    key: String,
    stdin: mpsc::UnboundedSender<String>,
    pending: HashMap<String, oneshot::Sender<Box<RawValue>>>,
    dialogs: Vec<(String, String)>,
    status_frames: HashMap<String, String>,
    channel: Option<Channel<InvokeResponseBody>>,
    phase: Phase,
    session_file: Option<String>,
    stderr: VecDeque<String>,
    attached: bool,
    settled_since: Instant,
    exit: Option<String>,
    owned_files: Vec<std::path::PathBuf>,
}

#[derive(Default)]
pub struct Host {
    next: AtomicU64,
    procs: Mutex<HashMap<u64, Proc>>,
    children: Mutex<HashMap<u64, Child>>,
}

impl Host {
    pub async fn open(self: &Arc<Self>, app: AppHandle, args: SpawnArgs) -> Result<u64, String> {
        // A webview reload (dev HMR, crash recovery) re-opens its tabs: hand back the live process.
        let existing = self.procs.lock().iter().find(|(_, p)| p.key == args.key && p.phase != Phase::Exited).map(|(h, _)| *h);
        if let Some(handle) = existing {
            return Ok(handle);
        }
        let omp = omp::get().await?;
        if !omp.info.supported {
            let [a, b, c] = omp::MIN_VERSION;
            return Err(format!("omp {} is too old; ompi needs {a}.{b}.{c} or later", omp.info.version));
        }
        let mut cmd = Command::new(&omp.info.path);
        cmd.args(["--mode", "rpc-ui"]);
        if let Some(f) = &args.resume {
            cmd.args(["--resume", f]);
        } else if let Some(m) = &args.model {
            cmd.args(["--model", m]);
        }
        for d in &args.extra_dirs {
            cmd.args(["--add-dir", d]);
        }
        for c in &args.configs {
            cmd.args(["--config", c]);
        }
        for e in &args.extensions {
            cmd.args(["-e", e]);
        }
        cmd.current_dir(&args.cwd)
            .env_clear()
            .envs(&omp.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("failed to start omp: {e}"))?;

        let handle = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let stdin = child.stdin.take().expect("piped stdin");
        self.procs.lock().insert(
            handle,
            Proc {
                key: args.key.clone(),
                stdin: tx,
                pending: HashMap::new(),
                dialogs: Vec::new(),
                status_frames: HashMap::new(),
                channel: None,
                phase: Phase::Starting,
                session_file: args.resume.clone(),
                stderr: VecDeque::new(),
                attached: false,
                settled_since: Instant::now(),
                exit: None,
                owned_files: args.owned_files.clone(),
            },
        );
        self.children.lock().insert(handle, child);

        let (ready_tx, ready_rx) = oneshot::channel();
        tokio::spawn(write_loop(stdin, rx));
        tokio::spawn(self.clone().read_loop(app.clone(), handle, stdout, ready_tx));
        tokio::spawn(self.clone().stderr_loop(handle, stderr));

        let ready = match tokio::time::timeout(STARTUP_TIMEOUT, ready_rx).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err("omp exited before it was ready".to_string()),
            Err(_) => Err("omp did not become ready within 60 s".to_string()),
        };
        if let Err(msg) = ready {
            return Err(self.fail(handle, msg));
        }
        for (cmd, what) in [
            (r#"{"type":"negotiate_protocol","protocolVersion":2}"#, "negotiate protocol v2"),
            (r#"{"type":"set_event_filter","events":null,"messageUpdates":"delta"}"#, "enable delta updates"),
            (r#"{"type":"set_ask_dialog","enabled":true}"#, "enable ask dialogs"),
        ] {
            let reply = self.request(handle, cmd.to_string()).await?;
            if !is_success(&reply) {
                return Err(self.fail(handle, format!("omp refused to {what}: {}", reply.get())));
            }
        }
        self.refresh_session_file(&app, handle).await;
        self.set_phase(&app, handle, Phase::Idle);
        Ok(handle)
    }

    /// Kill a process that failed to start and return the message with its stderr tail.
    fn fail(&self, handle: u64, msg: String) -> String {
        let tail = self.stderr_tail(handle);
        if let Some(p) = self.procs.lock().remove(&handle) {
            remove_files(&p.owned_files);
        }
        if let Some(mut c) = self.children.lock().remove(&handle) {
            let _ = c.start_kill();
        }
        if tail.is_empty() { msg } else { format!("{msg}\n\n{tail}") }
    }

    /// Send a command and wait for its response frame. The host assigns the id.
    pub async fn request(&self, handle: u64, mut cmd: String) -> Result<Box<RawValue>, String> {
        let id = format!("h{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        {
            let mut procs = self.procs.lock();
            let p = procs.get_mut(&handle).ok_or("session process is gone")?;
            insert_id(&mut cmd, &id)?;
            p.pending.insert(id, tx);
            p.stdin.send(cmd).map_err(|_| "session process stdin is closed")?;
        }
        rx.await.map_err(|_| "session process exited before replying".to_string())
    }

    /// Fire-and-forget write: dialog answers, and commands whose replies the webview correlates.
    pub fn send(&self, handle: u64, frame: String) -> Result<(), String> {
        let mut procs = self.procs.lock();
        let p = procs.get_mut(&handle).ok_or("session process is gone")?;
        if let Some(id) = dialog_response_id(&frame) {
            p.dialogs.retain(|(d, _)| d != &id);
        }
        p.stdin.send(frame).map_err(|_| "session process stdin is closed".to_string())
    }

    /// Attach a webview channel. Replays status chips and any unanswered dialogs.
    pub fn attach(&self, handle: u64, channel: Channel<InvokeResponseBody>) -> Result<(), String> {
        let mut procs = self.procs.lock();
        let p = procs.get_mut(&handle).ok_or("session process is gone")?;
        for raw in p.status_frames.values().chain(p.dialogs.iter().map(|(_, raw)| raw)) {
            let _ = channel.send(InvokeResponseBody::Json(raw.clone()));
        }
        p.channel = Some(channel);
        p.attached = true;
        Ok(())
    }

    pub fn detach(&self, handle: u64) {
        if let Some(p) = self.procs.lock().get_mut(&handle) {
            p.channel = None;
            p.attached = false;
            p.settled_since = Instant::now();
        }
    }

    pub fn status(&self, handle: u64) -> Option<Status> {
        self.procs.lock().get(&handle).map(|p| snapshot(handle, p))
    }

    pub fn stderr_tail(&self, handle: u64) -> String {
        self.procs.lock().get(&handle).map(|p| p.stderr.iter().map(String::as_str).collect()).unwrap_or_default()
    }

    /// Re-read `get_state.sessionFile`; `new_session` and `fork` move a process to another file.
    pub async fn refresh_session_file(&self, app: &AppHandle, handle: u64) {
        let Ok(raw) = self.request(handle, r#"{"type":"get_state"}"#.into()).await else { return };
        #[derive(serde::Deserialize)]
        struct S {
            data: Option<D>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct D {
            session_file: Option<String>,
        }
        let file = serde_json::from_str::<S>(raw.get()).ok().and_then(|s| s.data).and_then(|d| d.session_file);
        let status = {
            let mut procs = self.procs.lock();
            let Some(p) = procs.get_mut(&handle) else { return };
            if p.session_file == file {
                return;
            }
            p.session_file = file;
            snapshot(handle, p)
        };
        let _ = app.emit("omp:status", status);
    }

    /// Close stdin: omp rejects pending dialogs, drains accepted commands and exits 0.
    pub async fn close(&self, handle: u64) {
        if let Some(p) = self.procs.lock().remove(&handle) {
            remove_files(&p.owned_files);
        }
        let child = self.children.lock().remove(&handle);
        if let Some(child) = child {
            wait_or_kill(child).await;
        }
    }

    /// App shutdown: drop every stdin at once, then wait for all children concurrently.
    pub async fn close_all(&self) {
        for (_, p) in self.procs.lock().drain() {
            remove_files(&p.owned_files);
        }
        let children: Vec<Child> = self.children.lock().drain().map(|(_, c)| c).collect();
        let mut set = tokio::task::JoinSet::new();
        for c in children {
            set.spawn(wait_or_kill(c));
        }
        while set.join_next().await.is_some() {}
    }

    /// Stop processes that are settled, dialog-free and unattached for a while.
    pub async fn reap_idle(&self, app: &AppHandle) {
        let stale: Vec<u64> = self
            .procs
            .lock()
            .iter()
            .filter(|(_, p)| !p.attached && p.phase == Phase::Idle && p.dialogs.is_empty() && p.settled_since.elapsed() > IDLE_REAP_AFTER)
            .map(|(h, _)| *h)
            .collect();
        for h in stale {
            self.close(h).await;
            let status = Status { handle: h, phase: Phase::Exited, needs_input: false, session_file: None, exit: Some("stopped while idle".into()) };
            let _ = app.emit("omp:status", status);
        }
    }

    fn set_phase(&self, app: &AppHandle, handle: u64, phase: Phase) {
        let status = {
            let mut procs = self.procs.lock();
            let Some(p) = procs.get_mut(&handle) else { return };
            if p.phase == phase {
                return;
            }
            p.phase = phase;
            if phase == Phase::Idle {
                p.settled_since = Instant::now();
            }
            snapshot(handle, p)
        };
        let _ = app.emit("omp:status", status);
    }

    async fn stderr_loop(self: Arc<Self>, handle: u64, stderr: tokio::process::ChildStderr) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut procs = self.procs.lock();
            let Some(p) = procs.get_mut(&handle) else { break };
            if p.stderr.len() == STDERR_TAIL {
                p.stderr.pop_front();
            }
            p.stderr.push_back(line + "\n");
        }
    }

    async fn read_loop(self: Arc<Self>, app: AppHandle, handle: u64, stdout: tokio::process::ChildStdout, ready: oneshot::Sender<()>) {
        let mut ready = Some(ready);
        let mut reader = BufReader::with_capacity(1 << 20, stdout);
        let mut chunks = Reassembler::new(MAX_REASSEMBLED);
        let mut buf = Vec::with_capacity(1 << 16);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = trim_newline(&buf);
            if line.is_empty() {
                continue;
            }
            let head: Head = serde_json::from_slice(line).unwrap_or_default();
            let (head, raw) = if head.kind == "rpc_chunk" {
                match chunks.push(line) {
                    Ok(Step::Pending) => continue,
                    Ok(Step::Frame(raw)) => (serde_json::from_str(raw.get()).unwrap_or_default(), raw),
                    Err(e) => {
                        self.forward_error(handle, &e);
                        continue;
                    }
                }
            } else {
                if let Err(e) = chunks.interrupt() {
                    self.forward_error(handle, &e);
                }
                let Some(raw) = std::str::from_utf8(line).ok().and_then(|s| RawValue::from_string(s.to_owned()).ok()) else {
                    continue;
                };
                (head, raw)
            };
            if head.kind == "ready" {
                if let Some(r) = ready.take() {
                    let _ = r.send(());
                }
                continue;
            }
            self.route(&app, handle, head, raw);
        }
        self.on_exit(&app, handle).await;
    }

    fn route(&self, app: &AppHandle, handle: u64, head: Head, raw: Box<RawValue>) {
        match head.kind.as_str() {
            "agent_start" => self.set_phase(app, handle, Phase::Streaming),
            "agent_end" if head.is_terminal != Some(false) => self.set_phase(app, handle, Phase::Idle),
            _ => {}
        }
        let mut status_change = None;
        let channel = {
            let mut procs = self.procs.lock();
            let Some(p) = procs.get_mut(&handle) else { return };
            if head.kind == "response" {
                if let Some(tx) = head.id.as_deref().and_then(|id| p.pending.remove(id)) {
                    let _ = tx.send(raw);
                    return;
                }
            }
            if head.kind == "extension_ui_request" {
                let had_dialogs = !p.dialogs.is_empty();
                match head.method.as_deref().unwrap_or_default() {
                    m if BLOCKING_METHODS.contains(&m) => p.dialogs.push((head.id.clone().unwrap_or_default(), raw.get().to_owned())),
                    "cancel" => {
                        if let Some(t) = &head.target_id {
                            p.dialogs.retain(|(d, _)| d != t);
                        }
                    }
                    "setStatus" => {
                        let key = format!("s:{}", head.status_key.unwrap_or_default());
                        if head.status_text.is_some() {
                            p.status_frames.insert(key, raw.get().to_owned());
                        } else {
                            p.status_frames.remove(&key);
                        }
                    }
                    "setWidget" => {
                        let key = format!("w:{}", head.widget_key.unwrap_or_default());
                        if head.widget_lines.is_some() {
                            p.status_frames.insert(key, raw.get().to_owned());
                        } else {
                            p.status_frames.remove(&key);
                        }
                    }
                    _ => {}
                }
                if had_dialogs == p.dialogs.is_empty() {
                    status_change = Some(snapshot(handle, p));
                }
            }
            p.channel.clone()
        };
        if let Some(s) = status_change {
            let _ = app.emit("omp:status", s);
        }
        if let Some(ch) = channel {
            let _ = ch.send(InvokeResponseBody::Json(raw.get().to_owned()));
        }
    }

    fn forward_error(&self, handle: u64, msg: &str) {
        log::warn!("omp[{handle}] transport: {msg}");
        let frame = serde_json::json!({ "type": "notice", "level": "error", "message": format!("Transport error: {msg}"), "source": "ompi" });
        if let Some(ch) = self.procs.lock().get(&handle).and_then(|p| p.channel.clone()) {
            let _ = ch.send(InvokeResponseBody::Json(frame.to_string()));
        }
    }

    async fn on_exit(&self, app: &AppHandle, handle: u64) {
        let child = self.children.lock().remove(&handle);
        let code = match child {
            Some(mut c) => c.wait().await.ok().map(|s| s.to_string()),
            None => None,
        };
        let status = {
            let mut procs = self.procs.lock();
            let Some(p) = procs.get_mut(&handle) else { return };
            p.phase = Phase::Exited;
            remove_files(&std::mem::take(&mut p.owned_files));
            p.pending.clear();
            p.dialogs.clear();
            let n = p.stderr.len();
            let tail: String = p.stderr.iter().skip(n.saturating_sub(20)).map(String::as_str).collect();
            let code = code.unwrap_or_else(|| "unknown status".into());
            p.exit = Some(if tail.is_empty() { format!("omp exited ({code})") } else { format!("omp exited ({code})\n\n{tail}") });
            snapshot(handle, p)
        };
        let _ = app.emit("omp:status", status);
    }
}

fn snapshot(handle: u64, p: &Proc) -> Status {
    Status { handle, phase: p.phase, needs_input: !p.dialogs.is_empty(), session_file: p.session_file.clone(), exit: p.exit.clone() }
}

fn remove_files(files: &[std::path::PathBuf]) {
    for f in files {
        let _ = std::fs::remove_file(f);
    }
}

async fn wait_or_kill(mut child: Child) {
    if tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

async fn write_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(mut frame) = rx.recv().await {
        frame.push('\n');
        if stdin.write_all(frame.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
    let _ = stdin.shutdown().await;
}

fn trim_newline(b: &[u8]) -> &[u8] {
    let b = b.strip_suffix(b"\n").unwrap_or(b);
    b.strip_suffix(b"\r").unwrap_or(b)
}

pub fn is_success(raw: &RawValue) -> bool {
    #[derive(serde::Deserialize)]
    struct R {
        success: Option<bool>,
    }
    serde_json::from_str::<R>(raw.get()).ok().and_then(|r| r.success).unwrap_or(false)
}

/// Splice `"id":"..."` into a JSON object command. Rejects anything that isn't an object.
fn insert_id(cmd: &mut String, id: &str) -> Result<(), String> {
    let t = cmd.trim_start();
    if !t.starts_with('{') {
        return Err("command must be a JSON object".into());
    }
    let off = cmd.len() - t.len() + 1;
    let sep = if cmd[off..].trim_start().starts_with('}') { "" } else { "," };
    let field = format!("\"id\":{}{sep}", serde_json::to_string(id).expect("string serializes"));
    cmd.insert_str(off, &field);
    Ok(())
}

fn dialog_response_id(frame: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct R {
        #[serde(rename = "type")]
        kind: String,
        id: Option<String>,
    }
    let r: R = serde_json::from_str(frame).ok()?;
    (r.kind == "extension_ui_response").then_some(r.id).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splices_ids() {
        let mut a = r#"{"type":"get_state"}"#.to_string();
        insert_id(&mut a, "h1").unwrap();
        assert_eq!(a, r#"{"id":"h1","type":"get_state"}"#);
        let mut b = "{}".to_string();
        insert_id(&mut b, "h2").unwrap();
        assert_eq!(b, r#"{"id":"h2"}"#);
        assert!(insert_id(&mut "[1]".to_string(), "x").is_err());
    }

    #[test]
    fn recognises_dialog_responses() {
        assert_eq!(dialog_response_id(r#"{"type":"extension_ui_response","id":"d1","value":"Approve"}"#).as_deref(), Some("d1"));
        assert_eq!(dialog_response_id(r#"{"type":"prompt","id":"p1","message":"x"}"#), None);
    }

    #[test]
    fn reads_success_flag() {
        assert!(is_success(&RawValue::from_string(r#"{"type":"response","success":true}"#.into()).unwrap()));
        assert!(!is_success(&RawValue::from_string(r#"{"type":"response","success":false,"error":"x"}"#.into()).unwrap()));
    }
}
