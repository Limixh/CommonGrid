#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod operation_journal;
mod operation_status;

// Expand once: macOS's embedded Info.plist symbol must be unique even when the
// test binary uses the generated ACL with both Wry and the mock runtime.
fn application_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            operation_status::local_operation_status
        ])
        .run(application_context())
        .expect("CommonGrid desktop could not start");
}
