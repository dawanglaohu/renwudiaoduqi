use std::sync::Mutex;
use tauri::Manager;

const SERVICE_NAME: &str = "com.agsched.desktop";
const TOKEN_USER: &str = "token";

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

#[tauri::command]
fn get_token() -> Result<Option<String>, String> {
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

#[tauri::command]
fn get_host_hint() -> Option<String> {
    None
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| e.to_string())?;
    Ok(child.id())
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
        .setup(|app| {
            let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
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
            launch_service
        ])
        .run(tauri::generate_context!())
        .expect("desktop shell container error");
}
