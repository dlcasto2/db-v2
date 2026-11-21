// Devon Browser desktop shell.
//
// This crate builds two different apps, chosen by the `static-build` Cargo
// feature (off by default) and paired with a matching Tauri config:
//
// - Default (`pnpm build`, tauri.conf.json): no real frontend of its own —
//   `frontend-dist/index.html` is just a "Starting Devon…" splash. On startup
//   we spawn Devon's actual Next.js app (built with `output: "standalone"`,
//   see ../scripts/prepare-standalone.mjs) as a bundled Node sidecar, wait for
//   it to start answering on localhost, then navigate the window to it. The
//   sidecar is killed when the app exits. Has Devon's full feature set
//   (proxy, YouTube downloads, Devon AI, etc.) since it's a real server.
//
// - Static (`pnpm build:static`, tauri.static.conf.json): no sidecar, no
//   server, nothing to spawn or poll. tauri.static.conf.json points
//   frontendDist straight at Devon's static export (`output: "export"`, see
//   ../scripts/prepare-static.mjs), so Tauri just loads it directly — the
//   window shows the real thing from the moment it opens. Everything that
//   needs a server (the proxy, YouTube downloads, page-safety checks, Devon
//   AI chat, sign-in) doesn't work in this build; see desktop/README.md.
//
// Everything below down to the non-static `run()` is only compiled for the
// default build — none of it is needed once there's no sidecar to manage.
#[cfg(not(feature = "static-build"))]
use std::{
    collections::HashMap,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[cfg(not(feature = "static-build"))]
use tauri::{Manager, RunEvent, WebviewWindow};
#[cfg(not(feature = "static-build"))]
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Holds the running sidecar's handle so we can kill it when the app exits.
#[cfg(not(feature = "static-build"))]
struct SidecarState(Mutex<Option<CommandChild>>);

/// Where we look for the standalone Next.js build (`server.js` + its
/// `node_modules`), in order. `tauri build` copies `resources/app` (see
/// `tauri.conf.json` -> bundle.resources) next to the installed .exe, but the
/// exact resource layout has shifted across Tauri versions, and `cargo tauri
/// dev` does not materialize bundle.resources at all — it only exists once
/// prepare-standalone.mjs has run against *this* checkout. So: try the
/// packaged locations first, then fall back to the dev checkout.
#[cfg(not(feature = "static-build"))]
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

#[cfg(not(feature = "static-build"))]
fn find_app_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    candidate_app_dirs(app)
        .into_iter()
        .find(|dir| dir.join("server.js").is_file())
}

/// Binds to a loopback port chosen by the OS, then immediately drops the
/// listener so the sidecar can bind it instead. Small race in theory; fine
/// for a single-user desktop app.
#[cfg(not(feature = "static-build"))]
fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.local_addr().map(|addr| addr.port())
}

#[cfg(not(feature = "static-build"))]
fn port_is_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Reads `KEY=VALUE` lines (one per line, `#` comments and blank lines
/// ignored) from a user-editable env file, if present. This is how someone
/// building their own copy of this app can turn on Devon AI, Auth0 sign-in,
/// etc. without rebuilding — see desktop/README.md.
#[cfg(not(feature = "static-build"))]
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

#[cfg(not(feature = "static-build"))]
fn user_env_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("devon.env"))
}

/// Replaces the splash page's status text — shown instead of leaving
/// "Starting Devon…" up forever if the server never comes up. `eval` runs on
/// whatever page is currently loaded, which is still the splash page at every
/// point this is called from (we only call `navigate` once we know better).
#[cfg(not(feature = "static-build"))]
fn show_status(window: &WebviewWindow, message: &str) {
    let payload = serde_json::to_string(message).unwrap_or_else(|_| "\"(error)\"".into());
    let js = format!("var s = document.getElementById('status'); if (s) s.textContent = {payload};");
    if let Err(e) = window.eval(js) {
        log::error!("Failed to update the splash page: {e}");
    }
}

