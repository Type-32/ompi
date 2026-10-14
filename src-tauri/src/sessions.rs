//! Index omp's session store by reading the first two lines of each JSONL file:
//! the fixed-width title record (optional) and the session header.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub file: String,
    pub id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub created: String,
    pub modified_ms: u64,
    pub parent_session: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    v: Option<u32>,
    id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    timestamp: Option<String>,
    parent_session: Option<String>,
}

pub fn root(agent_dir: &str) -> PathBuf {
    Path::new(agent_dir).join("sessions")
}

pub fn list(agent_dir: &str) -> Vec<SessionMeta> {
    let Ok(projects) = std::fs::read_dir(root(agent_dir)) else { return Vec::new() };
    let mut out: Vec<SessionMeta> = projects
        .flatten()
        .filter(|d| d.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|d| std::fs::read_dir(d.path()).ok())
        .flatten()
        .flatten()
        .map(|f| f.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|p| read_meta(&p))
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

pub fn read_meta(path: &Path) -> Option<SessionMeta> {
    let mut lines = BufReader::new(File::open(path).ok()?).lines();
    let mut title = None;
    let mut rec: Record = serde_json::from_str(&lines.next()?.ok()?).ok()?;
    if rec.kind == "title" && rec.v == Some(1) {
        title = rec.title.filter(|t| !t.trim().is_empty());
        rec = serde_json::from_str(&lines.next()?.ok()?).ok()?;
    }
    if rec.kind != "session" {
        return None;
    }
    let modified_ms = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(SessionMeta {
        file: path.to_string_lossy().into_owned(),
        id: rec.id?,
        cwd: rec.cwd?,
        title: title.or(rec.title.filter(|t| !t.trim().is_empty())).or_else(|| first_prompt(lines)),
        created: rec.timestamp.unwrap_or_default(),
        modified_ms,
        parent_session: rec.parent_session,
    })
}

/// Lines scanned for a first prompt before giving up; keeps indexing cheap on huge files.
const PROMPT_SCAN_LINES: usize = 64;
const PROMPT_TITLE_CHARS: usize = 80;

/// Untitled sessions (omp only auto-titles in the TUI) are named after their first user prompt.
fn first_prompt(lines: impl Iterator<Item = std::io::Result<String>>) -> Option<String> {
    #[derive(Deserialize)]
    struct E {
        #[serde(rename = "type")]
        kind: String,
        message: Option<M>,
    }
    #[derive(Deserialize)]
    struct M {
        role: String,
        content: serde_json::Value,
    }
    for line in lines.take(PROMPT_SCAN_LINES).map_while(Result::ok) {
        if !line.contains(r#""role":"user""#) {
            continue;
        }
        let Ok(E { kind, message: Some(m) }) = serde_json::from_str::<E>(&line) else { continue };
        if kind != "message" || m.role != "user" {
            continue;
        }
        let text = match &m.content {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(blocks) => blocks.iter().filter_map(|b| b.get("text")?.as_str()).collect::<Vec<_>>().join(" "),
            _ => continue,
        };
        let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if one_line.is_empty() {
            continue;
        }
        let mut out: String = one_line.chars().take(PROMPT_TITLE_CHARS).collect();
        if one_line.chars().count() > PROMPT_TITLE_CHARS {
            out.push('…');
        }
        return Some(out);
    }
    None
}

/// Resolve `file` and require it to be a `.jsonl` directly inside a project folder of the store.
pub fn owned_session_file(agent_dir: &str, file: &str) -> Result<PathBuf, String> {
    let root = root(agent_dir).canonicalize().map_err(|e| format!("session store: {e}"))?;
    let path = Path::new(file).canonicalize().map_err(|e| format!("{file}: {e}"))?;
    let inside = path.parent().and_then(Path::parent) == Some(root.as_path());
    if !inside || path.extension().is_none_or(|e| e != "jsonl") {
        return Err(format!("{file} is not a session file in {}", root.display()));
    }
    Ok(path)
}

/// Delete a session file and its artifact folder (`<stem>/`).
pub fn delete(agent_dir: &str, file: &str) -> Result<(), String> {
    let path = owned_session_file(agent_dir, file)?;
    let artifacts = path.with_extension("");
    if artifacts.is_dir() {
        std::fs::remove_dir_all(&artifacts).map_err(|e| format!("{}: {e}", artifacts.display()))?;
    }
    std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Read a plan artifact: `<stem>/local/<slug>-plan.md`.
pub fn read_plan(agent_dir: &str, file: &str, slug: &str) -> Result<String, String> {
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid plan slug {slug:?}"));
    }
    let path = owned_session_file(agent_dir, file)?.with_extension("").join("local").join(format!("{slug}-plan.md"));
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn store() -> (tempdir::Dir, String) {
        let d = tempdir::Dir::new();
        std::fs::create_dir_all(d.path.join("sessions/-proj")).unwrap();
        let s = d.path.to_string_lossy().into_owned();
        (d, s)
    }

    mod tempdir {
        pub struct Dir {
            pub path: std::path::PathBuf,
        }
        impl Dir {
            pub fn new() -> Self {
                // Tests run in parallel: a clock-based name can collide and one test's cleanup deletes another's files.
                static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
                let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!("ompi-test-{}-{n}", std::process::id()));
                let _ = std::fs::remove_dir_all(&path);
                std::fs::create_dir_all(&path).unwrap();
                Self { path }
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }

    fn write(path: &Path, lines: &[&str]) {
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn reads_title_record_and_legacy_header() {
        let (d, agent) = store();
        let a = d.path.join("sessions/-proj/a.jsonl");
        write(&a, &[
            r#"{"type":"title","v":1,"title":"Upgrade Nuxt","source":"auto","updatedAt":"x","pad":"   "}"#,
            r#"{"type":"session","version":3,"id":"s1","timestamp":"t1","cwd":"/p","title":"stale"}"#,
        ]);
        let b = d.path.join("sessions/-proj/b.jsonl");
        write(&b, &[r#"{"type":"session","id":"s2","timestamp":"t2","cwd":"/p","parentSession":"/x/a.jsonl"}"#]);
        let c = d.path.join("sessions/-proj/c.jsonl");
        write(&c, &[
            r#"{"type":"title","v":1,"title":"","source":"auto","updatedAt":"x","pad":" "}"#,
            r#"{"type":"session","id":"s3","timestamp":"t3","cwd":"/p"}"#,
            r#"{"type":"model_change","id":"m","parentId":null,"timestamp":"t","model":"a/b"}"#,
            r#"{"type":"message","id":"u","parentId":"m","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"Explore\n   this   repo."}]}}"#,
        ]);
        write(&d.path.join("sessions/-proj/junk.jsonl"), &["not json"]);
        let mut all = list(&agent);
        all.sort_by(|x, y| x.id.cmp(&y.id));
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].title.as_deref(), Some("Upgrade Nuxt"), "the title record beats a stale header title");
        assert_eq!(all[1].title, None, "no title and no prompt");
        assert_eq!(all[2].title.as_deref(), Some("Explore this repo."), "untitled sessions fall back to the first prompt");
        assert_eq!(all[1].parent_session.as_deref(), Some("/x/a.jsonl"));
    }

    #[test]
    fn delete_is_confined_to_the_store() {
        let (d, agent) = store();
        let f = d.path.join("sessions/-proj/a.jsonl");
        write(&f, &[r#"{"type":"session","id":"s1","timestamp":"t","cwd":"/p"}"#]);
        std::fs::create_dir_all(d.path.join("sessions/-proj/a/local")).unwrap();
        let outside = d.path.join("victim.jsonl");
        write(&outside, &["x"]);
        assert!(delete(&agent, &outside.to_string_lossy()).is_err());
        let sneaky = d.path.join("sessions/-proj/../../victim.jsonl");
        assert!(delete(&agent, &sneaky.to_string_lossy()).is_err());
        assert!(outside.exists());
        delete(&agent, &f.to_string_lossy()).unwrap();
        assert!(!f.exists() && !d.path.join("sessions/-proj/a").exists());
    }

    #[test]
    fn plan_slug_cannot_escape() {
        let (d, agent) = store();
        let f = d.path.join("sessions/-proj/a.jsonl");
        write(&f, &[r#"{"type":"session","id":"s1","timestamp":"t","cwd":"/p"}"#]);
        std::fs::create_dir_all(d.path.join("sessions/-proj/a/local")).unwrap();
        std::fs::write(d.path.join("sessions/-proj/a/local/add-hello-plan.md"), "1. step").unwrap();
        assert_eq!(read_plan(&agent, &f.to_string_lossy(), "add-hello").unwrap(), "1. step");
        assert!(read_plan(&agent, &f.to_string_lossy(), "../../x").is_err());
    }
}
