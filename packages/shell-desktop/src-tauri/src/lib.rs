use std::sync::Mutex;
use tauri::Manager;

const SERVICE_NAME: &str = "com.agsched.desktop";
const TOKEN_USER: &str = "token";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct DaemonLaunchSpec {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
}

pub struct LaunchState(pub Mutex<Option<DaemonLaunchSpec>>);

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
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let binary_name = if cfg!(windows) { "daemon.exe" } else { "daemon" };
            let daemon_file = resource_dir.join(binary_name);
            let spec = DaemonLaunchSpec {
                file: daemon_file.to_string_lossy().into_owned(),
                args: Vec::new(),
                cwd: resource_dir.to_string_lossy().into_owned(),
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
