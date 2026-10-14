//! Access scopes as omp `--config` overlays owned by ompi. omp watches these files in RPC
//! modes, so rewriting one changes approval behavior without restarting the session.
//! JSON is valid YAML, so overlays are written as JSON.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    AlwaysAsk,
    Write,
    Yolo,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Allow,
    Prompt,
    Deny,
}

/// Tools that run code or act outside the working tree. Prompted while planning because
/// omp's plan-mode guard only blocks `write`/`edit`.
const PLAN_GATED_TOOLS: &[&str] = &["bash", "eval", "browser", "task", "computer"];

pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("overlays")
}

/// Run overlays belong to one process. Any left on disk at startup are from a crash: remove them.
pub fn sweep_stale_runs(app_data: &Path) {
    let Ok(entries) = std::fs::read_dir(dir(app_data)) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with("run-") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

pub fn workspace_path(app_data: &Path, workspace_id: &str) -> Result<PathBuf, String> {
    Ok(dir(app_data).join(format!("ws-{}.yml", safe_key(workspace_id)?)))
}

pub fn run_path(app_data: &Path, run_key: &str) -> Result<PathBuf, String> {
    Ok(dir(app_data).join(format!("run-{}.yml", safe_key(run_key)?)))
}

fn safe_key(k: &str) -> Result<&str, String> {
    if !k.is_empty() && k.len() <= 128 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(k)
    } else {
        Err(format!("invalid overlay key {k:?}"))
    }
}

/// Per-workspace per-tool policies, e.g. "Always allow bash in this workspace".
pub fn workspace_body(rules: &BTreeMap<String, Policy>) -> String {
    serde_json::json!({ "tools": { "approval": rules } }).to_string()
}

/// Per-session mode, loaded after the workspace overlay so it wins.
/// While planning, Full access is clamped to Write and executable tools are prompted.
pub fn run_body(scope: Scope, planning: bool) -> String {
    let mode = if planning && scope == Scope::Yolo { Scope::Write } else { scope };
    let mut tools = serde_json::json!({ "approvalMode": mode });
    if planning {
        let gated: BTreeMap<&str, Policy> = PLAN_GATED_TOOLS.iter().map(|t| (*t, Policy::Prompt)).collect();
        tools["approval"] = serde_json::to_value(gated).expect("map serializes");
    }
    serde_json::json!({ "tools": tools }).to_string()
}

/// Write via a temp file + rename so omp never reads a half-written overlay.
pub fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("overlay path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let tmp = path.with_extension("yml.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planning_clamps_full_access() {
        let v: serde_json::Value = serde_json::from_str(&run_body(Scope::Yolo, true)).unwrap();
        assert_eq!(v["tools"]["approvalMode"], "write");
        assert_eq!(v["tools"]["approval"]["bash"], "prompt");
        let v: serde_json::Value = serde_json::from_str(&run_body(Scope::AlwaysAsk, true)).unwrap();
        assert_eq!(v["tools"]["approvalMode"], "always-ask", "planning never loosens a stricter scope");
        let v: serde_json::Value = serde_json::from_str(&run_body(Scope::Yolo, false)).unwrap();
        assert_eq!(v["tools"]["approvalMode"], "yolo");
        assert!(v["tools"].get("approval").is_none());
    }

    #[test]
    fn rejects_unsafe_keys() {
        assert!(run_path(Path::new("/x"), "../evil").is_err());
        assert!(workspace_path(Path::new("/x"), "").is_err());
        assert!(run_path(Path::new("/x"), "01a1-33cd_ok").is_ok());
    }
}
