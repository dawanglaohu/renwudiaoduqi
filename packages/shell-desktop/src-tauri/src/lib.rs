use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const SERVICE_NAME: &str = "com.agsched.desktop";
const TOKEN_USER: &str = "token";

/// Port the shipped daemon listens on when the process environment says nothing else.
/// `packages/daemon/src/config/env.ts` fixes the same default for `AGSCHED_PORT`; the two
/// must agree or the hint points at nothing (E-224).
const DEFAULT_DAEMON_PORT: u16 = 7817;
const PORT_ENV: &str = "AGSCHED_PORT";

/// Shell smoke mode (M10-T6, E-257, E-265): the CI starts the real shell executable with
/// `AGSCHED_SMOKE=1` and lets it assert, against the real shipped daemon, that the shared
/// web bundle rendered and connected. Nothing else in the product reads these variables.
const SMOKE_ENV: &str = "AGSCHED_SMOKE";
/// Real device token the smoke obtained from `POST /api/v1/pair/claim`. Without one the
/// client never opens its stream, so `data-connection-status` could never reach "online".
const SMOKE_TOKEN_ENV: &str = "AGSCHED_SMOKE_TOKEN";
/// Opt-in audit path for a native launch recording. The file records each IPC call and pid;
/// the adjacent daemon log captures the child process output.
const LAUNCH_AUDIT_ENV: &str = "AGSCHED_LAUNCH_AUDIT_FILE";
/// Every poll the shell injects one script that reports the two dataset values back.
const SMOKE_POLL_INTERVAL_MS: u64 = 500;
/// CI ceiling: the smoke fails instead of hanging when the page never gets there.
const SMOKE_TIMEOUT_MS: u64 = 20_000;
/// Reads `data-style-loaded` / `data-connection-status` the web bundle writes on <html>.
const SMOKE_PROBE_JS: &str = "(function(){var e=document.documentElement;var d=(e&&e.dataset)||{};window.__TAURI_INTERNALS__.invoke('report_smoke_probe',{styleLoaded:String(d.styleLoaded||''),connectionStatus:String(d.connectionStatus||'')});})();";

/// Mirrors `resolveShippedDaemonLayout` in `packages/shell-desktop/src/launch-spec.ts`:
/// the daemon application ships under `<resource_dir>/daemon-runtime` together with the
/// Node runtime it needs, so the shell starts
/// `<resource_dir>/daemon-runtime/runtime/node[.exe] <resource_dir>/daemon-runtime/bootstrap.mjs`.
const DAEMON_RUNTIME_DIR_NAME: &str = "daemon-runtime";
const BUNDLED_RUNTIME_DIR_NAME: &str = "runtime";
const DAEMON_ENTRY_FILE_NAME: &str = "bootstrap.mjs";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct DaemonLaunchSpec {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
}

pub struct LaunchState(pub Mutex<Option<DaemonLaunchSpec>>);

