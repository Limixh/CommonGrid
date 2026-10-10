#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod operation_journal;
mod operation_status;
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            operation_status::local_operation_status
        ])
        .run(tauri::generate_context!())
        .expect("CommonGrid desktop could not start");
}
