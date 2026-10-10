use crate::launcher_process::{regular, safe_ancestors, OwnedWorker};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, Runtime, State, Webview,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Provider {
    Claude,
    Codex,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Starting,
    Preparing,
    Checking,
    Cleaning,
    Finished,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Passed,
    Cancelled,
    Failed,
    NeedsReview,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Cleanup {
    Pending,
    Verified,
    Unknown,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Operation {
    request_id: String,
    provider: Provider,
    revision: u32,
    phase: Phase,
    outcome: Option<Outcome>,
    cli_version: Option<String>,
    error_code: Option<String>,
    cleanup: Cleanup,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Status {
    schema_version: &'static str,
    availability: &'static str,
    operation: Option<Operation>,
}
struct Inner {
    status: Status,
    cancel: Option<mpsc::SyncSender<()>>,
    shutting_down: bool,
    requests: HashSet<String>,
}
pub(crate) struct Launcher {
    inner: Mutex<Inner>,
    start_jobs: AtomicUsize,
}
impl Default for Launcher {
    fn default() -> Self {
        Self {
            start_jobs: AtomicUsize::new(0),
            inner: Mutex::new(Inner {
                status: Status {
                    schema_version: "1.0",
                    availability: "available",
                    operation: None,
                },
                cancel: None,
                shutting_down: false,
                requests: HashSet::new(),
            }),
        }
    }
}
struct StartSlot(Arc<Launcher>);
impl Drop for StartSlot {
    fn drop(&mut self) {
        self.0.start_jobs.fetch_sub(1, Ordering::AcqRel);
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    schema_version: String,
    request_id: String,
    provider: Provider,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    schema_version: String,
    request_id: String,
    expected_revision: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wrapper<T> {
    request: T,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: String,
    node_sha256: String,
    worker_sha256: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Frame {
    #[serde(rename = "progress")]
    Progress { phase: Phase },
    #[serde(rename = "result")]
    Result {
        outcome: Outcome,
        #[serde(deserialize_with = "nullable")]
        cli_version: Option<String>,
        #[serde(deserialize_with = "nullable")]
        error_code: Option<String>,
        cleanup: Cleanup,
    },
}
fn nullable<'de, D: serde::Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(input)
}
fn uuid(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b[14] == b'4'
        && b"89ab".contains(&b[19])
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digest(path: &Path) -> Option<String> {
    if !regular(path) {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let maximum = if path.file_name() == Some(std::ffi::OsStr::new("worker.mjs")) {
        8_388_608
    } else {
        134_217_728
    };
    if file.metadata().ok()?.len() > maximum {
        return None;
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    let mut total = 0usize;
    loop {
        let n = file.read(&mut buffer).ok()?;
        if n == 0 {
            break;
        }
        total += n;
        if total > maximum as usize {
            return None;
        }
        hash.update(&buffer[..n]);
    }
    Some(format!("{:x}", hash.finalize()))
}
fn resources(root: &Path) -> bool {
    if !safe_ancestors(root) {
        return false;
    }
    let manifest = root.join("manifest.json");
    if !regular(&manifest) {
        return false;
    }
    let mut bytes = Vec::new();
    let Ok(file) = fs::File::open(&manifest) else {
        return false;
    };
    if file.take(1025).read_to_end(&mut bytes).is_err() {
        return false;
    }
    if bytes.len() > 1024 {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Manifest>(&bytes) else {
        return false;
    };
    value.schema_version == "1.0"
        && hash(&value.node_sha256)
        && hash(&value.worker_sha256)
        && digest(&root.join(node_name())).as_deref() == Some(&value.node_sha256)
        && digest(&root.join("worker.mjs")).as_deref() == Some(&value.worker_sha256)
}
fn node_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}
fn code(value: &str) -> bool {
    [
        "asset_missing",
        "asset_invalid",
        "docker_unavailable",
        "image_missing",
        "cli_check_failed",
        "worker_failed",
        "cleanup_failed",
        "deadline_exceeded",
        "cancelled",
    ]
    .contains(&value)
}
fn valid_result(
    outcome: Outcome,
    version: &Option<String>,
    error: &Option<String>,
    cleanup: Cleanup,
) -> bool {
    let version_valid = version.as_ref().is_some_and(|s| {
        !s.is_empty() && s.len() <= 120 && s.bytes().all(|b| (32..=126).contains(&b))
    });
    let error_valid = error.as_deref().is_some_and(code);
    match outcome {
        Outcome::Passed => version_valid && error.is_none() && cleanup == Cleanup::Verified,
        Outcome::Cancelled => {
            version.is_none()
                && error.as_deref() == Some("cancelled")
                && cleanup == Cleanup::Verified
        }
        Outcome::Failed => version.is_none() && error_valid && cleanup == Cleanup::Verified,
        Outcome::NeedsReview => version.is_none() && error_valid && cleanup == Cleanup::Unknown,
    }
}
fn progress(current: Phase, next: Phase) -> bool {
    matches!(
        (current, next),
        (Phase::Starting, Phase::Preparing)
            | (Phase::Preparing, Phase::Checking)
            | (Phase::Preparing, Phase::Cleaning)
            | (Phase::Checking, Phase::Cleaning)
    )
}
impl Launcher {
    fn start_slot(self: &Arc<Self>) -> Option<StartSlot> {
        let mut count = self.start_jobs.load(Ordering::Acquire);
        loop {
            if count >= 2 {
                return None;
            }
            match self.start_jobs.compare_exchange_weak(
                count,
                count + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(StartSlot(Arc::clone(self))),
                Err(observed) => count = observed,
            }
        }
    }
    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }
    fn start(
        self: &Arc<Self>,
        request: Start,
        root: PathBuf,
        store: PathBuf,
    ) -> Result<Status, &'static str> {
        if request.schema_version != "1.0" || !uuid(&request.request_id) {
            return Err("local_cli_check_denied");
        }
        let mut inner = self.inner.lock().map_err(|_| "local_cli_check_denied")?;
        if inner.shutting_down {
            return Err("local_cli_check_denied");
        }
        if let Some(operation) = &inner.status.operation {
            if operation.request_id == request.request_id {
                return if operation.provider == request.provider {
                    Ok(inner.status.clone())
                } else {
                    Err("local_cli_check_denied")
                };
            }
            if operation.phase != Phase::Finished || operation.outcome == Some(Outcome::NeedsReview)
            {
                return Err("local_cli_check_denied");
            }
        }
        if inner.requests.contains(&request.request_id) || inner.requests.len() >= 1024 {
            return Err("local_cli_check_denied");
        }
        // Admit promptly. The owned background job verifies resources before
        // worker spawn or any journal/home write; status never waits on hashing.
        let operation = Operation {
            request_id: request.request_id,
            provider: request.provider,
            revision: 0,
            phase: Phase::Starting,
            outcome: None,
            cli_version: None,
            error_code: None,
            cleanup: Cleanup::Pending,
        };
        let (tx, rx) = mpsc::sync_channel(1);
        inner.requests.insert(operation.request_id.clone());
        inner.cancel = Some(tx);
        inner.status = Status {
            schema_version: "1.0",
            availability: "available",
            operation: Some(operation.clone()),
        };
        let answer = inner.status.clone();
        drop(inner);
        let owner = Arc::clone(self);
        thread::spawn(move || owner.run(operation, root, store, rx));
        Ok(answer)
    }
    fn cancel(&self, request: Cancel) -> Result<Status, &'static str> {
        if request.schema_version != "1.0"
            || !uuid(&request.request_id)
            || request.expected_revision > 1_000_000_000
        {
            return Err("local_cli_check_denied");
        }
        let inner = self.inner.lock().map_err(|_| "local_cli_check_denied")?;
        let operation = inner
            .status
            .operation
            .as_ref()
            .ok_or("local_cli_check_denied")?;
        if operation.request_id != request.request_id
            || operation.revision != request.expected_revision
        {
            return Err("local_cli_check_denied");
        }
        if let Some(sender) = &inner.cancel {
            let _ = sender.try_send(());
        }
        Ok(inner.status.clone())
    }
    pub fn shutdown(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        inner.shutting_down = true;
        if let Some(sender) = &inner.cancel {
            let _ = sender.try_send(());
            return true;
        }
        false
    }
    pub fn active(&self) -> bool {
        self.inner
            .try_lock()
            .map(|inner| inner.cancel.is_some())
            .unwrap_or(true)
    }
    pub fn force_review(&self) {
        // Exit watchdog must not wait indefinitely for a poisoned or stalled
        // worker mutex. This changes only the UI observation, never the journal.
        if let Ok(mut inner) = self.inner.try_lock() {
            if let Some(operation) = &mut inner.status.operation {
                if operation.phase != Phase::Finished {
                    operation.phase = Phase::Finished;
                    operation.revision += 1;
                    operation.outcome = Some(Outcome::NeedsReview);
                    operation.cli_version = None;
                    operation.error_code = Some("cleanup_failed".into());
                    operation.cleanup = Cleanup::Unknown;
                }
            }
            inner.cancel = None;
        }
    }
    fn update(&self, operation: &Operation) {
        let mut inner = self.inner.lock().unwrap();
        if inner.status.operation.as_ref().is_some_and(|current| {
            current.request_id == operation.request_id && current.phase != Phase::Finished
        }) {
            inner.status.operation = Some(operation.clone());
            if operation.phase == Phase::Finished {
                inner.cancel = None;
            }
        }
    }
    fn finish(&self, operation: &mut Operation, outcome: Outcome, error: &str) {
        operation.revision += 1;
        operation.phase = Phase::Finished;
        operation.outcome = Some(outcome);
        operation.cli_version = None;
        operation.error_code = Some(error.to_string());
        operation.cleanup = Cleanup::Unknown;
        self.update(operation);
    }
    fn finish_unstarted(&self, operation: &mut Operation, outcome: Outcome, error: &str) {
        operation.revision += 1;
        operation.phase = Phase::Cleaning;
        self.update(operation);
        operation.revision += 1;
        operation.phase = Phase::Finished;
        operation.outcome = Some(outcome);
        operation.cli_version = None;
        operation.error_code = Some(error.into());
        operation.cleanup = Cleanup::Verified;
        self.update(operation);
    }
    fn run(
        &self,
        mut operation: Operation,
        root: PathBuf,
        store: PathBuf,
        cancel: mpsc::Receiver<()>,
    ) {
        let deadline = Instant::now() + Duration::from_secs(360);
        if !resources(&root) {
            let absent=[root.join("manifest.json"),root.join(node_name()),root.join("worker.mjs")].iter().any(|path|matches!(fs::symlink_metadata(path),Err(error) if error.kind()==std::io::ErrorKind::NotFound));
            self.finish_unstarted(
                &mut operation,
                Outcome::Failed,
                if absent {
                    "asset_missing"
                } else {
                    "asset_invalid"
                },
            );
            return;
        }
        if cancel.try_recv().is_ok() {
            self.finish_unstarted(&mut operation, Outcome::Cancelled, "cancelled");
            return;
        }
        if Instant::now() >= deadline {
            self.finish_unstarted(&mut operation, Outcome::Failed, "deadline_exceeded");
            return;
        }
        let mut worker = match OwnedWorker::spawn(
            &root.join(node_name()),
            &root.join("worker.mjs"),
            &store.join("launcher-home"),
        ) {
            Ok(worker) => worker,
            Err(_) => {
                self.finish_unstarted(&mut operation, Outcome::Failed, "worker_failed");
                return;
            }
        };
        let mut input = worker.child.stdin.take().unwrap();
        let boot = serde_json::json!({"type":"boot","schema_version":"1.0","request_id":operation.request_id,"provider":operation.provider,"journal_root":store.join("managed-operation-journal"),"assets_root":root.join("assets")});
        if writeln!(input, "{}", boot).is_err() {
            worker.terminate();
            self.finish(&mut operation, Outcome::NeedsReview, "worker_failed");
            return;
        }
        let (tx, rx) = mpsc::channel();
        let output = worker.child.stdout.take().unwrap();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            for _ in 0..128 {
                let mut line = Vec::new();
                let read = reader.by_ref().take(8193).read_until(b'\n', &mut line);
                match read {
                    Ok(0) => return,
                    Ok(_) if line.len() <= 8192 && line.last() == Some(&b'\n') => {
                        if tx
                            .send(serde_json::from_slice::<Frame>(&line).map_err(|_| ()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    _ => {
                        let _ = tx.send(Err(()));
                        return;
                    }
                }
            }
            let _ = tx.send(Err(()));
        });
        let mut stderr = worker.child.stderr.take().unwrap();
        thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
        let mut cancellation: Option<(Instant, &str)> = None;
        let mut result: Option<(Outcome, Option<String>, Option<String>, Cleanup)> = None;
        let mut failure = None;
        loop {
            if cancellation.is_none() && (cancel.try_recv().is_ok() || Instant::now() >= deadline) {
                let reason = if Instant::now() >= deadline {
                    "deadline_exceeded"
                } else {
                    "cancelled"
                };
                cancellation = Some((Instant::now() + Duration::from_secs(30), reason));
                if writeln!(input, "{{\"type\":\"cancel\"}}").is_err() {
                    failure = Some("worker_failed");
                }
            }
            if failure.is_some() || cancellation.is_some_and(|(until, _)| Instant::now() >= until) {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(Ok(Frame::Progress { phase }))
                    if result.is_none() && progress(operation.phase, phase) =>
                {
                    operation.phase = phase;
                    operation.revision += 1;
                    self.update(&operation);
                }
                Ok(Ok(Frame::Result {
                    outcome,
                    cli_version,
                    error_code,
                    cleanup,
                })) if result.is_none()
                    && operation.phase == Phase::Cleaning
                    && valid_result(outcome, &cli_version, &error_code, cleanup) =>
                {
                    // A result is only final after the owned worker exits.
                    result = Some((outcome, cli_version, error_code, cleanup));
                }
                Ok(_) => failure = Some("worker_failed"),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {}
            }
            match worker.poll() {
                Ok(Some(exit)) => {
                    // The reader may still have queued the final frame when
                    // root exit is observed. Drain available frames first.
                    while let Ok(frame) = rx.recv_timeout(Duration::from_millis(100)) {
                        match frame {
                            Ok(Frame::Progress { phase })
                                if result.is_none() && progress(operation.phase, phase) =>
                            {
                                operation.phase = phase;
                                operation.revision += 1;
                                self.update(&operation);
                            }
                            Ok(Frame::Result {
                                outcome,
                                cli_version,
                                error_code,
                                cleanup,
                            }) if result.is_none()
                                && operation.phase == Phase::Cleaning
                                && valid_result(outcome, &cli_version, &error_code, cleanup) =>
                            {
                                result = Some((outcome, cli_version, error_code, cleanup));
                            }
                            _ => failure = Some("worker_failed"),
                        }
                    }
                    if exit.success() && failure.is_none() {
                        if let Some((mut outcome, mut version, mut error, cleanup)) = result {
                            if let Some((_, reason)) = cancellation {
                                if cleanup == Cleanup::Verified {
                                    outcome = if reason == "cancelled" {
                                        Outcome::Cancelled
                                    } else {
                                        Outcome::Failed
                                    };
                                    version = None;
                                    error = Some(reason.to_string());
                                }
                            }
                            operation.revision += 1;
                            operation.phase = Phase::Finished;
                            operation.outcome = Some(outcome);
                            operation.cli_version = version;
                            operation.error_code = error;
                            operation.cleanup = cleanup;
                            self.update(&operation);
                            return;
                        }
                    }
                    self.finish(&mut operation, Outcome::NeedsReview, "worker_failed");
                    return;
                }
                Ok(None) => {}
                Err(_) => {
                    failure = Some("worker_failed");
                    break;
                }
            }
        }
        worker.terminate();
        let stop_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < stop_deadline {
            if !matches!(worker.poll(), Ok(None)) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.finish(
            &mut operation,
            Outcome::NeedsReview,
            failure.unwrap_or_else(|| {
                cancellation
                    .map(|(_, reason)| reason)
                    .unwrap_or("worker_failed")
            }),
        );
    }
}

fn decode<T: for<'de> Deserialize<'de>, R: Runtime>(
    webview: &Webview<R>,
    request: Request<'_>,
) -> Result<T, &'static str> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("local_cli_check_denied");
    }
    match request.body() {
        InvokeBody::Json(value) => {
            serde_json::from_value(value.clone()).map_err(|_| "local_cli_check_denied")
        }
        _ => Err("local_cli_check_denied"),
    }
}
#[tauri::command]
pub(crate) async fn local_cli_check_start<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
    launcher: State<'_, Arc<Launcher>>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Start> = decode(&webview, request)?;
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "local_cli_check_denied")?
        .join("launcher");
    let store = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "local_cli_check_denied")?;
    let owner = Arc::clone(launcher.inner());
    let slot = owner.start_slot().ok_or("local_cli_check_denied")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        owner.start(value.request, root, store)
    })
    .await
    .map_err(|_| "local_cli_check_denied")?
}
#[tauri::command]
pub(crate) async fn local_cli_check_status<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    launcher: State<'_, Arc<Launcher>>,
) -> Result<Status, &'static str> {
    let _: Empty = decode(&webview, request)?;
    Ok(launcher.status())
}
#[tauri::command]
pub(crate) async fn local_cli_check_cancel<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    launcher: State<'_, Arc<Launcher>>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Cancel> = decode(&webview, request)?;
    launcher.cancel(value.request)
}

#[cfg(test)]
mod tests;
