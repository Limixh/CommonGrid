//! Narrow supervisor for one saved profile's managed CLI session. The webview
//! never supplies executable paths, runtime owners or arguments. A transient
//! Claude login code is accepted only for its matching active challenge.
use crate::{
    launcher::{node_name, resources, uuid},
    launcher_process::OwnedWorker,
    operation_journal::{self, OwnerHold},
    profile_binding::{self, Binding},
    profile_store::{self, Provider},
    task_run::TaskRun,
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

const DENIED: &str = "local_profile_session_denied";
const MAX_REVISION: u32 = 1_000_000_000;
const CANCEL_GRACE: Duration = Duration::from_secs(35);
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Action {
    Login,
    Status,
    Logout,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Starting,
    Preparing,
    Checking,
    WaitingForLogin,
    Cleaning,
    Finished,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Passed,
    Cancelled,
    Failed,
    NeedsReview,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SessionState {
    Unknown,
    Authenticated,
    Unauthenticated,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Cleanup {
    Pending,
    Verified,
    Unknown,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DeviceChallenge {
    verification_url: String,
    user_code: String,
}
impl DeviceChallenge {
    fn valid(&self) -> bool {
        self.verification_url == "https://auth.openai.com/codex/device"
            && (4..=32).contains(&self.user_code.len())
            && self
                .user_code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ClaudeChallenge {
    authorization_url: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
enum Challenge {
    Codex(DeviceChallenge),
    Claude(ClaudeChallenge),
}
fn base64url(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn claude_url_state(value: &str) -> Option<String> {
    if value.len() > 2048
        || !value.starts_with("https://claude.com/cai/oauth/authorize?")
        || value
            .bytes()
            .any(|byte| !byte.is_ascii() || byte <= b' ' || byte == 127 || byte == b'\\')
    {
        return None;
    }
    let url = tauri::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("claude.com")
        || url.path() != "/cai/oauth/authorize"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let pairs = url.query_pairs().collect::<Vec<_>>();
    let fields = [
        "code",
        "client_id",
        "response_type",
        "redirect_uri",
        "scope",
        "code_challenge",
        "code_challenge_method",
        "state",
    ];
    if pairs.len() != fields.len()
        || fields.iter().any(|field| {
            pairs
                .iter()
                .filter(|(key, _)| key.as_ref() == *field)
                .count()
                != 1
        })
    {
        return None;
    }
    let get = |key: &str| {
        pairs
            .iter()
            .find(|(field, _)| field.as_ref() == key)
            .map(|(_, value)| value.as_ref())
    };
    if get("code") != Some("true")
        || get("client_id") != Some("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
        || get("response_type") != Some("code")
        || get("redirect_uri") != Some("https://platform.claude.com/oauth/code/callback")
        || get("code_challenge_method") != Some("S256")
        || !get("code_challenge").is_some_and(base64url)
    {
        return None;
    }
    let scopes = get("scope")?.split(' ').collect::<Vec<_>>();
    let expected = [
        "org:create_api_key",
        "user:profile",
        "user:inference",
        "user:sessions:claude_code",
        "user:mcp_servers",
        "user:file_upload",
        "user:plugins",
    ];
    if scopes.len() != expected.len()
        || expected
            .iter()
            .any(|scope| scopes.iter().filter(|value| **value == *scope).count() != 1)
    {
        return None;
    }
    let state = get("state")?;
    base64url(state).then(|| state.to_owned())
}
fn claude_code_state(code: &str) -> Option<&str> {
    if code.len() > 2048 {
        return None;
    }
    let (authorization, state) = code.split_once('#')?;
    (!authorization.is_empty()
        && authorization
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && base64url(state))
    .then_some(state)
}
impl Challenge {
    fn valid_for(&self, provider: Provider) -> bool {
        match (self, provider) {
            (Self::Codex(challenge), Provider::Codex) => challenge.valid(),
            (Self::Claude(challenge), Provider::Claude) => {
                claude_url_state(&challenge.authorization_url).is_some()
            }
            _ => false,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Operation {
    request_id: String,
    profile_id: String,
    provider: Provider,
    action: Action,
    revision: u32,
    phase: Phase,
    outcome: Option<Outcome>,
    session_state: SessionState,
    challenge: Option<Challenge>,
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
    cancel_requested: bool,
    code_input: Option<mpsc::SyncSender<String>>,
    code_submitted: bool,
    shutting_down: bool,
    requests: HashSet<String>,
}
pub(crate) struct ProfileSession {
    inner: Mutex<Inner>,
    start_jobs: AtomicUsize,
    task_runs: OnceLock<Weak<TaskRun>>,
}
impl Default for ProfileSession {
    fn default() -> Self {
        Self {
            start_jobs: AtomicUsize::new(0),
            task_runs: OnceLock::new(),
            inner: Mutex::new(Inner {
                status: Status {
                    schema_version: "1.0",
                    availability: "available",
                    operation: None,
                },
                cancel: None,
                cancel_requested: false,
                code_input: None,
                code_submitted: false,
                shutting_down: false,
                requests: HashSet::new(),
            }),
        }
    }
}
struct StartSlot(Arc<ProfileSession>);
impl Drop for StartSlot {
    fn drop(&mut self) {
        self.0.start_jobs.fetch_sub(1, Ordering::AcqRel);
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Start {
    schema_version: String,
    request_id: String,
    profile_id: String,
    action: Action,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    schema_version: String,
    request_id: String,
    expected_revision: u32,
}
// Deliberately neither Debug nor Serialize: the submitted code is input only.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitCode {
    schema_version: String,
    request_id: String,
    expected_revision: u32,
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenClaude {
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
    #[serde(rename = "challenge")]
    Challenge { challenge: Challenge },
    #[serde(rename = "result")]
    Result {
        outcome: Outcome,
        session_state: SessionState,
        #[serde(deserialize_with = "nullable")]
        error_code: Option<String>,
        cleanup: Cleanup,
    },
}
fn nullable<'de, D: serde::Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(input)
}
fn code(value: &str) -> bool {
    [
        "asset_missing",
        "asset_invalid",
        "docker_unavailable",
        "image_missing",
        "profile_invalid",
        "profile_needs_review",
        "auth_required",
        "unsupported",
        "session_failed",
        "worker_failed",
        "cleanup_failed",
        "deadline_exceeded",
        "cancelled",
    ]
    .contains(&value)
}
fn valid_result(
    action: Action,
    outcome: Outcome,
    state: SessionState,
    error: &Option<String>,
    cleanup: Cleanup,
) -> bool {
    match outcome {
        Outcome::Passed => {
            cleanup == Cleanup::Verified
                && error.is_none()
                && match action {
                    Action::Login => state == SessionState::Authenticated,
                    Action::Logout => state == SessionState::Unauthenticated,
                    Action::Status => state != SessionState::Unknown,
                }
        }
        Outcome::Cancelled => {
            state == SessionState::Unknown
                && error.as_deref() == Some("cancelled")
                && cleanup == Cleanup::Verified
        }
        Outcome::Failed => {
            state == SessionState::Unknown
                && error.as_deref().is_some_and(code)
                && cleanup == Cleanup::Verified
        }
        Outcome::NeedsReview => {
            state == SessionState::Unknown
                && error.as_deref().is_some_and(code)
                && cleanup == Cleanup::Unknown
        }
    }
}
fn progress(current: Phase, next: Phase) -> bool {
    matches!(
        (current, next),
        (Phase::Starting, Phase::Preparing) | (Phase::Preparing, Phase::Checking)
    ) || (next == Phase::Cleaning && !matches!(current, Phase::Cleaning | Phase::Finished))
}
// The refusal a profile's durable state imposes before any session action:
// failed/verified for an invalid binding, needs_review/unknown otherwise. The
// mapping matches the task-run gate; both satisfy `valid_result`.
fn start_gate(
    store: &std::path::Path,
    operation: &Operation,
) -> Option<(Outcome, &'static str, Cleanup)> {
    let review = (
        Outcome::NeedsReview,
        "profile_needs_review",
        Cleanup::Unknown,
    );
    match profile_binding::read(store, &operation.profile_id, operation.provider) {
        // A first login (or the worker's own status/logout handling) proceeds.
        Binding::Absent => None,
        Binding::Invalid => Some((Outcome::Failed, "profile_invalid", Cleanup::Verified)),
        Binding::Reserved => Some(review),
        Binding::Ready(owner) => {
            let provider = match operation.provider {
                Provider::Claude => "claude",
                Provider::Codex => "codex",
            };
            // Same journal root the worker receives in its boot frame.
            (operation_journal::owner_hold(
                &store.join("managed-operation-journal"),
                &owner,
                provider,
            ) != OwnerHold::Clear)
                .then_some(review)
        }
    }
}
impl ProfileSession {
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
    pub(crate) fn link_task_run(&self, runs: Weak<TaskRun>) {
        let _ = self.task_runs.set(runs);
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
    pub(crate) fn start(
        self: &Arc<Self>,
        request: Start,
        root: PathBuf,
        store: PathBuf,
    ) -> Result<Status, &'static str> {
        if request.schema_version != "1.0"
            || !uuid(&request.request_id)
            || !uuid(&request.profile_id)
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
                    && operation.action == request.action
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
        // Checked while holding this lock; the task run checks the same way.
        if self
            .task_runs
            .get()
            .and_then(Weak::upgrade)
            .is_some_and(|runs| runs.active())
        {
            return Err(DENIED);
        }
        let operation = Operation {
            request_id: request.request_id,
            profile_id: request.profile_id,
            provider,
            action: request.action,
            revision: 0,
            phase: Phase::Starting,
            outcome: None,
            session_state: SessionState::Unknown,
            challenge: None,
            error_code: None,
            cleanup: Cleanup::Pending,
        };
        let (tx, rx) = mpsc::sync_channel(1);
        let (code_tx, code_rx) = mpsc::sync_channel(1);
        inner.requests.insert(operation.request_id.clone());
        inner.cancel = Some(tx);
        inner.cancel_requested = false;
        inner.code_input = Some(code_tx);
        inner.code_submitted = false;
        inner.status.operation = Some(operation.clone());
        let answer = inner.status.clone();
        drop(inner);
        let owner = Arc::clone(self);
        thread::spawn(move || owner.run(operation, root, store, rx, code_rx));
        Ok(answer)
    }
    fn request_cancel(inner: &mut Inner) {
        if inner.cancel.is_some() && !inner.cancel_requested {
            inner.cancel_requested = true;
            inner.code_input = None;
            if let Some(operation) = &mut inner.status.operation {
                operation.challenge = None;
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
    fn submit_code(&self, request: SubmitCode) -> Result<Status, &'static str> {
        if request.schema_version != "1.0"
            || !uuid(&request.request_id)
            || request.expected_revision > MAX_REVISION
        {
            return Err(DENIED);
        }
        let state = claude_code_state(&request.code).ok_or(DENIED)?;
        let mut inner = self.inner.lock().map_err(|_| DENIED)?;
        if inner.cancel_requested || inner.shutting_down || inner.code_submitted {
            return Err(DENIED);
        }
        let operation = inner.status.operation.as_ref().ok_or(DENIED)?;
        if operation.request_id != request.request_id
            || operation.revision != request.expected_revision
            || operation.provider != Provider::Claude
            || operation.action != Action::Login
            || operation.phase != Phase::WaitingForLogin
        {
            return Err(DENIED);
        }
        let Some(Challenge::Claude(challenge)) = operation.challenge.as_ref() else {
            return Err(DENIED);
        };
        if claude_url_state(&challenge.authorization_url).as_deref() != Some(state) {
            return Err(DENIED);
        }
        inner
            .code_input
            .as_ref()
            .ok_or(DENIED)?
            .try_send(request.code)
            .map_err(|_| DENIED)?;
        inner.code_submitted = true;
        let operation = inner.status.operation.as_mut().ok_or(DENIED)?;
        operation.challenge = None;
        operation.revision += 1;
        Ok(inner.status.clone())
    }
    fn claude_open_target(&self, request: &OpenClaude) -> Result<String, &'static str> {
        if request.schema_version != "1.0"
            || !uuid(&request.request_id)
            || request.expected_revision > MAX_REVISION
        {
            return Err(DENIED);
        }
        let inner = self.inner.lock().map_err(|_| DENIED)?;
        if inner.cancel_requested || inner.shutting_down {
            return Err(DENIED);
        }
        let operation = inner.status.operation.as_ref().ok_or(DENIED)?;
        if operation.request_id != request.request_id
            || operation.revision != request.expected_revision
            || operation.provider != Provider::Claude
            || operation.action != Action::Login
            || operation.phase != Phase::WaitingForLogin
        {
            return Err(DENIED);
        }
        let Some(Challenge::Claude(challenge)) = operation.challenge.as_ref() else {
            return Err(DENIED);
        };
        claude_url_state(&challenge.authorization_url).ok_or(DENIED)?;
        Ok(challenge.authorization_url.clone())
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
    fn can_open_device(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            !inner.cancel_requested
                && !inner.shutting_down
                && inner.status.operation.as_ref().is_some_and(|operation| {
                    operation.provider == Provider::Codex
                        && operation.action == Action::Login
                        && operation.phase == Phase::WaitingForLogin
                        && operation
                            .challenge
                            .as_ref()
                            .is_some_and(|challenge| challenge.valid_for(Provider::Codex))
                })
        })
    }
    pub fn force_review(&self) {
        if let Ok(mut inner) = self.inner.try_lock() {
            if let Some(operation) = &mut inner.status.operation {
                if operation.phase != Phase::Finished {
                    Self::terminal(
                        operation,
                        Outcome::NeedsReview,
                        SessionState::Unknown,
                        Some("cleanup_failed".into()),
                        Cleanup::Unknown,
                    );
                }
            }
            inner.cancel = None;
            inner.code_input = None;
        }
    }
    fn terminal(
        operation: &mut Operation,
        outcome: Outcome,
        state: SessionState,
        error: Option<String>,
        cleanup: Cleanup,
    ) {
        operation.revision += 1;
        operation.phase = Phase::Finished;
        operation.outcome = Some(outcome);
        operation.session_state = state;
        operation.challenge = None;
        operation.error_code = error;
        operation.cleanup = cleanup;
    }
    fn finish(
        &self,
        id: &str,
        outcome: Outcome,
        state: SessionState,
        error: Option<String>,
        cleanup: Cleanup,
    ) {
        if let Ok(mut inner) = self.inner.lock() {
            let cancelled = inner.cancel_requested
                && cleanup == Cleanup::Verified
                && error.as_deref() != Some("deadline_exceeded");
            if let Some(operation) = &mut inner.status.operation {
                if operation.request_id == id && operation.phase != Phase::Finished {
                    if cancelled {
                        Self::terminal(
                            operation,
                            Outcome::Cancelled,
                            SessionState::Unknown,
                            Some("cancelled".into()),
                            cleanup,
                        );
                    } else {
                        Self::terminal(operation, outcome, state, error, cleanup);
                    }
                    inner.cancel = None;
                    inner.code_input = None;
                }
            }
        }
    }
    // Mutate the current observation rather than replacing a worker snapshot:
    // cancellation's immediate revision bump and challenge clearing must survive.
    fn frame(
        &self,
        id: &str,
        frame: Frame,
        result: &mut Option<(Outcome, SessionState, Option<String>, Cleanup)>,
    ) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let cancelled = inner.cancel_requested;
        let code_submitted = inner.code_submitted;
        let Some(operation) = &mut inner.status.operation else {
            return false;
        };
        if operation.request_id != id || operation.phase == Phase::Finished {
            return false;
        }
        match frame {
            Frame::Progress { phase }
                if result.is_none()
                    && matches!(phase, Phase::Preparing | Phase::Checking | Phase::Cleaning) =>
            {
                if cancelled && phase != Phase::Cleaning {
                    return true;
                }
                if !progress(operation.phase, phase) {
                    return false;
                }
                operation.phase = phase;
                operation.challenge = None;
                operation.revision += 1;
                true
            }
            Frame::Challenge { challenge }
                if result.is_none()
                    && operation.action == Action::Login
                    && challenge.valid_for(operation.provider) =>
            {
                if cancelled {
                    return true;
                }
                if code_submitted {
                    return false;
                }
                if !matches!(operation.phase, Phase::Checking | Phase::WaitingForLogin) {
                    return false;
                }
                operation.phase = Phase::WaitingForLogin;
                operation.challenge = Some(challenge);
                operation.revision += 1;
                true
            }
            Frame::Result {
                outcome,
                session_state,
                error_code,
                cleanup,
            } if result.is_none()
                && operation.phase == Phase::Cleaning
                && valid_result(
                    operation.action,
                    outcome,
                    session_state,
                    &error_code,
                    cleanup,
                ) =>
            {
                *result = Some((outcome, session_state, error_code, cleanup));
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
        codes: mpsc::Receiver<String>,
    ) {
        let id = operation.request_id.as_str();
        // Native durable start gate (ADR 0025): decided before resources, a
        // worker or any boot frame exist. A binding whose runtime owner has
        // unresolved or unreadable durable operations never starts any action,
        // whichever process or restart left them behind.
        if let Some((outcome, error, cleanup)) = start_gate(&store, &operation) {
            self.finish(
                id,
                outcome,
                SessionState::Unknown,
                Some(error.into()),
                cleanup,
            );
            return;
        }
        let deadline = Instant::now()
            + Duration::from_secs(if operation.action == Action::Login {
                660
            } else {
                120
            });
        if !resources(&root) {
            let absent = [root.join("manifest.json"), root.join(node_name()), root.join("worker.mjs")].iter().any(|path| matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound));
            self.finish(
                id,
                Outcome::Failed,
                SessionState::Unknown,
                Some(
                    if absent {
                        "asset_missing"
                    } else {
                        "asset_invalid"
                    }
                    .into(),
                ),
                Cleanup::Verified,
            );
            return;
        }
        if cancel.try_recv().is_ok() {
            self.finish(
                id,
                Outcome::Cancelled,
                SessionState::Unknown,
                Some("cancelled".into()),
                Cleanup::Verified,
            );
            return;
        }
        if Instant::now() >= deadline {
            self.finish(
                id,
                Outcome::Failed,
                SessionState::Unknown,
                Some("deadline_exceeded".into()),
                Cleanup::Verified,
            );
            return;
        }
        let mut worker = match OwnedWorker::spawn(
            &root.join(node_name()),
            &root.join("worker.mjs"),
            &store.join("profile-session-worker-home"),
        ) {
            Ok(worker) => worker,
            Err(_) => {
                self.finish(
                    id,
                    Outcome::Failed,
                    SessionState::Unknown,
                    Some("worker_failed".into()),
                    Cleanup::Verified,
                );
                return;
            }
        };
        let mut input = worker.child.stdin.take().unwrap();
        let boot = serde_json::json!({"type":"profile_session_boot", "schema_version":"1.0", "request_id":operation.request_id, "profile_id":operation.profile_id, "provider":operation.provider, "action":operation.action, "journal_root":store.join("managed-operation-journal"), "assets_root":root.join("assets"), "profile_registry_root":store.join("managed-profiles")});
        if writeln!(input, "{}", boot).is_err() {
            worker.terminate();
            self.finish(
                id,
                Outcome::NeedsReview,
                SessionState::Unknown,
                Some("worker_failed".into()),
                Cleanup::Unknown,
            );
            return;
        }
        let (tx, rx) = mpsc::channel();
        let output = worker.child.stdout.take().unwrap();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            for _ in 0..128 {
                let mut line = Vec::new();
                match reader.by_ref().take(8193).read_until(b'\n', &mut line) {
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
                    // The cleanup grace is independent of the operation deadline.
                    cancellation = Some((Instant::now() + CANCEL_GRACE, reason));
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
            if cancellation.is_some() {
                while codes.try_recv().is_ok() {}
            } else if let Ok(code) = codes.try_recv() {
                // Serialize dispatch with cancellation. The bounded code is never
                // copied into public observations or durable journals.
                match self.inner.lock() {
                    Ok(inner)
                        if !inner.cancel_requested
                            && !inner.shutting_down
                            && inner.status.operation.as_ref().is_some_and(|current| {
                                current.request_id == id
                                    && current.provider == Provider::Claude
                                    && current.action == Action::Login
                                    && current.phase == Phase::WaitingForLogin
                            }) =>
                    {
                        let frame = serde_json::json!({"type":"claude_login_code", "request_id":id, "code":code});
                        if writeln!(input, "{}", frame).is_err() {
                            failure = Some("worker_failed");
                        }
                    }
                    Ok(_) => {}
                    Err(_) => failure = Some("worker_failed"),
                }
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
                        if let Some((mut outcome, mut state, mut error, cleanup)) = result {
                            // Catch a cancellation delivered between frame receipt
                            // and exit; authentication observations cannot survive it.
                            if cancellation.is_none() && cancel.try_recv().is_ok() {
                                cancellation = Some((Instant::now(), "cancelled"));
                            }
                            if let Some((_, reason)) = cancellation {
                                if cleanup == Cleanup::Verified {
                                    outcome = if reason == "cancelled" {
                                        Outcome::Cancelled
                                    } else {
                                        Outcome::Failed
                                    };
                                    state = SessionState::Unknown;
                                    error = Some(reason.into());
                                }
                            }
                            self.finish(id, outcome, state, error, cleanup);
                            return;
                        }
                    }
                    self.finish(
                        id,
                        Outcome::NeedsReview,
                        SessionState::Unknown,
                        Some("worker_failed".into()),
                        Cleanup::Unknown,
                    );
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
            Outcome::NeedsReview,
            SessionState::Unknown,
            Some(
                failure
                    .unwrap_or_else(|| {
                        cancellation
                            .map(|(_, reason)| reason)
                            .unwrap_or("worker_failed")
                    })
                    .into(),
            ),
            Cleanup::Unknown,
        );
    }
}

#[derive(Clone, Copy)]
enum Shape {
    Start,
    Status,
    Cancel,
    SubmitCode,
    OpenClaude,
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
        Shape::Start => &["schema_version", "request_id", "profile_id", "action"],
        Shape::Cancel => &["schema_version", "request_id", "expected_revision"],
        Shape::SubmitCode => &["schema_version", "request_id", "expected_revision", "code"],
        Shape::OpenClaude => &["schema_version", "request_id", "expected_revision"],
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
                    && matches!(
                        request["action"].as_str(),
                        Some("login" | "status" | "logout")
                    )
            }
            Shape::Cancel | Shape::OpenClaude => request["expected_revision"]
                .as_u64()
                .is_some_and(|revision| revision <= u64::from(MAX_REVISION)),
            Shape::SubmitCode => {
                request["expected_revision"]
                    .as_u64()
                    .is_some_and(|revision| revision <= u64::from(MAX_REVISION))
                    && request["code"]
                        .as_str()
                        .is_some_and(|code| claude_code_state(code).is_some())
            }
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
pub(crate) async fn local_profile_session_start<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
    sessions: State<'_, Arc<ProfileSession>>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Start> = decode(&webview, request, Shape::Start)?;
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| DENIED)?
        .join("launcher");
    let store = app.path().app_local_data_dir().map_err(|_| DENIED)?;
    let owner = Arc::clone(sessions.inner());
    let slot = owner.start_slot().ok_or(DENIED)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        owner.start(value.request, root, store)
    })
    .await
    .map_err(|_| DENIED)?
}
#[tauri::command]
pub(crate) async fn local_profile_session_status<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    sessions: State<'_, Arc<ProfileSession>>,
) -> Result<Status, &'static str> {
    let _: Empty = decode(&webview, request, Shape::Status)?;
    Ok(sessions.status())
}
#[tauri::command]
pub(crate) async fn local_profile_session_cancel<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    sessions: State<'_, Arc<ProfileSession>>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Cancel> = decode(&webview, request, Shape::Cancel)?;
    sessions.cancel(value.request)
}
#[tauri::command]
pub(crate) async fn local_profile_session_submit_code<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    sessions: State<'_, Arc<ProfileSession>>,
) -> Result<Status, &'static str> {
    let value: Wrapper<SubmitCode> = decode(&webview, request, Shape::SubmitCode)?;
    sessions.submit_code(value.request)
}
#[tauri::command]
pub(crate) async fn local_profile_session_open_claude<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    sessions: State<'_, Arc<ProfileSession>>,
) -> Result<bool, &'static str> {
    let value: Wrapper<OpenClaude> = decode(&webview, request, Shape::OpenClaude)?;
    let owner = Arc::clone(sessions.inner());
    // Resolve again in the native job so cancellation or a consumed challenge
    // invalidates a queued click. No caller-controlled URI reaches the opener.
    tauri::async_runtime::spawn_blocking(move || {
        let url = owner.claude_open_target(&value.request)?;
        Ok(open_login_page(&url))
    })
    .await
    .map_err(|_| DENIED)?
}
// All callers supply either the fixed Codex URL or a native-validated active
// official Claude challenge. The webview cannot supply a URI or arguments.
fn open_device_page() -> bool {
    open_login_page("https://auth.openai.com/codex/device")
}
fn open_login_page(target: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let operation = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let url = std::ffi::OsStr::new(target)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            ) as isize
                > 32
        }
    }
    #[cfg(not(windows))]
    {
        use std::process::{Command, Stdio};
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        match Command::new(opener)
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                thread::spawn(move || {
                    let _ = child.wait();
                });
                true
            }
            Err(_) => false,
        }
    }
}
#[tauri::command]
pub(crate) async fn local_profile_session_open_device<R: Runtime>(
    webview: Webview<R>,
    request: Request<'_>,
    sessions: State<'_, Arc<ProfileSession>>,
) -> Result<bool, &'static str> {
    let _: Empty = decode(&webview, request, Shape::Status)?;
    // Release the observation mutex before invoking the operating system.
    if !sessions.can_open_device() {
        return Err(DENIED);
    }
    tauri::async_runtime::spawn_blocking(open_device_page)
        .await
        .map_err(|_| DENIED)
}

#[cfg(test)]
mod tests;
