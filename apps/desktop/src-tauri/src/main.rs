#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod launcher;
mod launcher_process;
mod operation_journal;
mod operation_status;
mod profile_session;
mod profile_store;
mod task_run;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

// Expand once: macOS's embedded Info.plist symbol must be unique even when the
// test binary uses the generated ACL with both Wry and the mock runtime.
fn application_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

fn main() {
    let launcher = Arc::new(launcher::Launcher::default());
    let sessions = Arc::new(profile_session::ProfileSession::default());
    let runs = Arc::new(task_run::TaskRun::default());
    task_run::link(&runs, &sessions);
    let exiting = Arc::new(AtomicBool::new(false));
    let exit_ready = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .manage(launcher)
        .manage(sessions)
        .manage(runs)
        .invoke_handler(tauri::generate_handler![
            operation_status::local_operation_status,
            launcher::local_cli_check_start,
            launcher::local_cli_check_status,
            launcher::local_cli_check_cancel,
            profile_store::local_managed_profiles_status,
            profile_store::local_managed_profile_create,
            profile_store::local_managed_profile_select,
            profile_session::local_profile_session_start,
            profile_session::local_profile_session_status,
            profile_session::local_profile_session_cancel,
            profile_session::local_profile_session_open_device,
            task_run::local_task_run_start,
            task_run::local_task_run_status,
            task_run::local_task_run_cancel
        ])
        .build(application_context())
        .expect("CommonGrid desktop could not start")
        .run(move |app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if exit_ready.load(Ordering::Acquire) {
                    return;
                }
                let owner = Arc::clone(app.state::<Arc<launcher::Launcher>>().inner());
                let session_owner =
                    Arc::clone(app.state::<Arc<profile_session::ProfileSession>>().inner());
                let run_owner = Arc::clone(app.state::<Arc<task_run::TaskRun>>().inner());
                if exiting.load(Ordering::Acquire) {
                    if owner.active() || session_owner.active() || run_owner.active() {
                        api.prevent_exit();
                    }
                    return;
                }
                let stopping_launcher = owner.shutdown();
                let stopping_session = session_owner.shutdown();
                let stopping_run = run_owner.shutdown();
                if stopping_launcher || stopping_session || stopping_run {
                    api.prevent_exit();
                    exiting.store(true, Ordering::Release);
                    let app = app.clone();
                    let exit_ready = Arc::clone(&exit_ready);
                    std::thread::spawn(move || {
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(45);
                        while (owner.active() || session_owner.active() || run_owner.active())
                            && std::time::Instant::now() < deadline
                        {
                            std::thread::sleep(std::time::Duration::from_millis(25));
                        }
                        if owner.active() {
                            owner.force_review();
                        }
                        if session_owner.active() {
                            session_owner.force_review();
                        }
                        if run_owner.active() {
                            run_owner.force_review();
                        }
                        exit_ready.store(true, Ordering::Release);
                        app.exit(0);
                    });
                }
            }
        });
}