/// Mirrors `isAbsoluteLaunchPath` in
/// `packages/shared/src/shell/daemon-launch-spec.ts`: POSIX root, drive letter, or UNC.
fn is_absolute_launch_path(value: &str) -> bool {
    if value.is_empty() || value.contains('\0') {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes[0] == b'/' {
        return true;
    }
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    bytes.len() >= 2
        && ((bytes[0] == b'\\' && bytes[1] == b'\\') || (bytes[0] == b'/' && bytes[1] == b'/'))
}

fn bundled_runtime_executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// True only when this process was started by the shell smoke (`AGSCHED_SMOKE=1`).
fn smoke_enabled() -> bool {
    std::env::var(SMOKE_ENV)
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// Resolves the port the local daemon listens on: `AGSCHED_PORT` of this process, or the
/// same default `packages/daemon/src/config/env.ts` applies. A value that is not a TCP
/// port number is reported on stderr and falls back, because a hint is a convenience and
/// must never be the reason the shell refuses to start.
fn resolve_daemon_port() -> u16 {
    match std::env::var(PORT_ENV) {
        Ok(raw) => {
            let trimmed = raw.trim();
            match trimmed.parse::<u16>() {
                Ok(port) if port > 0 => port,
                _ => {
                    eprintln!(
                        "{} is not a TCP port number (got \"{}\"); using {}.",
                        PORT_ENV, trimmed, DEFAULT_DAEMON_PORT
                    );
                    DEFAULT_DAEMON_PORT
                }
            }
        }
        Err(_) => DEFAULT_DAEMON_PORT,
    }
}

#[tauri::command]
fn get_token() -> Result<Option<String>, String> {
    // Smoke runs headless on CI machines where the OS credential store is unreachable, and
    // it is handed a genuine device token by the harness instead.
    if smoke_enabled() {
        return match std::env::var(SMOKE_TOKEN_ENV) {
            Ok(token) if !token.trim().is_empty() => Ok(Some(token.trim().to_string())),
            _ => Ok(None),
        };
    }
    let entry = keyring::Entry::new(SERVICE_NAME, TOKEN_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, TOKEN_USER).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_token() -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, TOKEN_USER).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Last pair of values the smoke probe read out of the web page.
#[derive(Clone, Default)]
pub struct SmokeProbeSample {
    pub style_loaded: String,
    pub connection_status: String,
}

pub struct SmokeProbeState(pub Mutex<SmokeProbeSample>);

/// Collects one probe sample from the injected script (M10-T6 AC 3, E-257, E-265).
///
/// `WebviewWindow::eval` runs JavaScript in the page but hands nothing back to Rust, so the
/// script reports through the same IPC every other bridge call uses. Outside smoke mode the
/// command is a no-op: production pages have no reason to call it and nothing depends on it.
#[tauri::command]
fn report_smoke_probe(
    state: tauri::State<'_, SmokeProbeState>,
    style_loaded: String,
    connection_status: String,
) {
    if !smoke_enabled() {
        return;
    }
    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    guard.style_loaded = style_loaded;
    guard.connection_status = connection_status;
    let satisfied = guard.style_loaded == "true" && guard.connection_status == "online";
    if satisfied {
        println!(
            "[smoke] styleLoaded=\"{}\" connectionStatus=\"{}\"",
            guard.style_loaded, guard.connection_status
        );
        std::process::exit(0);
    }
}

/// Where the client reaches the local daemon, as seen from inside the shell (E-224).
///
/// The shell's own `location.origin` is `tauri://localhost`, which no daemon ever listens
/// on; without this hint the runtime discovery chain falls through to that origin and the
/// first screen can never load.
#[tauri::command]
fn get_host_hint() -> String {
    format!("http://127.0.0.1:{}", resolve_daemon_port())
}

#[tauri::command]
fn get_launch_spec(state: tauri::State<LaunchState>) -> Result<Option<DaemonLaunchSpec>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
fn launch_service(state: tauri::State<LaunchState>) -> Result<u32, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let spec = guard
        .as_ref()
        .ok_or_else(|| "Daemon launch specification not initialized".to_string())?;

    let mut command = std::process::Command::new(&spec.file);
    command.args(&spec.args);
    command.current_dir(&spec.cwd);
    let mut audit_file = match std::env::var(LAUNCH_AUDIT_ENV) {
        Ok(path) if !path.trim().is_empty() => {
            let path = std::path::PathBuf::from(path);
            if !path.is_absolute() {
                return Err(format!("{} must be an absolute path", LAUNCH_AUDIT_ENV));
            }
            let mut audit = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("failed to open native launch audit: {}", e))?;
            writeln!(
                audit,
                "launch_service invoke shell_pid={}",
                std::process::id()
            )
            .map_err(|e| e.to_string())?;
            let daemon_log = path.with_extension("daemon.log");
            let stdout = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(daemon_log)
                .map_err(|e| format!("failed to open daemon startup log: {}", e))?;
            let stderr = stdout.try_clone().map_err(|e| e.to_string())?;
            command.stdout(stdout);
            command.stderr(stderr);
            Some(audit)
        }
        _ => None,
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| e.to_string())?;
    if let Some(audit) = audit_file.as_mut() {
        writeln!(audit, "launch_service returned pid={}", child.id()).map_err(|e| e.to_string())?;
    }
    Ok(child.id())
}

