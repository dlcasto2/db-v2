// Devon Browser desktop shell.
//
// This app has no real frontend of its own: `frontend-dist/index.html` is just
// a "Starting Devon…" splash. On startup we spawn Devon's actual Next.js app
// (built with `output: "standalone"`, see ../scripts/prepare-standalone.mjs)
// as a bundled Node sidecar, wait for it to start answering on localhost, then
// navigate the window to it. The sidecar is killed when the app exits.

use std::{
    collections::HashMap,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Holds the running sidecar's handle so we can kill it when the app exits.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Where we look for the standalone Next.js build (`server.js` + its
/// `node_modules`), in order. `tauri build` copies `resources/app` (see
/// `tauri.conf.json` -> bundle.resources) next to the installed .exe, but the
/// exact resource layout has shifted across Tauri versions, and `cargo tauri
/// dev` does not materialize bundle.resources at all — it only exists once
/// prepare-standalone.mjs has run against *this* checkout. So: try the
/// packaged locations first, then fall back to the dev checkout.
fn candidate_app_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("app"));
        dirs.push(resource_dir.join("resources").join("app"));
        dirs.push(resource_dir.clone());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.join("resources").join("app"));
            dirs.push(exe_dir.join("app"));
        }
    }

    // `cargo tauri dev` / running `cargo run` straight from src-tauri: the
    // repo-root-relative copy prepare-standalone.mjs writes to.
    dirs.push(PathBuf::from("../src-tauri/resources/app"));
    dirs.push(PathBuf::from("resources/app"));

    dirs
}

fn find_app_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    candidate_app_dirs(app)
        .into_iter()
        .find(|dir| dir.join("server.js").is_file())
}

/// Binds to a loopback port chosen by the OS, then immediately drops the
/// listener so the sidecar can bind it instead. Small race in theory; fine
/// for a single-user desktop app.
fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.local_addr().map(|addr| addr.port())
}

fn port_is_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Reads `KEY=VALUE` lines (one per line, `#` comments and blank lines
/// ignored) from a user-editable env file, if present. This is how someone
/// building their own copy of this app can turn on Devon AI, Auth0 sign-in,
/// etc. without rebuilding — see desktop/README.md.
fn read_user_env_file(path: &Path) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    let Ok(contents) = std::fs::read_to_string(path) else {
        return vars;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            vars.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    vars
}

fn user_env_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("devon.env"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_handle = app.handle().clone();

            let app_dir = find_app_dir(&app_handle).ok_or(
                "Could not find Devon's standalone build (server.js) next to the app. \
                 Run `node scripts/prepare-standalone.mjs` before `tauri build`/`tauri dev` \
                 — see desktop/README.md.",
            )?;

            let port = pick_free_port()?;
            log::info!("Starting Devon on 127.0.0.1:{port} from {app_dir:?}");

            let mut user_env = HashMap::new();
            if let Some(env_path) = user_env_path(&app_handle) {
                user_env = read_user_env_file(&env_path);
                if !user_env.is_empty() {
                    log::info!("Loaded {} var(s) from {env_path:?}", user_env.len());
                }
            }

            let (mut rx, child) = app_handle
                .shell()
                .sidecar("node")?
                .current_dir(app_dir.clone())
                .args(["server.js"])
                .env("PORT", port.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .env("NODE_ENV", "production")
                .envs(user_env)
                .spawn()?;

            app_handle.state::<SidecarState>().0.lock().unwrap().replace(child);

            // Surface the Node server's own stdout/stderr in our log output,
            // which is the only way to see what went wrong if it exits early.
            // Each event is already one line (CommandEvent::Stdout/Stderr
            // split on newlines themselves unless raw output is requested).
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            log::info!("[devon-server] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Error(err) => log::error!("[devon-server] error: {err}"),
                        CommandEvent::Terminated(payload) => {
                            log::warn!("[devon-server] exited: {payload:?}");
                        }
                        _ => {}
                    }
                }
            });

            // Poll the port on a plain OS thread (simplest way to block
            // without pulling in more async machinery) and navigate the
            // splash window to Devon once it answers.
            let window = app_handle
                .get_webview_window("main")
                .expect("main window declared in tauri.conf.json");
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(30);
                while Instant::now() < deadline {
                    if port_is_open(port) {
                        let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
                        if let Err(e) = window.navigate(url) {
                            log::error!("Failed to navigate to Devon: {e}");
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                log::error!("Devon's server never came up on port {port} within 30s");
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(child) = app_handle.state::<SidecarState>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
