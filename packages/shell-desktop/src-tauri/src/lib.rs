use std::sync::Mutex;

pub struct TokenState(pub Mutex<Option<String>>);

#[tauri::command]
fn get_token(state: tauri::State<TokenState>) -> Result<Option<String>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
fn set_token(state: tauri::State<TokenState>, token: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(token);
    Ok(())
}

#[tauri::command]
fn clear_token(state: tauri::State<TokenState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
fn get_host_hint() -> String {
    "http://127.0.0.1:7817".to_string()
}

#[tauri::command]
fn launch_service(file: String, args: Vec<String>, cwd: String) -> Result<u32, String> {
    let mut command = std::process::Command::new(&file);
    command.args(&args);
    command.current_dir(&cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| e.to_string())?;
    Ok(child.id())
}

#[tauri::command]
fn navigate_deeplink(window: tauri::WebviewWindow, link: String) -> Result<(), String> {
    let script = format!(
        "window.location.hash = {};",
        serde_json::to_string(&link).unwrap_or_default()
    );
    window.eval(&script).map_err(|e| e.to_string())
}

pub fn start_desktop() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(TokenState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_token,
            set_token,
            clear_token,
            get_host_hint,
            launch_service,
            navigate_deeplink
        ])
        .run(tauri::generate_context!())
        .expect("desktop shell container error");
}
