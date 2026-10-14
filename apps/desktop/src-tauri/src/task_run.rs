//! Narrow supervisor for one approved task run on the saved selected profile.
//! The webview supplies only identifiers and an explicit approval; the owned
//! worker's frames are validated against the public status contract before
//! any of them becomes visible.
use crate::{
    launcher::{node_name, resources, uuid},
    launcher_process::OwnedWorker,
    profile_session::ProfileSession,
    profile_store::{self, Provider},
    run_limits,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, Runtime, State, Webview,
};

const DENIED: &str = "local_task_run_denied";
const CONTROLLED_TASK: &str = "controlled-sum-integers-v1";
const SOFTWARE_TASK: &str = "software-bounds";
const INTERVALS_TASK: &str = "software-intervals";
// Mirrors taskRunTaskIds in the browser contract.
const TASK_IDS: [&str; 3] = [CONTROLLED_TASK, SOFTWARE_TASK, INTERVALS_TASK];
const MAX_REVISION: u32 = 1_000_000_000;
const MAX_TOOL_CALLS: u32 = 16;
const MAX_PATCH_BYTES: usize = 49_152;
const MAX_STATUS_BYTES: usize = 65_536;
const MAX_FRAME_BYTES: usize = 65_536;
const MAX_FRAMES: usize = 64;
const MAX_PACKAGE_BYTES: usize = 16_384;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LeaseContext {
    lease_id: String,
    attempt_id: String,
    task_version: u64,
    contract_hash: String,
    base_commit: String,
    strategy_id: String,
    time_limit_sec: u64,
    expires_at_ms: u64,
}
fn server_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
impl LeaseContext {
    fn valid(&self, task: &str, strategy: Option<&str>) -> bool {
        let pin = match task {
            SOFTWARE_TASK => (
                "4823a3908e60b9bdeebf737c4f1d8c71a53c86981f5a4c6845877ba815f1216d",
                "7a06a3ea1880fec11033104223474b8f297cab6c",
            ),
            INTERVALS_TASK => (
                "5f1f13e5b3623bbd61f9479ec4944e99c71efd2cb49a608a6b4ba4c881adb6f2",
                "dcf0d103b825d9e2cdc41f5a0efa6811e694a069",
            ),
            _ => return false,
        };
        server_id(&self.lease_id)
            && server_id(&self.attempt_id)
            && self.task_version == 1
            && self.contract_hash == pin.0
            && self.base_commit == pin.1
            && Some(self.strategy_id.as_str()) == strategy
            && strategy_id(task, strategy).is_some()
            && (1..=1200).contains(&self.time_limit_sec)
            && (1..=9_007_199_254_740_991).contains(&self.expires_at_ms)
    }
    fn remaining(&self) -> Option<Duration> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis() as u64;
        Some(
            Duration::from_millis(self.expires_at_ms.checked_sub(now)?)
                .min(Duration::from_secs(self.time_limit_sec)),
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    lease_id: String,
    sha256: String,
    size_bytes: usize,
    bytes_base64: String,
}
impl Artifact {
    fn valid(&self, lease: &LeaseContext) -> bool {
        if self.lease_id != lease.lease_id
            || !hash(&self.sha256)
            || !(1..=MAX_PACKAGE_BYTES).contains(&self.size_bytes)
            || self.bytes_base64.len() != ((self.size_bytes + 2) / 3) * 4
        {
            return false;
        }
        let Ok(bytes) = STANDARD.decode(&self.bytes_base64) else {
            return false;
        };
        bytes.len() == self.size_bytes
            && STANDARD.encode(&bytes) == self.bytes_base64
            && format!("{:x}", Sha256::digest(&bytes)) == self.sha256
    }
}
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
// Mirrors taskRunStrategyIds: the approved strategy ids of each task. The
// controlled task has none; a catalog task run names exactly one of its own.
const SOFTWARE_STRATEGIES: [&str; 2] = ["invariant", "boundary-first"];
const INTERVALS_STRATEGIES: [&str; 2] = ["sort-first", "sweep"];
fn task_strategies(task: &str) -> &'static [&'static str] {
    match task {
        SOFTWARE_TASK => &SOFTWARE_STRATEGIES,
        INTERVALS_TASK => &INTERVALS_STRATEGIES,
        _ => &[],
    }
}
// Maps a caller-supplied strategy onto the allowlisted one of this task. The
// outer None is a denial; Some(None) is the strategy-less controlled task.
fn strategy_id(task: &str, value: Option<&str>) -> Option<Option<&'static str>> {
    let allowed = task_strategies(task);
    match value {
        None => allowed.is_empty().then_some(None),
        Some(value) => allowed.iter().copied().find(|id| *id == value).map(Some),
    }
}
// The single writable file of each task, as in taskRunPatchPaths.
fn patch_path(task: &str) -> Option<&'static str> {
    match task {
        CONTROLLED_TASK => Some("sum.mjs"),
        SOFTWARE_TASK => Some("src/search.ts"),
        INTERVALS_TASK => Some("src/intervals.ts"),
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
            (Self::Software(v), SOFTWARE_TASK | INTERVALS_TASK) => Some((
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
    // Fixed for the lifetime of the request.
    strategy_id: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_context: Option<LeaseContext>,
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
        "local_budget_exhausted",
        "local_budget_unavailable",
    ]
    .contains(&value)
}
// Rust mirror of the browser contract's validateTaskRunStatus for one
// operation: every state this module publishes must satisfy it.
fn valid_operation(op: &Operation) -> bool {
    if op
        .lease_context
        .as_ref()
        .is_some_and(|lease| !lease.valid(op.task_id, op.strategy_id))
    {
        return false;
    }
    if !uuid(&op.request_id)
        || !uuid(&op.profile_id)
        || strategy_id(op.task_id, op.strategy_id) != Some(op.strategy_id)
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
    artifact: Option<Artifact>,
    status: Status,
    // Worker protocol state advances even when cancellation freezes the
    // public projection. Buffered observations still need normal validation.
    worker_observation: Option<Operation>,
    cancel: Option<mpsc::SyncSender<()>>,
    cancel_requested: bool,
    shutting_down: bool,
    requests: HashSet<String>,
    // Time held in the native run-limits ledger; settled before the run's
    // terminal state is published.
    reservation: Option<run_limits::Reservation>,
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
                artifact: None,
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
                reservation: None,
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
#[cfg_attr(test, derive(Clone, Serialize))]
#[serde(deny_unknown_fields)]
struct Start {
    schema_version: String,
    request_id: String,
    profile_id: String,
    task_id: String,
    // Required but nullable: only the strategy-less controlled task takes null.
    #[serde(deserialize_with = "nullable")]
    strategy_id: Option<String>,
    approved: bool,
    #[serde(default, deserialize_with = "present")]
    lease_context: Option<LeaseContext>,
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
        #[serde(default, deserialize_with = "present")]
        artifact: Option<Artifact>,
    },
}
fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(input).map(Some)
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
    fn package(&self, request: Cancel) -> Result<serde_json::Value, &'static str> {
        if request.schema_version != "1.0" || !uuid(&request.request_id) {
            return Err(DENIED);
        }
        let inner = self.inner.lock().map_err(|_| DENIED)?;
        let operation = inner.status.operation.as_ref().ok_or(DENIED)?;
        if operation.request_id != request.request_id
            || operation.revision != request.expected_revision
            || operation.phase != Phase::Finished
            || operation.outcome != Some(Outcome::Passed)
            || operation.cleanup != Cleanup::Verified
        {
            return Err(DENIED);
        }
        let lease = operation.lease_context.as_ref().ok_or(DENIED)?;
        let artifact = inner
            .artifact
            .as_ref()
            .filter(|artifact| artifact.valid(lease))
            .ok_or(DENIED)?;
        Ok(
            serde_json::json!({"schema_version":"1.0", "request_id": operation.request_id, "lease_id": artifact.lease_id,
            "sha256":artifact.sha256, "size_bytes":artifact.size_bytes, "bytes_base64":artifact.bytes_base64}),
        )
    }
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
        let strategy = strategy_id(task, request.strategy_id.as_deref()).ok_or(DENIED)?;
        if request
            .lease_context
            .as_ref()
            .is_some_and(|lease| !lease.valid(task, strategy))
        {
            return Err(DENIED);
        }
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
                    && operation.strategy_id == strategy
                    && operation.lease_context == request.lease_context
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
        let limits = if let Some(lease) = &request.lease_context {
            Limits {
                deadline: limits
                    .deadline
                    .min(lease.remaining().filter(|d| !d.is_zero()).ok_or(DENIED)?),
                grace: limits.grace,
            }
        } else {
            limits
        };
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
            strategy_id: strategy,
            lease_context: request.lease_context,
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
        inner.artifact = None;
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
            Self::settle(&mut inner, None);
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
    // Settle the run's reservation (when it belongs to this request) before
    // any terminal state becomes visible. Best effort and never fatal.
    fn settle(inner: &mut Inner, id: Option<&str>) {
        if inner
            .reservation
            .as_ref()
            .is_some_and(|held| id.is_none_or(|id| held.request_id() == id))
        {
            if let Some(held) = inner.reservation.take() {
                run_limits::settle(held, run_limits::now_ms().unwrap_or(0));
            }
        }
    }
    fn finish(&self, id: &str, mut end: End) {
        if let Ok(mut inner) = self.inner.lock() {
            Self::settle(&mut inner, Some(id));
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
                    if operation.outcome != Some(Outcome::Passed)
                        || operation.cleanup != Cleanup::Verified
                    {
                        inner.artifact = None;
                    }
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
                artifact,
            } if observation.phase == Phase::Cleaning => {
                if let Some(package) = &artifact {
                    if outcome != Outcome::Passed
                        || cleanup != Cleanup::Verified
                        || !observation
                            .lease_context
                            .as_ref()
                            .is_some_and(|lease| package.valid(lease))
                    {
                        return false;
                    }
                }
                if outcome == Outcome::Passed
                    && observation.lease_context.is_some()
                    && artifact.is_none()
                {
                    return false;
                }
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
                inner.artifact = artifact;
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
        // Hold the run's time in the native ledger before anything else: an
        // exhausted or unreadable budget never reaches resources or a worker.
        let allowed = match run_limits::now_ms()
            .ok_or("local_budget_unavailable")
            .and_then(|now| run_limits::reserve(&store, now, id, limits.deadline))
        {
            Ok((allowed, held)) => {
                if let Ok(mut inner) = self.inner.lock() {
                    inner.reservation = Some(held);
                }
                allowed
            }
            Err(code) => {
                self.finish(id, End::failed(code));
                return;
            }
        };
        let deadline = Instant::now() + limits.deadline.min(allowed);
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
        let mut boot = serde_json::json!({"type":"task_run_boot", "schema_version":"1.0", "request_id":operation.request_id, "profile_id":operation.profile_id, "provider":operation.provider, "task_id":operation.task_id, "strategy_id":operation.strategy_id, "journal_root":journal, "assets_root":assets, "profile_registry_root":registry});
        if let Some(lease) = &operation.lease_context {
            boot["lease_context"] = serde_json::to_value(lease).unwrap();
        }
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
    Package,
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
            "strategy_id",
            "approved",
        ],
        Shape::Cancel | Shape::Package => &["schema_version", "request_id", "expected_revision"],
        Shape::Status => return false,
    };
    let mut allowed_fields = fields.to_vec();
    if matches!(shape, Shape::Start) && wrapper["request"].get("lease_context").is_some() {
        allowed_fields.push("lease_context");
    }
    let Some(request) = exact_object(&wrapper["request"], &allowed_fields) else {
        return false;
    };
    request["schema_version"].as_str() == Some("1.0")
        && request["request_id"].as_str().is_some_and(uuid)
        && match shape {
            Shape::Start => {
                request["profile_id"].as_str().is_some_and(uuid)
                    && request["task_id"]
                        .as_str()
                        .and_then(task_id)
                        .is_some_and(|task| match &request["strategy_id"] {
                            serde_json::Value::Null => strategy_id(task, None).is_some(),
                            serde_json::Value::String(value) => {
                                strategy_id(task, Some(value)).is_some()
                            }
                            _ => false,
                        })
                    && request["approved"].as_bool() == Some(true)
                    && request.get("lease_context").is_none_or(|value| {
                        if !exact_object(
                            value,
                            &[
                                "lease_id",
                                "attempt_id",
                                "task_version",
                                "contract_hash",
                                "base_commit",
                                "strategy_id",
                                "time_limit_sec",
                                "expires_at_ms",
                            ],
                        )
                        .is_some()
                        {
                            return false;
                        }
                        serde_json::from_value::<LeaseContext>(value.clone())
                            .ok()
                            .is_some_and(|lease| {
                                lease.valid(
                                    request["task_id"].as_str().unwrap_or(""),
                                    request["strategy_id"].as_str(),
                                )
                            })
                    })
            }
            Shape::Cancel | Shape::Package => request["expected_revision"]
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
#[tauri::command]
pub(crate) async fn local_task_run_result_package<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    runs: State<'_, Arc<TaskRun>>,
) -> Result<serde_json::Value, &'static str> {
    let value: Wrapper<Cancel> = decode(&webview, request, Shape::Package)?;
    runs.package(value.request)
}

#[cfg(test)]
mod tests;
