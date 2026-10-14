fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "local_operation_status",
            "local_cli_check_start",
            "local_cli_check_status",
            "local_cli_check_cancel",
            "local_managed_profiles_status",
            "local_managed_profile_create",
            "local_managed_profile_select",
            "local_profile_session_start",
            "local_profile_session_status",
            "local_profile_session_cancel",
            "local_profile_session_open_device",
            "local_profile_session_submit_code",
            "local_profile_session_open_claude",
            "local_task_run_start",
            "local_task_run_status",
            "local_task_run_cancel",
            "local_task_run_result_package",
            "local_run_limits_status",
            "local_run_limits_save",
        ]),
    ))
    .expect("CommonGrid desktop build failed");
}
