//! Narrow supervisor for one approved task run on the saved selected profile.
//! The webview supplies only identifiers and an explicit approval; the owned
//! worker's frames are validated against the public status contract before
//! any of them becomes visible.
use crate::{
    launcher::{node_name, resources, uuid},
    launcher_process::OwnedWorker,
    profile_session::ProfileSession,
    profile_store::{self, Provider},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex, OnceLock, Weak,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, Runtime, State, Webview,
};

const DENIED: &str = "local_task_run_denied";
const CONTROLLED_TASK: &str = "controlled-sum-integers-v1";
const SOFTWARE_TASK: &str = "software-bounds";
// Mirrors taskRunTaskIds in the browser contract.
const TASK_IDS: [&str; 2] = [CONTROLLED_TASK, SOFTWARE_TASK];
const MAX_REVISION: u32 = 1_000_000_000;
const MAX_TOOL_CALLS: u32 = 16;
const MAX_PATCH_BYTES: usize = 49_152;
const MAX_STATUS_BYTES: usize = 65_536;
const MAX_FRAME_BYTES: usize = 65_536;
const MAX_FRAMES: usize = 64;
#[derive(Clone, Copy)]
struct Limits {
    deadline: Duration,
    // The cleanup grace is independent of the operation deadline.
    grace: Duration,
}
const LIMITS: Limits = Limits {
    deadline: Duration::from_secs(1200),
    grace: Duration::from_secs(35),
};
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Starting,
    Preparing,
    Running,
    Verifying,
    Cleaning,
    Finished,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Passed,
    Rejected,
    Cancelled,
    Failed,
    NeedsReview,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Cleanup {
    Pending,
    Verified,
    Unknown,
}
// Maps a caller-supplied id onto the supported task it names, if any.
fn task_id(value: &str) -> Option<&'static str> {
    TASK_IDS.iter().copied().find(|id| *id == value)
}
// The single writable file of each task, as in taskRunPatchPaths.
fn patch_path(task: &str) -> Option<&'static str> {
    match task {
        CONTROLLED_TASK => Some("sum.mjs"),
        SOFTWARE_TASK => Some("src/search.ts"),
        _ => None,
    }
}
fn patch_header(task: &str) -> Option<String> {
    patch_path(task).map(|path| format!("diff --git a/{path} b/{path}\n"))
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ControlledVerifier {
    passed: bool,
    cases: u32,
    json_cases_passed: bool,
    sparse_cases_passed: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SoftwareVerifier {
    passed: bool,
    cases: u32,
    visible_tests_passed: bool,
    hidden_cases_passed: bool,
}
// Each variant accepts exactly its own field set, so the other task's shape
// never deserializes into it; TaskResult::valid binds the variant to the task.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
enum Verifier {
    Controlled(ControlledVerifier),
    Software(SoftwareVerifier),
}
impl Verifier {
    // (passed, cases, the two task checks) when the shape belongs to the task.
    fn parts(&self, task: &str) -> Option<(bool, u32, bool, bool)> {
        match (self, task) {
            (Self::Controlled(v), CONTROLLED_TASK) => Some((
                v.passed,
                v.cases,
                v.json_cases_passed,
                v.sparse_cases_passed,
            )),
            (Self::Software(v), SOFTWARE_TASK) => Some((
                v.passed,
                v.cases,
                v.visible_tests_passed,
                v.hidden_cases_passed,
            )),
            _ => None,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct TaskResult {
    verifier: Verifier,
    candidate_sha256: String,
    #[serde(deserialize_with = "nullable")]
    patch_sha256: Option<String>,
    #[serde(deserialize_with = "nullable")]
    patch: Option<String>,
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
// A unified diff of the task's single writable file: printable UTF-8 text
// without NUL, bidi controls or carriage returns, beginning with its header.
fn valid_patch(value: &str, task: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PATCH_BYTES
        && patch_header(task).is_some_and(|header| value.starts_with(&header))
        && !value
            .chars()
            .any(|c| matches!(c, '\0' | '\r' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
}
impl TaskResult {
    fn valid(&self, outcome: Outcome, task: &str) -> bool {
        let Some((passed, cases, first, second)) = self.verifier.parts(task) else {
            return false;
        };
        hash(&self.candidate_sha256)
            && (1..=1000).contains(&cases)
            && passed == (first && second)
            && match outcome {
                Outcome::Passed => {
                    passed
                        && self.patch_sha256.as_deref().is_some_and(hash)
                        && self
                            .patch
                            .as_deref()
                            .is_some_and(|patch| valid_patch(patch, task))
                }
                Outcome::Rejected => !passed && self.patch_sha256.is_none() && self.patch.is_none(),
                _ => false,
            }
    }
}
#[derive(Clone, Debug, Serialize)]
struct Model {
    requested: &'static str,
    observed: Option<String>,
}
fn requested_model(provider: Provider) -> &'static str {
    match provider {
        Provider::Codex => "gpt-6-luna",
        Provider::Claude => "haiku",
    }
}
fn observed_model(provider: Provider, value: &str) -> bool {
    match provider {
        Provider::Codex => value == "gpt-6-luna",
        Provider::Claude => matches!(
            value,
            "claude-haiku-4-5-20251001" | "claude-haiku-4-5" | "claude-haiku-5-5"
        ),
    }
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Operation {
    request_id: String,
    profile_id: String,
    provider: Provider,
    task_id: &'static str,
    revision: u32,
    phase: Phase,
    outcome: Option<Outcome>,
    error_code: Option<String>,
    cleanup: Cleanup,
    tool_calls: u32,
    model: Model,
    result: Option<TaskResult>,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Status {
    schema_version: &'static str,
    availability: &'static str,
    operation: Option<Operation>,
}
fn code(value: &str) -> bool {
    [
        "asset_missing",
        "asset_invalid",
        "docker_unavailable",
        "image_missing",
        "profile_invalid",
        "profile_needs_review",
        "profile_unbound",
        "auth_required",
        "model_unavailable",
        "quota_exhausted",
        "provider_failed",
        "tool_limit",
        "candidate_invalid",
        "candidate_rejected",
        "verifier_failed",
        "worker_failed",
        "cleanup_failed",
        "deadline_exceeded",
        "cancelled",
    ]
    .contains(&value)
}
// Rust mirror of the browser contract's validateTaskRunStatus for one
// operation: every state this module publishes must satisfy it.
fn valid_operation(op: &Operation) -> bool {
    if !uuid(&op.request_id)
        || !uuid(&op.profile_id)
        || op.revision > MAX_REVISION
        || op.tool_calls > MAX_TOOL_CALLS
        || op.model.requested != requested_model(op.provider)
        || op
            .model
            .observed
            .as_deref()
            .is_some_and(|model| !observed_model(op.provider, model))
        || op.error_code.as_deref().is_some_and(|error| !code(error))
    {
        return false;
    }
    if op.phase != Phase::Finished {
        return op.outcome.is_none()
            && op.error_code.is_none()
            && op.cleanup == Cleanup::Pending
            && op.result.is_none()
            && (op.phase != Phase::Starting
                || (op.tool_calls == 0 && op.model.observed.is_none()));
    }
    let Some(outcome) = op.outcome else {
        return false;
    };
    match outcome {
        Outcome::Passed | Outcome::Rejected => {
            op.cleanup == Cleanup::Verified
                && op.model.observed.is_some()
                && op.tool_calls >= 1
                && op.error_code.as_deref()
                    == (outcome == Outcome::Rejected).then_some("candidate_rejected")
                && op
                    .result
                    .as_ref()
                    .is_some_and(|result| result.valid(outcome, op.task_id))
        }
        _ => {
            op.result.is_none()
                && op
                    .error_code
                    .as_deref()
                    .is_some_and(|error| error != "candidate_rejected")
                && op.cleanup
                    == if outcome == Outcome::NeedsReview {
                        Cleanup::Unknown
                    } else {
                        Cleanup::Verified
                    }
                && (outcome == Outcome::Cancelled)
                    == (op.error_code.as_deref() == Some("cancelled"))
        }
    }
}
fn valid_status(status: &Status) -> bool {
    status.operation.as_ref().is_none_or(valid_operation)
        && serde_json::to_vec(status).is_ok_and(|bytes| bytes.len() <= MAX_STATUS_BYTES)
}
// The terminal observation a worker (or the supervisor) reports.
#[derive(Clone, Debug)]
struct End {
    outcome: Outcome,
    error: Option<String>,
    cleanup: Cleanup,
    result: Option<TaskResult>,
}
impl End {
    fn failed(error: &str) -> Self {
        Self::plain(Outcome::Failed, error, Cleanup::Verified)
    }
    fn review(error: &str) -> Self {
        Self::plain(Outcome::NeedsReview, error, Cleanup::Unknown)
    }
    fn cancelled() -> Self {
        Self::plain(Outcome::Cancelled, "cancelled", Cleanup::Verified)
    }
    fn plain(outcome: Outcome, error: &str, cleanup: Cleanup) -> Self {
        Self {
            outcome,
            error: Some(error.into()),
            cleanup,
            result: None,
        }
    }
}
struct Inner {
    status: Status,
    // Worker protocol state advances even when cancellation freezes the
    // public projection. Buffered observations still need normal validation.
    worker_observation: Option<Operation>,
    cancel: Option<mpsc::SyncSender<()>>,
    cancel_requested: bool,
    shutting_down: bool,
    requests: HashSet<String>,
}
pub(crate) struct TaskRun {
    inner: Mutex<Inner>,
    start_jobs: AtomicUsize,
    sessions: OnceLock<Weak<ProfileSession>>,
}
impl Default for TaskRun {
    fn default() -> Self {
        Self {
            start_jobs: AtomicUsize::new(0),
            sessions: OnceLock::new(),
            inner: Mutex::new(Inner {
                status: Status {
                    schema_version: "1.0",
                    availability: "available",
                    operation: None,
                },
                worker_observation: None,
                cancel: None,
                cancel_requested: false,
                shutting_down: false,
                requests: HashSet::new(),
            }),
        }
    }
}
struct StartSlot(Arc<TaskRun>);
impl Drop for StartSlot {
    fn drop(&mut self) {
        self.0.start_jobs.fetch_sub(1, Ordering::AcqRel);
    }
}
// Account operations and task runs share one profile registry and one
// managed Docker owner, so they may never overlap.
pub(crate) fn link(runs: &Arc<TaskRun>, sessions: &Arc<ProfileSession>) {
    let _ = runs.sessions.set(Arc::downgrade(sessions));
    sessions.link_task_run(Arc::downgrade(runs));
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    schema_version: String,
    request_id: String,
    profile_id: String,
    task_id: String,
    approved: bool,
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
#[derive(Debug, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Frame {
    #[serde(rename = "progress")]
    Progress { phase: Phase },
    #[serde(rename = "activity")]
    Activity { tool_calls: u32 },
    #[serde(rename = "model")]
    Model { observed: String },
    #[serde(rename = "result")]
    Result {
        outcome: Outcome,
        #[serde(deserialize_with = "nullable")]
        error_code: Option<String>,
        cleanup: Cleanup,
        #[serde(deserialize_with = "nullable")]
        result: Option<TaskResult>,
    },
}
fn nullable<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(input)
}
fn progress(current: Phase, next: Phase) -> bool {
    matches!(
        (current, next),
        (Phase::Starting, Phase::Preparing)
            | (Phase::Preparing, Phase::Running)
            | (Phase::Running, Phase::Verifying)
            | (Phase::Verifying, Phase::Cleaning)
    ) || (next == Phase::Cleaning && !matches!(current, Phase::Cleaning | Phase::Finished))
}
impl TaskRun {
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
        self.inner
            .lock()
            .map(|inner| inner.status.clone())
            .unwrap_or(Status {
                schema_version: "1.0",
                availability: "unavailable",
                operation: None,
            })
    }
    fn start(
        self: &Arc<Self>,
        request: Start,
        root: PathBuf,
        store: PathBuf,
    ) -> Result<Status, &'static str> {
        self.admit(request, root, store, LIMITS)
    }
    fn admit(
        self: &Arc<Self>,
        request: Start,
        root: PathBuf,
        store: PathBuf,
        limits: Limits,
    ) -> Result<Status, &'static str> {
        if request.schema_version != "1.0"
            || !uuid(&request.request_id)
            || !uuid(&request.profile_id)
            || !request.approved
        {
            return Err(DENIED);
        }
        let task = task_id(&request.task_id).ok_or(DENIED)?;
        let provider =
            profile_store::selected_provider(&store.join("managed-profiles"), &request.profile_id)
                .map_err(|_| DENIED)?;
        let mut inner = self.inner.lock().map_err(|_| DENIED)?;
        if inner.shutting_down {
            return Err(DENIED);
        }
        if let Some(operation) = &inner.status.operation {
            if operation.request_id == request.request_id {
                return if operation.profile_id == request.profile_id
                    && operation.provider == provider
                    && operation.task_id == task
                {
                    Ok(inner.status.clone())
                } else {
                    Err(DENIED)
                };
            }
            if operation.phase != Phase::Finished || operation.outcome == Some(Outcome::NeedsReview)
            {
                return Err(DENIED);
            }
        }
        if inner.requests.contains(&request.request_id) || inner.requests.len() >= 1024 {
            return Err(DENIED);
        }
        // Checked while holding this lock; the peer checks the same way.
        if self
            .sessions
            .get()
            .and_then(Weak::upgrade)
            .is_some_and(|sessions| sessions.active())
        {
            return Err(DENIED);
        }
        let operation = Operation {
            request_id: request.request_id,
            profile_id: request.profile_id,
            provider,
            task_id: task,
            revision: 0,
            phase: Phase::Starting,
            outcome: None,
            error_code: None,
            cleanup: Cleanup::Pending,
            tool_calls: 0,
            model: Model {
                requested: requested_model(provider),
                observed: None,
            },
            result: None,
        };
        let (tx, rx) = mpsc::sync_channel(1);
        inner.requests.insert(operation.request_id.clone());
        inner.cancel = Some(tx);
        inner.cancel_requested = false;
        inner.worker_observation = Some(operation.clone());
        inner.status.operation = Some(operation.clone());
        let answer = inner.status.clone();
        drop(inner);
        let owner = Arc::clone(self);
        thread::spawn(move || owner.run(operation, root, store, rx, limits));
        Ok(answer)
    }
    fn request_cancel(inner: &mut Inner) {
        if inner.cancel.is_some() && !inner.cancel_requested {
            inner.cancel_requested = true;
            if let Some(operation) = &mut inner.status.operation {
                operation.revision += 1;
            }
            if let Some(sender) = &inner.cancel {
                let _ = sender.try_send(());
            }
        }
    }
    fn cancel(&self, request: Cancel) -> Result<Status, &'static str> {
        if request.schema_version != "1.0"
            || !uuid(&request.request_id)
            || request.expected_revision > MAX_REVISION
        {
            return Err(DENIED);
        }
        let mut inner = self.inner.lock().map_err(|_| DENIED)?;
        let operation = inner.status.operation.as_ref().ok_or(DENIED)?;
        if operation.request_id != request.request_id
            || operation.revision != request.expected_revision
        {
            return Err(DENIED);
        }
        Self::request_cancel(&mut inner);
        Ok(inner.status.clone())
    }
    pub fn shutdown(&self) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return true;
        };
        inner.shutting_down = true;
        Self::request_cancel(&mut inner);
        inner.cancel.is_some()
    }
    pub fn active(&self) -> bool {
        self.inner
            .try_lock()
            .map(|inner| inner.cancel.is_some())
            .unwrap_or(true)
    }
    pub fn force_review(&self) {
        if let Ok(mut inner) = self.inner.try_lock() {
            if let Some(operation) = &mut inner.status.operation {
                if operation.phase != Phase::Finished {
                    Self::terminal(operation, End::review("cleanup_failed"));
                }
            }
            inner.cancel = None;
        }
    }
    fn terminal(operation: &mut Operation, end: End) {
        operation.revision += 1;
        operation.phase = Phase::Finished;
        operation.outcome = Some(end.outcome);
        operation.error_code = end.error;
        operation.cleanup = end.cleanup;
        operation.result = end.result;
    }
    fn finish(&self, id: &str, mut end: End) {
        if let Ok(mut inner) = self.inner.lock() {
            // A requested cancellation outranks anything but a deadline, and
            // never leaves a result of the cancelled run visible.
            if inner.cancel_requested
                && end.cleanup == Cleanup::Verified
                && end.error.as_deref() != Some("deadline_exceeded")
            {
                end = End::cancelled();
            }
            if let Some(operation) = &mut inner.status.operation {
                if operation.request_id == id && operation.phase != Phase::Finished {
                    let mut next = operation.clone();
                    Self::terminal(&mut next, end);
                    // Never publish a state the public contract would reject.
                    if !valid_operation(&next) {
                        next = operation.clone();
                        Self::terminal(&mut next, End::review("worker_failed"));
                    }
                    *operation = next;
                    inner.cancel = None;
                }
            }
        }
    }
    // Mutate the current observation rather than replacing a worker snapshot:
    // cancellation's immediate revision bump must survive.
    fn frame(&self, id: &str, frame: Frame, result: &mut Option<End>) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let cancelled = inner.cancel_requested;
        let Inner {
            status,
            worker_observation,
            ..
        } = &mut *inner;
        let Some(operation) = &mut status.operation else {
            return false;
        };
        if operation.request_id != id || operation.phase == Phase::Finished || result.is_some() {
            return false;
        }
        let observation = worker_observation.get_or_insert_with(|| operation.clone());
        match frame {
            Frame::Progress { phase }
                if matches!(
                    phase,
                    Phase::Preparing | Phase::Running | Phase::Verifying | Phase::Cleaning
                ) =>
            {
                if !progress(observation.phase, phase) {
                    return false;
                }
                observation.phase = phase;
                if cancelled && phase != Phase::Cleaning {
                    return true;
                }
                operation.phase = phase;
                operation.revision += 1;
                true
            }
            Frame::Activity { tool_calls }
                if matches!(observation.phase, Phase::Running | Phase::Verifying)
                    && (observation.tool_calls..=MAX_TOOL_CALLS).contains(&tool_calls) =>
            {
                observation.tool_calls = tool_calls;
                if cancelled {
                    return true;
                }
                if tool_calls != operation.tool_calls {
                    operation.tool_calls = tool_calls;
                    operation.revision += 1;
                }
                true
            }
            Frame::Model { observed }
                if matches!(observation.phase, Phase::Running | Phase::Verifying)
                    && observed_model(operation.provider, &observed)
                    && observation
                        .model
                        .observed
                        .as_ref()
                        .is_none_or(|first| *first == observed) =>
            {
                observation.model.observed = Some(observed.clone());
                if cancelled {
                    return true;
                }
                if operation.model.observed.is_none() {
                    operation.model.observed = Some(observed);
                    operation.revision += 1;
                }
                true
            }
            Frame::Result {
                outcome,
                error_code,
                cleanup,
                result: payload,
            } if observation.phase == Phase::Cleaning => {
                let end = End {
                    outcome,
                    error: error_code,
                    cleanup,
                    result: payload,
                };
                // Validate the complete worker terminal report, including
                // observations cancellation has hidden, at its widest.
                let mut candidate = observation.clone();
                candidate.revision = MAX_REVISION - 1;
                Self::terminal(&mut candidate, end.clone());
                if !valid_status(&Status {
                    schema_version: "1.0",
                    availability: "available",
                    operation: Some(candidate),
                }) {
                    return false;
                }
                *result = Some(end);
                true
            }
            _ => false,
        }
    }
    fn run(
        &self,
        operation: Operation,
        root: PathBuf,
        store: PathBuf,
        cancel: mpsc::Receiver<()>,
        limits: Limits,
    ) {
        let id = operation.request_id.as_str();
        let deadline = Instant::now() + limits.deadline;
        if !resources(&root) {
            let absent = [root.join("manifest.json"), root.join(node_name()), root.join("worker.mjs")].iter().any(|path| matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound));
            self.finish(
                id,
                End::failed(if absent {
                    "asset_missing"
                } else {
                    "asset_invalid"
                }),
            );
            return;
        }
        if cancel.try_recv().is_ok() {
            self.finish(id, End::cancelled());
            return;
        }
        if Instant::now() >= deadline {
            self.finish(id, End::failed("deadline_exceeded"));
            return;
        }
        let home = store.join("task-run-worker-home");
        let (journal, assets, registry) = (
            store.join("managed-operation-journal"),
            root.join("assets"),
            store.join("managed-profiles"),
        );
        let (Some(journal), Some(assets), Some(registry)) =
            (journal.to_str(), assets.to_str(), registry.to_str())
        else {
            self.finish(id, End::failed("worker_failed"));
            return;
        };
        let mut worker =
            match OwnedWorker::spawn(&root.join(node_name()), &root.join("worker.mjs"), &home) {
                Ok(worker) => worker,
                Err(_) => {
                    self.finish(id, End::failed("worker_failed"));
                    return;
                }
            };
        let mut input = worker.child.stdin.take().unwrap();
        let boot = serde_json::json!({"type":"task_run_boot", "schema_version":"1.0", "request_id":operation.request_id, "profile_id":operation.profile_id, "provider":operation.provider, "task_id":operation.task_id, "journal_root":journal, "assets_root":assets, "profile_registry_root":registry});
        if writeln!(input, "{}", boot).is_err() {
            worker.terminate();
            self.finish(id, End::review("worker_failed"));
            return;
        }
        let (tx, rx) = mpsc::channel();
        let output = worker.child.stdout.take().unwrap();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            for _ in 0..MAX_FRAMES {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(MAX_FRAME_BYTES as u64 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => return,
                    Ok(_) if line.len() <= MAX_FRAME_BYTES && line.last() == Some(&b'\n') => {
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
        let mut result = None;
        let mut failure = None;
        loop {
            if cancellation.is_none() {
                let requested = cancel.try_recv().is_ok();
                if requested || Instant::now() >= deadline {
                    let reason = if requested {
                        "cancelled"
                    } else {
                        "deadline_exceeded"
                    };
                    cancellation = Some((Instant::now() + limits.grace, reason));
                    if let Ok(mut inner) = self.inner.lock() {
                        Self::request_cancel(&mut inner);
                    }
                    if writeln!(input, "{{\"type\":\"cancel\"}}").is_err() {
                        failure = Some("worker_failed");
                    }
                }
            }
            if failure.is_some() || cancellation.is_some_and(|(until, _)| Instant::now() >= until) {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(Ok(frame)) => {
                    if !self.frame(id, frame, &mut result) {
                        failure = Some("worker_failed");
                    }
                }
                Ok(Err(())) => failure = Some("worker_failed"),
                Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
            }
            match worker.poll() {
                Ok(Some(exit)) => {
                    // Root exit can precede the stdout reader's final enqueue.
                    while let Ok(frame) = rx.recv_timeout(Duration::from_millis(100)) {
                        if !frame.is_ok_and(|frame| self.frame(id, frame, &mut result)) {
                            failure = Some("worker_failed");
                        }
                    }
                    if exit.success() && failure.is_none() {
                        if let Some(mut end) = result {
                            // Catch a cancellation delivered between frame receipt
                            // and exit; a run result cannot survive it.
                            if cancellation.is_none() && cancel.try_recv().is_ok() {
                                cancellation = Some((Instant::now(), "cancelled"));
                            }
                            if let Some((_, reason)) = cancellation {
                                if end.cleanup == Cleanup::Verified {
                                    end = if reason == "cancelled" {
                                        End::cancelled()
                                    } else {
                                        End::failed(reason)
                                    };
                                }
                            }
                            self.finish(id, end);
                            return;
                        }
                    }
                    self.finish(id, End::review("worker_failed"));
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
        // Killing an owned process tree is not proof of managed Docker cleanup.
        self.finish(
            id,
            End::review(failure.unwrap_or(match cancellation {
                // Cancelled is only a verified-cleanup outcome.
                Some((_, "deadline_exceeded")) => "deadline_exceeded",
                Some(_) => "cleanup_failed",
                None => "worker_failed",
            })),
        );
    }
}

#[derive(Clone, Copy)]
enum Shape {
    Start,
    Status,
    Cancel,
}
fn exact_object<'a>(
    value: &'a serde_json::Value,
    fields: &[&str],
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    let object = value.as_object()?;
    (object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)))
        .then_some(object)
}
fn preflight(value: &serde_json::Value, shape: Shape) -> bool {
    if matches!(shape, Shape::Status) {
        return exact_object(value, &[]).is_some();
    }
    let Some(wrapper) = exact_object(value, &["request"]) else {
        return false;
    };
    let fields: &[&str] = match shape {
        Shape::Start => &[
            "schema_version",
            "request_id",
            "profile_id",
            "task_id",
            "approved",
        ],
        Shape::Cancel => &["schema_version", "request_id", "expected_revision"],
        Shape::Status => return false,
    };
    let Some(request) = exact_object(&wrapper["request"], fields) else {
        return false;
    };
    request["schema_version"].as_str() == Some("1.0")
        && request["request_id"].as_str().is_some_and(uuid)
        && match shape {
            Shape::Start => {
                request["profile_id"].as_str().is_some_and(uuid)
                    && request["task_id"].as_str().and_then(task_id).is_some()
                    && request["approved"].as_bool() == Some(true)
            }
            Shape::Cancel => request["expected_revision"]
                .as_u64()
                .is_some_and(|revision| revision <= u64::from(MAX_REVISION)),
            Shape::Status => false,
        }
}
fn decode<T: for<'de> Deserialize<'de>, R: Runtime>(
    webview: &Webview<R>,
    request: Request<'_>,
    shape: Shape,
) -> Result<T, &'static str> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err(DENIED);
    }
    match request.body() {
        InvokeBody::Json(value) if preflight(value, shape) => {
            serde_json::from_value(value.clone()).map_err(|_| DENIED)
        }
        _ => Err(DENIED),
    }
}
#[tauri::command]
pub(crate) async fn local_task_run_start<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
    runs: State<'_, Arc<TaskRun>>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Start> = decode(&webview, request, Shape::Start)?;
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| DENIED)?
        .join("launcher");
    let store = app.path().app_local_data_dir().map_err(|_| DENIED)?;
    let owner = Arc::clone(runs.inner());
    let slot = owner.start_slot().ok_or(DENIED)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        owner.start(value.request, root, store)
    })
    .await
    .map_err(|_| DENIED)?
}
#[tauri::command]
pub(crate) async fn local_task_run_status<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    runs: State<'_, Arc<TaskRun>>,
) -> Result<Status, &'static str> {
    let _: Empty = decode(&webview, request, Shape::Status)?;
    Ok(runs.status())
}
#[tauri::command]
pub(crate) async fn local_task_run_cancel<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    runs: State<'_, Arc<TaskRun>>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Cancel> = decode(&webview, request, Shape::Cancel)?;
    runs.cancel(value.request)
}

#[cfg(test)]
mod tests;
