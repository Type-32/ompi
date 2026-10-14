//! Tauri commands exposed to the webview.

use crate::host::{Host, SpawnArgs, Status};
use crate::overlays::{self, Policy, Scope};
use crate::{omp, sessions};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

type Res<T> = Result<T, String>;

fn app_data(app: &AppHandle) -> Res<PathBuf> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn bridge_path(app: &AppHandle) -> Res<String> {
    let p = app
        .path()
        .resolve("resources/ompi-bridge.ts", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("bridge extension: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn omp_info() -> Res<omp::OmpInfo> {
    omp::get().await.map(|o| o.info.clone())
}

#[tauri::command]
pub async fn session_list() -> Res<Vec<sessions::SessionMeta>> {
    let agent = omp::get().await?.info.agent_dir.clone();
    tokio::task::spawn_blocking(move || sessions::list(&agent)).await.map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    cwd: String,
    resume: Option<String>,
    model: Option<String>,
    #[serde(default)]
    extra_dirs: Vec<String>,
    workspace_id: String,
    run_key: String,
    scope: Scope,
    #[serde(default)]
    planning: bool,
}

#[tauri::command]
pub async fn session_open(app: AppHandle, host: State<'_, Arc<Host>>, args: OpenArgs) -> Res<u64> {
    let data = app_data(&app)?;
    let ws = overlays::workspace_path(&data, &args.workspace_id)?;
    if !ws.exists() {
        overlays::write_atomic(&ws, &overlays::workspace_body(&BTreeMap::new()))?;
    }
    let run = overlays::run_path(&data, &args.run_key)?;
    overlays::write_atomic(&run, &overlays::run_body(args.scope, args.planning))?;
    let spawn = SpawnArgs {
        key: args.run_key.clone(),
        cwd: args.cwd,
        resume: args.resume,
        model: args.model,
        extra_dirs: args.extra_dirs,
        configs: vec![ws.to_string_lossy().into_owned(), run.to_string_lossy().into_owned()],
        extensions: vec![bridge_path(&app)?],
        owned_files: vec![run],
    };
    host.inner().open(app, spawn).await
}

#[tauri::command]
pub fn session_attach(host: State<'_, Arc<Host>>, handle: u64, channel: Channel<InvokeResponseBody>) -> Res<()> {
    host.attach(handle, channel)
}

#[tauri::command]
pub fn session_detach(host: State<'_, Arc<Host>>, handle: u64) {
    host.detach(handle);
}

#[tauri::command]
pub fn session_status(host: State<'_, Arc<Host>>, handle: u64) -> Option<Status> {
    host.status(handle)
}

/// Fire-and-forget frame; responses arrive on the attached channel, correlated by `id`.
#[tauri::command]
pub fn session_send(host: State<'_, Arc<Host>>, handle: u64, frame: String) -> Res<()> {
    host.send(handle, frame)
}

/// Request/response: the host assigns the id and returns the response frame.
#[tauri::command]
pub async fn session_request(host: State<'_, Arc<Host>>, handle: u64, command: String) -> Res<InvokeResponseBody> {
    let raw = host.request(handle, command).await?;
    Ok(InvokeResponseBody::Json(raw.get().to_owned()))
}

#[tauri::command]
pub async fn session_refresh_file(app: AppHandle, host: State<'_, Arc<Host>>, handle: u64) -> Res<()> {
    host.refresh_session_file(&app, handle).await;
    Ok(())
}

#[tauri::command]
pub async fn session_close(host: State<'_, Arc<Host>>, handle: u64) -> Res<()> {
    host.close(handle).await;
    Ok(())
}

#[tauri::command]
pub async fn session_delete(file: String) -> Res<()> {
    let agent = omp::get().await?.info.agent_dir.clone();
    tokio::task::spawn_blocking(move || sessions::delete(&agent, &file)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plan_read(file: String, slug: String) -> Res<String> {
    let agent = omp::get().await?.info.agent_dir.clone();
    tokio::task::spawn_blocking(move || sessions::read_plan(&agent, &file, &slug)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn scope_set(app: AppHandle, run_key: String, scope: Scope, planning: bool) -> Res<()> {
    overlays::write_atomic(&overlays::run_path(&app_data(&app)?, &run_key)?, &overlays::run_body(scope, planning))
}

#[tauri::command]
pub fn workspace_rules_set(app: AppHandle, workspace_id: String, rules: BTreeMap<String, Policy>) -> Res<()> {
    let path = overlays::workspace_path(&app_data(&app)?, &workspace_id)?;
    overlays::write_atomic(&path, &overlays::workspace_body(&rules))
}

/// Write a reviewed plan to a path the user picked in the native save dialog.
#[tauri::command]
pub async fn plan_save(path: String, content: String) -> Res<()> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || p.extension().is_none_or(|e| e != "md") {
        return Err(format!("{path} is not an absolute .md path"));
    }
    tokio::fs::write(&p, content).await.map_err(|e| format!("{path}: {e}"))
}
