//! Locate the user's omp install and the environment to run it in.
//! Apps launched from Finder get launchd's minimal PATH, so both come from a login shell.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::OnceCell;

pub const MIN_VERSION: [u32; 3] = [18, 8, 9];
const MARKER: &str = "__OMPI_ENV__";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OmpInfo {
    pub path: String,
    pub version: String,
    pub agent_dir: String,
    pub supported: bool,
}

pub struct Omp {
    pub info: OmpInfo,
    pub env: HashMap<String, String>,
}

static OMP: OnceCell<Result<Omp, String>> = OnceCell::const_new();

pub async fn get() -> Result<&'static Omp, String> {
    OMP.get_or_init(discover).await.as_ref().map_err(Clone::clone)
}

async fn discover() -> Result<Omp, String> {
    let env = login_env().await.unwrap_or_else(|e| {
        log::warn!("login shell environment unavailable ({e}); using the process environment");
        std::env::vars().collect()
    });
    let path = env
        .get("OMPI_OMP_PATH")
        .map(PathBuf::from)
        .or_else(|| which("omp", env.get("PATH")?))
        .ok_or("omp not found on PATH. Install it from https://omp.sh, or set OMPI_OMP_PATH.")?;
    let version_out = run(&path, &["--version"], &env).await?;
    let version = version_out.trim().trim_start_matches("omp/").to_string();
    let agent_dir = run(&path, &["config", "path"], &env).await?.trim().to_string();
    let supported = parse_version(&version).is_some_and(|v| v >= MIN_VERSION);
    Ok(Omp {
        info: OmpInfo { path: path.to_string_lossy().into_owned(), version, agent_dir, supported },
        env,
    })
}

async fn login_env() -> Result<HashMap<String, String>, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = tokio::process::Command::new(&shell)
        .args(["-l", "-i", "-c", &format!("printf '{MARKER}\\0'; env -0")])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("{shell}: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (_, body) = text.split_once(&format!("{MARKER}\0")).ok_or("login shell printed no environment")?;
    let env: HashMap<_, _> = body
        .split('\0')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if env.contains_key("PATH") { Ok(env) } else { Err("login shell environment has no PATH".into()) }
}

fn which(bin: &str, path: &str) -> Option<PathBuf> {
    std::env::split_paths(path).map(|d| d.join(bin)).find(|p| p.is_file())
}

async fn run(bin: &PathBuf, args: &[&str], env: &HashMap<String, String>) -> Result<String, String> {
    let out = tokio::process::Command::new(bin)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    if !out.status.success() {
        return Err(format!("omp {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn parse_version(v: &str) -> Option<[u32; 3]> {
    let mut it = v.split(['.', '-']).map(|p| p.parse::<u32>().ok());
    Some([it.next()??, it.next()??, it.next()??])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_gate() {
        assert!(parse_version("18.8.9").unwrap() >= MIN_VERSION);
        assert!(parse_version("18.10.0").unwrap() >= MIN_VERSION);
        assert!(parse_version("18.8.8").unwrap() < MIN_VERSION);
        assert!(parse_version("19.0.0-beta.1").unwrap() >= MIN_VERSION);
        assert!(parse_version("garbage").is_none());
    }
}
