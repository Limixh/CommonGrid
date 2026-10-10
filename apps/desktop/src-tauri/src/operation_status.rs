use crate::operation_journal::{read_operation_status, RecoveryStatus};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, Runtime, Webview,
};

struct ReaderSlots {
    outstanding: AtomicUsize,
    gate: Mutex<()>,
}
impl ReaderSlots {
    const fn new() -> Self {
        Self {
            outstanding: AtomicUsize::new(0),
            gate: Mutex::new(()),
        }
    }
    fn acquire(&self) -> Option<ReaderGuard<'_>> {
        let mut count = self.outstanding.load(Ordering::Acquire);
        loop {
            if count >= 2 {
                return None;
            }
            match self.outstanding.compare_exchange_weak(
                count,
                count + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(ReaderGuard(self)),
                Err(observed) => count = observed,
            }
        }
    }
}
static READER: ReaderSlots = ReaderSlots::new();
struct ReaderGuard<'a>(&'a ReaderSlots);
impl Drop for ReaderGuard<'_> {
    fn drop(&mut self) {
        self.0.outstanding.fetch_sub(1, Ordering::AcqRel);
    }
}

/// AppManifest + the local main-webview capability enforce the invoking origin.
/// The caller cannot choose a path, provider, operation, or reader limits.
#[tauri::command]
pub(crate) async fn local_operation_status<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
) -> Result<RecoveryStatus, &'static str> {
    if webview.label() != "main"
        || webview.window().label() != "main"
        || !matches!(request.body(), InvokeBody::Json(value) if value.as_object().is_some_and(|object| object.is_empty()))
    {
        return Err("local_operation_status_denied");
    }
    let Some(guard) = READER.acquire() else {
        return Ok(RecoveryStatus::io_failed());
    };
    let Ok(directory) = app.path().app_local_data_dir() else {
        return Ok(RecoveryStatus::io_failed());
    };
    let root = directory.join("managed-operation-journal");
    // The guard belongs to the job: canceling the request cannot queue more work
    // while the existing blocking filesystem read is still running.
    // One reader plus one waiting request also accommodates React StrictMode's
    // repeated initial effect; excess requests cannot grow the blocking pool.
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let Ok(_reader) = READER.gate.lock() else {
            return RecoveryStatus::io_failed();
        };
        read_operation_status(root)
    })
    .await
    .unwrap_or_else(|_| RecoveryStatus::io_failed()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeResponseBody},
        test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
        webview::InvokeRequest,
        WebviewWindow, WebviewWindowBuilder,
    };

    fn request(url: &str, body: InvokeBody, command: &str) -> InvokeRequest {
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body,
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        }
    }
    fn invoke(
        window: &WebviewWindow<MockRuntime>,
        url: &str,
        body: InvokeBody,
        command: &str,
    ) -> Result<InvokeResponseBody, Value> {
        get_ipc_response(window, request(url, body, command))
    }

    #[test]
    fn reader_jobs_are_exclusive_and_release_the_guard() {
        let slots = ReaderSlots::new();
        let first = slots.acquire().unwrap();
        let queued = slots.acquire().unwrap();
        assert!(slots.acquire().is_none());
        let reading = slots.gate.lock().unwrap();
        assert!(slots.gate.try_lock().is_err());
        drop(reading);
        assert!(slots.gate.try_lock().is_ok());
        drop(first);
        drop(queued);
        assert_eq!(slots.outstanding.load(Ordering::Acquire), 0);
        assert!(slots.acquire().is_some());
    }

    #[test]
    fn actual_app_acl_limits_the_read_only_command() {
        struct SyntheticStore(std::path::PathBuf);
        impl Drop for SyntheticStore {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).unwrap();
            }
        }
        let store = SyntheticStore(std::fs::canonicalize(std::env::temp_dir()).unwrap().join(
            format!(
                "commongrid-native-ipc-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ),
        ));
        std::fs::create_dir(&store.0).unwrap();
        let manifest: Value = serde_json::from_str(include_str!(
            "../../../../packages/agent-adapters/test/fixtures/operation-journal-contract.json"
        ))
        .unwrap();
        let case = manifest["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["expected"]["status"] == "available")
            .unwrap();
        for (relative, contents) in case["files"].as_object().unwrap() {
            let relative = std::path::Path::new(relative);
            assert!(relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_))));
            let path = store.0.join("managed-operation-journal").join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents.as_str().unwrap()).unwrap();
        }
        // Use generated application ACL, not mock_context (which has no ACL).
        // Only this test context overrides app directories; production keeps the
        // real app-owned location and accepts no override through IPC or env.
        let mut context = tauri::generate_context!();
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(store.0.clone()),
        );
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![local_operation_status])
            .build(context)
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .unwrap();
        let local = if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        let empty = || InvokeBody::Json(json!({}));
        let response = invoke(&main, local, empty(), "local_operation_status")
            .unwrap()
            .deserialize::<Value>()
            .unwrap();
        assert_eq!(response, case["expected"]);
        assert_eq!(response["execution_enabled"], false);
        assert_eq!(response["automatic_recovery"], false);
        assert_eq!(response["worker_quiescence"], "unknown");
        assert_eq!(response["daemon_state"], "unknown");
        assert!(
            response
                .get("operations")
                .unwrap()
                .as_array()
                .unwrap()
                .len()
                <= 1024
        );
        assert!(response.get("root").is_none());
        assert!(invoke(&other, local, empty(), "local_operation_status").is_err());
        for url in [
            "https://example.invalid",
            "http://localhost:1420",
            "http://127.0.0.1:1421",
            "https://tauri.localhost.example.invalid",
        ] {
            assert!(
                invoke(&main, url, empty(), "local_operation_status").is_err(),
                "remote origin accepted: {url}"
            );
        }
        for body in [
            InvokeBody::Json(json!({"root":"ignored-hostile-path"})),
            InvokeBody::Json(json!({"maxOperations":1})),
            InvokeBody::Json(json!(null)),
            InvokeBody::Raw(vec![]),
        ] {
            assert_eq!(
                invoke(&main, local, body, "local_operation_status").unwrap_err(),
                json!("local_operation_status_denied")
            );
        }
        for command in [
            "write_operation_journal",
            "recover_operation",
            "local_operation_cleanup",
        ] {
            assert!(invoke(&main, local, empty(), command).is_err());
        }
    }
}
