mod commands;
mod frame;
mod host;
mod omp;
mod overlays;
mod sessions;
#[cfg(desktop)]
mod window_effects;

use host::Host;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let host = Arc::new(Host::default());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![
            commands::omp_info,
            commands::session_list,
            commands::session_open,
            commands::session_attach,
            commands::session_detach,
            commands::session_status,
            commands::session_send,
            commands::session_request,
            commands::session_refresh_file,
            commands::session_close,
            commands::session_delete,
            commands::plan_read,
            commands::plan_save,
            commands::scope_set,
            commands::workspace_rules_set,
        ]);

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_decorum::init()); // decorum (1/2)

    let app = builder
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            if let Ok(data) = app.path().app_data_dir() {
                overlays::sweep_stale_runs(&data);
            }
            // Resolve omp and the login-shell environment once, off the UI thread.
            tauri::async_runtime::spawn(async {
                if let Err(e) = omp::get().await {
                    log::error!("omp discovery failed: {e}");
                }
            });
            let reaper_host = host.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                loop {
                    tick.tick().await;
                    reaper_host.reap_idle(&handle).await;
                }
            });

            // Desktop window effects: comment out a line to disable it.
            #[cfg(desktop)]
            {
                let main = app.get_webview_window("main").expect("main window");
                window_effects::decorum(&main)?; // decorum (2/2)
                // window_effects::vibrancy(&main)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Close every omp stdin so sessions shut down cleanly before the app exits.
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let host = handle.state::<Arc<Host>>().inner().clone();
            tauri::async_runtime::block_on(host.close_all());
        }
    });
}
