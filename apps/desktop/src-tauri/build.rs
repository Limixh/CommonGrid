fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "local_operation_status",
            "local_cli_check_start",
            "local_cli_check_status",
            "local_cli_check_cancel",
        ]),
    ))
    .expect("CommonGrid desktop build failed");
}
