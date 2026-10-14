# ompi

A desktop app for [omp](https://omp.sh), built with Nuxt 4, Nuxt UI 4 and Tauri 2. It runs your installed `omp` (18.8.9 or later), so it uses your existing logins, config, MCP servers and sessions. Sessions you start here show up in the omp TUI and vice versa.

See [PLAN.md](PLAN.md) for the design, the protocol findings behind it, and the phases still to come.

## Requirements

- omp 18.8.9 or later on your login shell's `PATH` (or set `OMPI_OMP_PATH`).
- Bun, and Rust 1.82 or later via rustup.

## Develop

```bash
bun i
bun run tauri:dev
```

If `tauri dev` fails with a Cargo `edition2024` error, an old `cargo` (for example `/usr/local/bin/cargo`) is ahead of rustup's on `PATH`. Run `PATH="$HOME/.cargo/bin:$PATH" bun run tauri:dev`.

## Test

```bash
bun test app/utils/omp          # transcript, frame parsing, branching
(cd src-tauri && cargo test)    # chunk reassembly, session index, overlays, version gate
```

## How it works

- **One omp process per open session tab**, run as `omp --mode rpc-ui` and owned by Rust (`src-tauri/src/host.rs`). Processes survive webview reloads; unanswered approvals are replayed when the tab reattaches. Idle background sessions are stopped after 10 minutes and resume on demand.
- **Access scopes** (Always ask / Write / Full access) are omp `--config` overlay files ompi writes; omp picks up changes live. "Always allow `<tool>` here" writes a per-workspace overlay.
- **The bridge** (`src-tauri/resources/ompi-bridge.ts`) is a small omp extension loaded into each process. It adds what omp's RPC protocol lacks: plan mode, branching inside a session file, assistant-message edits, labels and a context breakdown. It uses omp internals, so `hello` reports which features the installed omp supports and the UI hides the rest.
- **Rendering**: model output is untrusted. Markdown is rendered without raw HTML, and the webview has a CSP and only the Tauri permissions the app uses (no filesystem access; Rust does all file I/O).

## Desktop Window Effects

Two desktop-only effects are enabled by default:

- [tauri-plugin-decorum](https://github.com/clearlysid/tauri-plugin-decorum): overlay titlebar and inset macOS traffic lights
- [window-vibrancy](https://github.com/tauri-apps/window-vibrancy): native blur behind the window (macOS, Windows; no-op on Linux)

Neither requires `macOSPrivateApi`. They are excluded from iOS/Android builds by a desktop-only target in `src-tauri/Cargo.toml` and `#[cfg(desktop)]` in `src-tauri/src/lib.rs`, so mobile builds need no changes.

To disable an effect, comment out its lines in `src-tauri/src/lib.rs`. Uncomment them to re-enable.

| Effect   | Lines                                                                                                                           |
|----------|---------------------------------------------------------------------------------------------------------------------------------|
| Vibrancy | `window_effects::vibrancy(&main)?;`                                                                                             |
| Decorum  | `#[cfg(desktop)] let builder = builder.plugin(tauri_plugin_decorum::init()); // decorum (1/2)` and `window_effects::decorum(&main)?; // decorum (2/2)` |

Effect options (vibrancy material, Windows blur color, traffic light inset) live in `src-tauri/src/window_effects.rs`.

Notes:

- Vibrancy only shows through transparent page areas. Nuxt UI paints an opaque `body` background (`bg-default`), so set `html, body { background: transparent; }` where you want the blur visible.
- On macOS, vibrancy uses decorum's `make_transparent()` helper, so the `tauri-plugin-decorum` crate must stay in `Cargo.toml` even when the decorum plugin lines are commented out.
- To remove a crate entirely, also delete it from `src-tauri/Cargo.toml` and its function from `window_effects.rs`. Removing decorum also means removing `src-tauri/capabilities/desktop.json`, which grants `decorum:allow-show-snap-overlay`.