/// Polls the loaded page for the two values that prove the shared web bundle really
/// rendered and really connected, then ends the process with the smoke's verdict
/// (M10-T6 AC 3, E-257, E-265).
///
/// The shell deliberately reads DOM state the product already publishes for its own UI —
/// `data-style-loaded` (M9-T24) and `data-connection-status` (M9-T26) — instead of adding a
/// smoke-only global to the bundle. It asserts nothing about clicks, notifications or
/// windows: those stay on the manual checklist (E-266).
fn start_smoke_probe(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(SMOKE_TIMEOUT_MS);
        loop {
            std::thread::sleep(Duration::from_millis(SMOKE_POLL_INTERVAL_MS));
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.eval(SMOKE_PROBE_JS);
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        let state = handle.state::<SmokeProbeState>();
        let (style_loaded, connection_status) = match state.0.lock() {
            Ok(guard) => (guard.style_loaded.clone(), guard.connection_status.clone()),
            Err(_) => (String::new(), String::new()),
        };
        eprintln!(
            "[smoke] FAILED after {}ms: styleLoaded=\"{}\" connectionStatus=\"{}\"",
            SMOKE_TIMEOUT_MS, style_loaded, connection_status
        );
        std::process::exit(1);
    });
}

pub fn start_desktop() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchState(Mutex::new(None)))
        .manage(SmokeProbeState(Mutex::new(SmokeProbeSample::default())))
        .setup(|app| {
            if smoke_enabled() {
                start_smoke_probe(app.handle());
            }
            let mut resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
            if !resource_dir.join(DAEMON_RUNTIME_DIR_NAME).exists() {
                if resource_dir
                    .join("resources")
                    .join(DAEMON_RUNTIME_DIR_NAME)
                    .exists()
                {
                    resource_dir = resource_dir.join("resources");
                } else if let Some(parent) = resource_dir.parent() {
                    if parent
                        .join("resources")
                        .join(DAEMON_RUNTIME_DIR_NAME)
                        .exists()
                    {
                        resource_dir = parent.join("resources").to_path_buf();
                    }
                }
            }
            let resource_dir_text = resource_dir.to_string_lossy().into_owned();
            if !is_absolute_launch_path(&resource_dir_text) {
                return Err("Desktop resource directory must be an absolute path.".into());
            }
            let daemon_dir = resource_dir.join(DAEMON_RUNTIME_DIR_NAME);
            let runtime_file = daemon_dir
                .join(BUNDLED_RUNTIME_DIR_NAME)
                .join(bundled_runtime_executable_name());
            let daemon_entry = daemon_dir.join(DAEMON_ENTRY_FILE_NAME);
            let runtime_file_text = runtime_file.to_string_lossy().into_owned();
            let daemon_entry_text = daemon_entry.to_string_lossy().into_owned();
            if !is_absolute_launch_path(&runtime_file_text) {
                return Err("Daemon runtime executable path must be an absolute path.".into());
            }
            if !is_absolute_launch_path(&daemon_entry_text) {
                return Err("Daemon entry path must be an absolute path.".into());
            }
            let spec = DaemonLaunchSpec {
                file: runtime_file_text,
                args: vec![daemon_entry_text],
                cwd: resource_dir_text,
            };
            if let Some(state) = app.try_state::<LaunchState>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(spec);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_token,
            set_token,
            clear_token,
            get_host_hint,
            get_launch_spec,
            launch_service,
            report_smoke_probe
        ])
        .run(tauri::generate_context!())
        .expect("desktop shell container error");
}