/// `devon-desktop.log` under app_log_dir() — included in on-screen error
/// messages so a stuck launch points at something to go look at or send.
#[cfg(not(feature = "static-build"))]
fn log_file_hint(app: &tauri::AppHandle) -> String {
    app.path()
        .app_log_dir()
        .ok()
        .map(|dir| format!("\n\nDetails were written to:\n{}", dir.join("devon-desktop.log").display()))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(not(feature = "static-build"))]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Always on — not just in `tauri dev`. A shipped build has no
        // attached console, so this file is the only way to find out what
        // went wrong when the server doesn't come up (see show_status /
        // log_file_hint below). Written to app_log_dir() (on Windows:
        // %LOCALAPPDATA%\<identifier>\logs\devon-desktop.log).
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("devon-desktop".into()),
                    },
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let window = app_handle
                .get_webview_window("main")
                .expect("main window declared in tauri.conf.json");

            // From here on we report problems onto the splash page itself
            // instead of just returning Err from setup(): a setup error has
            // nowhere visible to go in a windowed, console-less release
            // build, so the app would just vanish with no explanation.
            let Some(app_dir) = find_app_dir(&app_handle) else {
                let msg = "Could not find Devon's own files next to the app \
                           (server.js is missing). This build is broken — please report it.";
                log::error!("{msg}");
                show_status(&window, msg);
                return Ok(());
            };

            let port = match pick_free_port() {
                Ok(p) => p,
                Err(e) => {
                    let msg = format!("Couldn't find a free local port to use: {e}");
                    log::error!("{msg}");
                    show_status(&window, &format!("{msg}{}", log_file_hint(&app_handle)));
                    return Ok(());
                }
            };
            log::info!("Starting Devon on 127.0.0.1:{port} from {app_dir:?}");

            let mut user_env = HashMap::new();
            if let Some(env_path) = user_env_path(&app_handle) {
                user_env = read_user_env_file(&env_path);
                if !user_env.is_empty() {
                    log::info!("Loaded {} var(s) from {env_path:?}", user_env.len());
                }
            }

            let sidecar_cmd = match app_handle.shell().sidecar("node") {
                Ok(cmd) => cmd,
                Err(e) => {
                    let msg = format!("Couldn't locate the bundled node sidecar: {e}");
                    log::error!("{msg}");
                    show_status(&window, &format!("{msg}{}", log_file_hint(&app_handle)));
                    return Ok(());
                }
            };

            let spawned = sidecar_cmd
                .current_dir(app_dir.clone())
                .args(["server.js"])
                .env("PORT", port.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .env("NODE_ENV", "production")
                .envs(user_env)
                .spawn();

            let (mut rx, child) = match spawned {
                Ok(pair) => pair,
                Err(e) => {
                    let msg = format!("Couldn't start Devon's server (node sidecar failed to launch): {e}");
                    log::error!("{msg}");
                    show_status(&window, &format!("{msg}{}", log_file_hint(&app_handle)));
                    return Ok(());
                }
            };

            app_handle.state::<SidecarState>().0.lock().unwrap().replace(child);

            // Surface the Node server's own stdout/stderr in our log output
            // (the only way to see what went wrong if it exits early) and,
            // via `early_exit`, let the polling loop below notice a crash
            // immediately instead of silently waiting out the full timeout.
            // Each event is already one line (CommandEvent::Stdout/Stderr
            // split on newlines themselves unless raw output is requested).
            let early_exit: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let early_exit_for_task = early_exit.clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            log::info!("[devon-server] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Error(err) => {
                            log::error!("[devon-server] error: {err}");
                            early_exit_for_task
                                .lock()
                                .unwrap()
                                .get_or_insert_with(|| format!("Devon's server reported an error: {err}"));
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!("[devon-server] exited: {payload:?}");
                            early_exit_for_task.lock().unwrap().get_or_insert_with(|| {
                                format!(
                                    "Devon's server exited unexpectedly before it finished starting ({payload:?})."
                                )
                            });
                        }
                        _ => {}
                    }
                }
            });

            // Poll the port on a plain OS thread (simplest way to block
            // without pulling in more async machinery) and navigate the
            // splash window to Devon once it answers — or show whatever
            // went wrong instead of leaving the splash page up forever.
            let window_for_thread = window.clone();
            let hint = log_file_hint(&app_handle);
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    if port_is_open(port) {
                        let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
                        if let Err(e) = window_for_thread.navigate(url) {
                            let msg = format!("Devon's server started, but the window failed to load it: {e}");
                            log::error!("{msg}");
                            show_status(&window_for_thread, &format!("{msg}{hint}"));
                        }
                        return;
                    }
                    if let Some(reason) = early_exit.lock().unwrap().clone() {
                        log::error!("{reason}");
                        show_status(&window_for_thread, &format!("{reason}{hint}"));
                        return;
                    }
                    if Instant::now() >= deadline {
                        let msg = format!("Devon's server didn't start within 30 seconds.{hint}");
                        log::error!("{msg}");
                        show_status(&window_for_thread, &msg);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
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

/// Static build: no sidecar, no port, no splash page. tauri.static.conf.json
/// points `build.frontendDist` straight at Devon's static export (built by
/// ../scripts/prepare-static.mjs) and the window's `url` at its "index.html",
/// so Tauri loads the real thing directly — there's nothing left for setup()
/// to do here. Logging stays on (same as the default build) since it's cheap
/// and still useful for diagnosing anything that goes wrong at the Tauri
/// level itself (window/webview failures, for instance).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(feature = "static-build")]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("devon-desktop".into()),
                    },
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
