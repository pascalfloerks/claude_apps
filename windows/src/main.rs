// Pedal Point for Windows: a native window around the web app in ../pedal-point.
// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_dialog::DialogExt;

/// Ask where to save a session file, then write it. Returns the chosen path,
/// or None when the person cancels the dialog.
#[tauri::command]
async fn save_session_file(
    app: tauri::AppHandle,
    file_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Save session")
        .set_file_name(&file_name)
        .add_filter("Pedal Point session", &["json"])
        .blocking_save_file();
    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_session_file])
        .run(tauri::generate_context!())
        .expect("error while running Pedal Point");
}
