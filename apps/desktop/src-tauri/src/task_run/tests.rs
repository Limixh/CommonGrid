use super::*;
use crate::launcher::{digest, node_name};
use crate::launcher_process::regular;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
};
use tauri::{
    ipc::{CallbackFn, InvokeResponseBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindowBuilder,
};
const TASK_ID: &str = CONTROLLED_TASK;
const PATCH_HEADER: &str = "diff --git a/sum.mjs b/sum.mjs\n";
const SOFT_PATCH: &str = "diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -1 +1 @@\n-old\n+new\n";
const ID: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "33333333-3333-4333-8333-333333333333";
const PROFILE: &str = "22222222-2222-4222-8222-222222222222";
const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const H2: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const PATCH: &str =
    "diff --git a/sum.mjs b/sum.mjs\n--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-old\n+new\n";
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "cg-task-run-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
            ));
        fs::create_dir(&directory).unwrap();
        Self { directory }
    }
    fn registry(&self, provider: &str) {
        let root = self.directory.join("managed-profiles");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("profiles.json"), json!({"schema_version":"1.0", "revision":2, "profiles":[{"profile_id":PROFILE, "provider":provider, "name":"Fixture"}], "selected_profile_id":PROFILE}).to_string()).unwrap();
    }
    fn resources(&self, source: &str) -> PathBuf {
        let root = self.directory.join("launcher");
        fs::create_dir_all(&root).unwrap();
        let node = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/launcher")
            .join(node_name());
        assert!(
            regular(&node),
            "Prepare native launcher assets before native tests"
        );
        fs::copy(node, root.join(node_name())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join(node_name()), fs::Permissions::from_mode(0o700)).unwrap();
        }
        self.swap(&root, source);
        root
    }
    // Replace only the worker script, keeping the (large) copied runtime.
    fn swap(&self, root: &Path, source: &str) {
        fs::write(root.join("worker.mjs"), source).unwrap();
        fs::write(root.join("manifest.json"), json!({"schema_version":"1.0", "node_sha256":digest(&root.join(node_name())).unwrap(), "worker_sha256":digest(&root.join("worker.mjs")).unwrap()}).to_string()).unwrap();
    }
    fn home(&self) -> PathBuf {
        self.directory.join("task-run-worker-home")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match fs::remove_dir_all(&self.directory) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                Err(_) if thread::panicking() => break,
                Err(error) => panic!("synthetic fixture cleanup failed: {error}"),
            }
        }
    }
}
struct Owner(Arc<TaskRun>);
impl Owner {
    fn new() -> Self {
        Self(Arc::new(TaskRun::default()))
    }
}
impl std::ops::Deref for Owner {
    type Target = Arc<TaskRun>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.0.shutdown();
        let deadline = Instant::now() + Duration::from_secs(40);
        while self.0.active() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}
fn start(id: &str) -> Start {
    Start {
        schema_version: "1.0".into(),
        request_id: id.into(),
        profile_id: PROFILE.into(),
        task_id: TASK_ID.into(),
        approved: true,
    }
}
fn cancel(id: &str, revision: u32) -> Cancel {
    Cancel {
        schema_version: "1.0".into(),
        request_id: id.into(),
        expected_revision: revision,
    }
}
fn go(
    owner: &Arc<TaskRun>,
    fixture: &Fixture,
    root: &Path,
    id: &str,
) -> Result<Status, &'static str> {
    owner.start(start(id), root.to_path_buf(), fixture.directory.clone())
}
fn go_with(
    owner: &Arc<TaskRun>,
    fixture: &Fixture,
    root: &Path,
    limits: Limits,
) -> Result<Status, &'static str> {
    owner.admit(
        start(ID),
        root.to_path_buf(),
        fixture.directory.clone(),
        limits,
    )
}
fn until(owner: &TaskRun, what: &str, check: impl Fn(&Operation) -> bool) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(operation) = owner.status().operation {
            if check(&operation) {
                return operation;
            }
        }
        assert!(
            Instant::now() < deadline,
            "synthetic worker did not reach {what}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
fn wait(owner: &TaskRun, phase: Phase) -> Operation {
    until(owner, &format!("phase {phase:?}"), |operation| {
        operation.phase == phase
    })
}
fn value<T: Serialize>(item: &T) -> Value {
    serde_json::to_value(item).unwrap()
}
fn sample(owner: &Owner) -> thread::JoinHandle<Vec<Status>> {
    let owner = Arc::clone(&owner.0);
    thread::spawn(move || {
        let mut seen = Vec::new();
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            let status = owner.status();
            let finished = status
                .operation
                .as_ref()
                .is_some_and(|operation| operation.phase == Phase::Finished);
            seen.push(status);
            if finished || Instant::now() > end {
                return seen;
            }
            thread::sleep(Duration::from_millis(2));
        }
    })
}
// Every observation satisfies the public contract and only moves forward.
fn assert_monotone(seen: &[Status]) {
    for status in seen {
        assert!(valid_status(status), "{}", value(status));
    }
    for pair in seen.windows(2) {
        if let (Some(a), Some(b)) = (&pair[0].operation, &pair[1].operation) {
            assert!(b.revision >= a.revision);
            assert!(b.phase as u8 >= a.phase as u8);
            assert!(b.tool_calls >= a.tool_calls);
            if a.revision == b.revision {
                assert_eq!(value(a), value(b));
            }
        }
    }
}

const TEMPLATE: &str = r##"import{createInterface}from'node:readline';import path from'node:path';
const lines=createInterface({input:process.stdin});
const PROVIDER='__PROVIDER__',MODEL='__MODEL__';
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n'),raw=s=>process.stdout.write(s),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const H='0123456789abcdef'.repeat(4),H2='fedcba9876543210'.repeat(4);
const PATCH='diff --git a/sum.mjs b/sum.mjs\n--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-old\n+new\n';
const OK={verifier:{passed:true,cases:34,json_cases_passed:true,sparse_cases_passed:true},candidate_sha256:H,patch_sha256:H2,patch:PATCH};
const NO={verifier:{passed:false,cases:34,json_cases_passed:true,sparse_cases_passed:false},candidate_sha256:H,patch_sha256:null,patch:null};
const SPATCH='diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -1 +1 @@\n-old\n+new\n';
const SOK={verifier:{passed:true,cases:21,visible_tests_passed:true,hidden_cases_passed:true},candidate_sha256:H,patch_sha256:H2,patch:SPATCH};
const P=phase=>emit({type:'progress',phase}),A=tool_calls=>emit({type:'activity',tool_calls}),M=observed=>emit({type:'model',observed});
const R=(outcome,error_code,cleanup,result)=>emit({type:'result',outcome,error_code,cleanup,result});
const RUN=()=>{P('preparing');P('running');M(MODEL);A(1);A(3);P('verifying');P('cleaning');};
const CANCELLED=()=>new Promise(r=>{onCancel=r;});
let onCancel=()=>process.exit(3),booted=false;
async function main(){__BODY__}
lines.on('line',line=>{if(booted){if(line==='{"type":"cancel"}')onCancel();else process.exit(3);return;}booted=true;const b=JSON.parse(line);const keys=['type','schema_version','request_id','profile_id','provider','task_id','journal_root','assets_root','profile_registry_root'];if(Object.keys(b).sort().join()!==keys.sort().join()||b.type!=='task_run_boot'||b.schema_version!=='1.0'||b.provider!==PROVIDER||b.task_id!=='__TASK__'||path.basename(b.profile_registry_root)!=='managed-profiles'||path.basename(b.journal_root)!=='managed-operation-journal'||path.basename(b.assets_root)!=='assets'||path.basename(path.dirname(b.assets_root))!=='launcher')process.exit(2);main().then(()=>{lines.close();process.stdin.destroy();},()=>process.exit(4));});"##;
fn worker(provider: &str, body: &str) -> String {
    worker_for(provider, TASK_ID, body)
}
// The boot check inside the worker pins the task id the supervisor sends.
fn worker_for(provider: &str, task: &str, body: &str) -> String {
    let model = if provider == "codex" {
        "gpt-6-luna"
    } else {
        "claude-haiku-4-5"
    };
    TEMPLATE
        .replace("__TASK__", task)
        .replace("__PROVIDER__", provider)
        .replace("__MODEL__", model)
        .replace("__BODY__", body)
}
const PASS: &str = "console.error('PRIVATE_STDERR'.repeat(5000));P('preparing');await sleep(20);P('running');await sleep(20);M(MODEL);A(1);await sleep(20);A(3);await sleep(20);P('verifying');await sleep(20);P('cleaning');R('passed',null,'verified',OK);";
// Runs the worker to completion and returns the finished operation.
fn finished(fixture: &Fixture, root: &Path, body: &str, provider: &str) -> Operation {
    fixture.swap(root, &worker(provider, body));
    let owner = Owner::new();
    go(&owner, fixture, root, ID).unwrap();
    wait(&owner, Phase::Finished)
}
fn ok_result() -> Value {
    json!({"verifier":{"passed":true,"cases":34,"json_cases_passed":true,"sparse_cases_passed":true},"candidate_sha256":H,"patch_sha256":H2,"patch":PATCH})
}
fn no_result() -> Value {
    json!({"verifier":{"passed":false,"cases":34,"json_cases_passed":true,"sparse_cases_passed":false},"candidate_sha256":H,"patch_sha256":null,"patch":null})
}
fn result_frame(outcome: &str, error: Value, cleanup: &str, result: Value) -> Value {
    json!({"type":"result","outcome":outcome,"error_code":error,"cleanup":cleanup,"result":result})
}
fn operation(provider: Provider, phase: Phase) -> Operation {
    Operation {
        request_id: ID.into(),
        profile_id: PROFILE.into(),
        provider,
        task_id: TASK_ID,
        revision: 10,
        phase,
        outcome: None,
        error_code: None,
        cleanup: Cleanup::Pending,
        tool_calls: 0,
        model: Model {
            requested: requested_model(provider),
            observed: None,
        },
        result: None,
    }
}
fn primed(
    provider: Provider,
    phase: Phase,
    calls: u32,
    observed: Option<&str>,
) -> (TaskRun, mpsc::Receiver<()>) {
    let owner = TaskRun::default();
    let (tx, rx) = mpsc::sync_channel(1);
    {
        let mut inner = owner.inner.lock().unwrap();
        inner.cancel = Some(tx);
        let mut current = operation(provider, phase);
        current.tool_calls = calls;
        current.model.observed = observed.map(Into::into);
        inner.status.operation = Some(current);
    }
    (owner, rx)
}
fn current(owner: &TaskRun) -> Operation {
    owner.status().operation.unwrap()
}
fn feed(owner: &TaskRun, frame: &Value, result: &mut Option<End>) -> bool {
    match serde_json::from_slice::<Frame>(frame.to_string().as_bytes()) {
        Ok(frame) => owner.frame(ID, frame, result),
        Err(_) => false,
    }
}
// One frame against a worker snapshot: rejected frames change nothing.
fn check(
    provider: Provider,
    phase: Phase,
    calls: u32,
    observed: Option<&str>,
    frame: Value,
    accepted: bool,
) {
    let (owner, _rx) = primed(provider, phase, calls, observed);
    let before = value(&current(&owner));
    let mut result = None;
    assert_eq!(
        feed(&owner, &frame, &mut result),
        accepted,
        "{phase:?} {frame}"
    );
    let after = current(&owner);
    assert!(
        phase == Phase::Finished || valid_operation(&after),
        "{}",
        value(&after)
    );
    if !accepted {
        assert_eq!(value(&after), before);
        assert!(result.is_none());
    }
}
fn codex_cleaning(frame: Value, accepted: bool) {
    check(
        Provider::Codex,
        Phase::Cleaning,
        3,
        Some("gpt-6-luna"),
        frame,
        accepted,
    );
}
fn progress_frame(phase: &str) -> Value {
    json!({"type":"progress","phase":phase})
}
fn patch_of(extra: &str) -> Value {
    let mut result = ok_result();
    result["patch"] = json!(format!("{PATCH}{extra}"));
    result
}
fn soft_ok_result() -> Value {
    json!({"verifier":{"passed":true,"cases":21,"visible_tests_passed":true,"hidden_cases_passed":true},"candidate_sha256":H,"patch_sha256":H2,"patch":SOFT_PATCH})
}
fn soft_no_result() -> Value {
    json!({"verifier":{"passed":false,"cases":21,"visible_tests_passed":true,"hidden_cases_passed":false},"candidate_sha256":H,"patch_sha256":null,"patch":null})
}
// Mutable view of the controlled verifier a test result is known to carry.
fn ctl(result: &mut TaskResult) -> &mut ControlledVerifier {
    match &mut result.verifier {
        Verifier::Controlled(verifier) => verifier,
        Verifier::Software(_) => panic!("software verifier"),
    }
}
fn go_task(
    owner: &Arc<TaskRun>,
    fixture: &Fixture,
    root: &Path,
    id: &str,
    task: &str,
) -> Result<Status, &'static str> {
    owner.start(
        Start {
            task_id: task.into(),
            ..start(id)
        },
        root.to_path_buf(),
        fixture.directory.clone(),
    )
}
// One result frame against a Cleaning-phase software task snapshot.
fn soft_cleaning(frame: Value, accepted: bool) {
    let (owner, _rx) = primed(Provider::Codex, Phase::Cleaning, 3, Some("gpt-6-luna"));
    owner
        .inner
        .lock()
        .unwrap()
        .status
        .operation
        .as_mut()
        .unwrap()
        .task_id = SOFTWARE_TASK;
    let mut result = None;
    assert_eq!(feed(&owner, &frame, &mut result), accepted, "{frame}");
    assert_eq!(result.is_some(), accepted, "{frame}");
}

#[test]
fn exact_preflight_rejects_nested_large_and_caller_owned_inputs() {
    let valid = json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"task_id":TASK_ID,"approved":true}});
    assert!(preflight(&valid, Shape::Start));
    assert!(preflight(&json!({}), Shape::Status));
    let with = |field: &str, replacement: Value| {
        let mut request = valid["request"].clone();
        request[field] = replacement;
        json!({"request":request})
    };
    for value in [
        with("approved", json!(false)),
        with("approved", json!("true")),
        with("approved", json!(1)),
        with("approved", json!(null)),
        with("task_id", json!("controlled-sum-integers-v2")),
        with("task_id", json!("")),
        with("task_id", json!(["controlled-sum-integers-v1"])),
        with("profile_id", json!("x".repeat(100000))),
        with("profile_id", json!("22222222-2222-1222-8222-222222222222")),
        with("request_id", json!({"private":"nested"})),
        with("schema_version", json!("1.1")),
        with("prompt", json!("write code")),
        with("model", json!("opus")),
        with("provider", json!("codex")),
        with("path", json!("C:/private")),
        json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"task_id":TASK_ID}}),
        json!({"request":valid,"path":"private"}),
        json!({"request":null}),
        json!(null),
    ] {
        assert!(!preflight(&value, Shape::Start), "{value}");
    }
    assert!(preflight(
        &json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":0}}),
        Shape::Cancel
    ));
    for value in [
        json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":-1}}),
        json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":1.5}}),
        json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":"1"}}),
        json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":1000000001u64}}),
        json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":0,"force":true}}),
        json!({"request":{"schema_version":"1.0","request_id":"nope","expected_revision":0}}),
    ] {
        assert!(!preflight(&value, Shape::Cancel), "{value}");
    }
    assert!(!preflight(
        &json!({"url":"https://example.invalid"}),
        Shape::Status
    ));
}

#[test]
fn patch_contract_matches_the_browser_validator() {
    assert!(valid_patch(PATCH, TASK_ID));
    assert!(valid_patch(
        &format!("{PATCH}é漢\u{2029}\u{2060}\u{202f}\u{2065}\u{206a}\t"),
        TASK_ID
    ));
    let exact = format!(
        "{PATCH_HEADER}{}",
        "a".repeat(MAX_PATCH_BYTES - PATCH_HEADER.len())
    );
    assert_eq!(exact.len(), MAX_PATCH_BYTES);
    assert!(valid_patch(&exact, TASK_ID));
    assert!(!valid_patch(&format!("{exact}a"), TASK_ID));
    // Bytes, not characters: a three-byte character crosses the limit.
    assert!(!valid_patch(
        &format!(
            "{PATCH_HEADER}{}漢",
            "a".repeat(MAX_PATCH_BYTES - PATCH_HEADER.len() - 2)
        ),
        TASK_ID
    ));
    for bad in [
        String::new(),
        "diff --git a/sum.mjs b/sum.mjs".to_string(),
        format!(" {PATCH}"),
        format!("\n{PATCH}"),
        PATCH.replace("diff --git", "diff --cc"),
        "diff --git a/sum.mjs b/sum.mjs\r\n+x\n".to_string(),
        "--- a/sum.mjs\n+++ b/sum.mjs\n".to_string(),
        "diff --git a/other.mjs b/other.mjs\n+x\n".to_string(),
        format!("{PATCH}\0"),
        format!("{PATCH}\r"),
        format!("{PATCH}\u{202a}"),
        format!("{PATCH}\u{202b}"),
        format!("{PATCH}\u{202c}"),
        format!("{PATCH}\u{202d}"),
        format!("{PATCH}\u{202e}"),
        format!("{PATCH}\u{2066}"),
        format!("{PATCH}\u{2067}"),
        format!("{PATCH}\u{2068}"),
        format!("{PATCH}\u{2069}"),
    ] {
        assert!(!valid_patch(&bad, TASK_ID), "{bad:?}");
    }
}

#[test]
fn result_and_operation_contracts_fail_closed() {
    let good: TaskResult = serde_json::from_value(ok_result()).unwrap();
    let rejected: TaskResult = serde_json::from_value(no_result()).unwrap();
    assert!(good.valid(Outcome::Passed, TASK_ID) && !good.valid(Outcome::Rejected, TASK_ID));
    assert!(
        rejected.valid(Outcome::Rejected, TASK_ID) && !rejected.valid(Outcome::Passed, TASK_ID)
    );
    for outcome in [Outcome::Cancelled, Outcome::Failed, Outcome::NeedsReview] {
        assert!(!good.valid(outcome, TASK_ID) && !rejected.valid(outcome, TASK_ID));
    }
    let mutate = |change: &dyn Fn(&mut TaskResult)| {
        let mut copy = good.clone();
        change(&mut copy);
        copy
    };
    for broken in [
        mutate(&|r| r.candidate_sha256 = H.to_uppercase()),
        mutate(&|r| r.candidate_sha256 = H[1..].into()),
        mutate(&|r| r.patch_sha256 = Some(format!("{H2}0"))),
        mutate(&|r| r.patch_sha256 = None),
        mutate(&|r| r.patch = None),
        mutate(&|r| r.patch = Some("x".into())),
        mutate(&|r| ctl(r).cases = 0),
        mutate(&|r| ctl(r).cases = 1001),
        mutate(&|r| ctl(r).sparse_cases_passed = false),
        mutate(&|r| ctl(r).passed = false),
    ] {
        assert!(!broken.valid(Outcome::Passed, TASK_ID));
    }
    assert!(mutate(&|r| ctl(r).cases = 1).valid(Outcome::Passed, TASK_ID));
    assert!(mutate(&|r| ctl(r).cases = 1000).valid(Outcome::Passed, TASK_ID));
    let mut inconsistent = rejected.clone();
    ctl(&mut inconsistent).passed = true;
    assert!(!inconsistent.valid(Outcome::Rejected, TASK_ID));
    let mut both = rejected.clone();
    ctl(&mut both).sparse_cases_passed = true;
    assert!(!both.valid(Outcome::Rejected, TASK_ID));
    let mut leaked = rejected.clone();
    leaked.patch = Some(PATCH.into());
    assert!(!leaked.valid(Outcome::Rejected, TASK_ID));
    let mut neither = rejected.clone();
    ctl(&mut neither).json_cases_passed = false;
    assert!(neither.valid(Outcome::Rejected, TASK_ID));

    // Operation-level rules.
    let mut passed = operation(Provider::Codex, Phase::Finished);
    passed.outcome = Some(Outcome::Passed);
    passed.cleanup = Cleanup::Verified;
    passed.tool_calls = 3;
    passed.model.observed = Some("gpt-6-luna".into());
    passed.result = Some(good.clone());
    assert!(valid_operation(&passed));
    for broken in [
        {
            let mut o = passed.clone();
            o.tool_calls = 0;
            o
        },
        {
            let mut o = passed.clone();
            o.model.observed = None;
            o
        },
        {
            let mut o = passed.clone();
            o.model.observed = Some("claude-haiku-4-5".into());
            o
        },
        {
            let mut o = passed.clone();
            o.cleanup = Cleanup::Unknown;
            o
        },
        {
            let mut o = passed.clone();
            o.error_code = Some("candidate_rejected".into());
            o
        },
        {
            let mut o = passed.clone();
            o.result = None;
            o
        },
        {
            let mut o = passed.clone();
            o.model.requested = "gpt-6.1-sol";
            o
        },
        {
            let mut o = passed.clone();
            o.tool_calls = 17;
            o
        },
        {
            let mut o = passed.clone();
            o.revision = MAX_REVISION + 1;
            o
        },
        {
            let mut o = passed.clone();
            o.request_id = "nope".into();
            o
        },
    ] {
        assert!(!valid_operation(&broken), "{}", value(&broken));
    }
    let mut max = passed.clone();
    (max.revision, max.tool_calls) = (MAX_REVISION, MAX_TOOL_CALLS);
    assert!(valid_operation(&max));
    let mut claude = passed.clone();
    (claude.provider, claude.model) = (
        Provider::Claude,
        Model {
            requested: "haiku",
            observed: Some("claude-haiku-5-5".into()),
        },
    );
    assert!(valid_operation(&claude));
    claude.model.observed = Some("gpt-6-luna".into());
    assert!(!valid_operation(&claude));
    let mut refused = operation(Provider::Codex, Phase::Finished);
    refused.outcome = Some(Outcome::Rejected);
    refused.cleanup = Cleanup::Verified;
    refused.tool_calls = 1;
    refused.model.observed = Some("gpt-6-luna".into());
    refused.error_code = Some("candidate_rejected".into());
    refused.result = Some(rejected);
    assert!(valid_operation(&refused));
    refused.error_code = None;
    assert!(!valid_operation(&refused));
    for (outcome, error, cleanup, accepted) in [
        (
            Outcome::Failed,
            Some("provider_failed"),
            Cleanup::Verified,
            true,
        ),
        (Outcome::Failed, Some("cancelled"), Cleanup::Verified, false),
        (
            Outcome::Failed,
            Some("candidate_rejected"),
            Cleanup::Verified,
            false,
        ),
        (Outcome::Failed, None, Cleanup::Verified, false),
        (
            Outcome::Failed,
            Some("provider_failed"),
            Cleanup::Unknown,
            false,
        ),
        (Outcome::Failed, Some("PRIVATE"), Cleanup::Verified, false),
        (
            Outcome::Cancelled,
            Some("cancelled"),
            Cleanup::Verified,
            true,
        ),
        (
            Outcome::Cancelled,
            Some("worker_failed"),
            Cleanup::Verified,
            false,
        ),
        (
            Outcome::Cancelled,
            Some("cancelled"),
            Cleanup::Unknown,
            false,
        ),
        (
            Outcome::NeedsReview,
            Some("worker_failed"),
            Cleanup::Unknown,
            true,
        ),
        (
            Outcome::NeedsReview,
            Some("deadline_exceeded"),
            Cleanup::Unknown,
            true,
        ),
        (
            Outcome::NeedsReview,
            Some("cancelled"),
            Cleanup::Unknown,
            false,
        ),
        (
            Outcome::NeedsReview,
            Some("worker_failed"),
            Cleanup::Verified,
            false,
        ),
        (
            Outcome::NeedsReview,
            Some("worker_failed"),
            Cleanup::Pending,
            false,
        ),
    ] {
        let mut op = operation(Provider::Claude, Phase::Finished);
        (op.outcome, op.error_code, op.cleanup) = (Some(outcome), error.map(Into::into), cleanup);
        assert_eq!(
            valid_operation(&op),
            accepted,
            "{outcome:?} {error:?} {cleanup:?}"
        );
    }
    // Unfinished phases carry no outcome, error, result or cleanup claim.
    assert!(valid_operation(&operation(
        Provider::Codex,
        Phase::Starting
    )));
    for phase in [
        Phase::Starting,
        Phase::Preparing,
        Phase::Running,
        Phase::Verifying,
        Phase::Cleaning,
    ] {
        for broken in [
            {
                let mut o = operation(Provider::Codex, phase);
                o.outcome = Some(Outcome::Failed);
                o
            },
            {
                let mut o = operation(Provider::Codex, phase);
                o.error_code = Some("worker_failed".into());
                o
            },
            {
                let mut o = operation(Provider::Codex, phase);
                o.cleanup = Cleanup::Verified;
                o
            },
            {
                let mut o = operation(Provider::Codex, phase);
                o.result = Some(good.clone());
                o
            },
        ] {
            assert!(!valid_operation(&broken));
        }
    }
    let mut early = operation(Provider::Codex, Phase::Starting);
    early.tool_calls = 1;
    assert!(!valid_operation(&early));
    early.tool_calls = 0;
    early.model.observed = Some("gpt-6-luna".into());
    assert!(!valid_operation(&early));
    early.phase = Phase::Preparing;
    assert!(valid_operation(&early));
    // Unknown wire fields and missing nullable keys never deserialize.
    assert!(serde_json::from_value::<Frame>(result_frame(
        "failed",
        json!("worker_failed"),
        "verified",
        json!(null)
    ))
    .is_ok());
    for frame in [
        json!({"type":"result","outcome":"failed","error_code":"worker_failed","cleanup":"verified"}),
        json!({"type":"result","outcome":"failed","cleanup":"verified","result":null}),
        json!({"type":"result","outcome":"failed","error_code":"worker_failed","cleanup":"verified","result":null,"extra":1}),
        json!({"type":"result","outcome":"finished","error_code":null,"cleanup":"verified","result":null}),
        json!({"type":"progress","phase":"running","extra":true}),
        json!({"type":"activity","tool_calls":-1}),
        json!({"type":"activity","tool_calls":1.5}),
        json!({"type":"activity","tool_calls":"1"}),
        json!({"type":"model"}),
        json!({"type":"shell","command":"id"}),
        json!({"phase":"running"}),
    ] {
        assert!(
            serde_json::from_value::<Frame>(frame.clone()).is_err(),
            "{frame}"
        );
    }
    for frame in [
        result_frame("passed", json!(null), "verified", {
            let mut r = ok_result();
            r["extra"] = json!(1);
            r
        }),
        result_frame("passed", json!(null), "verified", {
            let mut r = ok_result();
            r["verifier"]["extra"] = json!(1);
            r
        }),
        result_frame("passed", json!(null), "verified", {
            let mut r = ok_result();
            r.as_object_mut().unwrap().remove("patch_sha256");
            r
        }),
        result_frame("rejected", json!("candidate_rejected"), "verified", {
            let mut r = no_result();
            r["verifier"]["cases"] = json!(-1);
            r
        }),
        result_frame("rejected", json!("candidate_rejected"), "verified", {
            let mut r = no_result();
            r["verifier"]["cases"] = json!(1.5);
            r
        }),
        result_frame("rejected", json!("candidate_rejected"), "verified", {
            let mut r = no_result();
            r["verifier"]["passed"] = json!(0);
            r
        }),
    ] {
        assert!(
            serde_json::from_value::<Frame>(frame.clone()).is_err(),
            "{frame}"
        );
    }
    assert!(serde_json::from_str::<Frame>(
        r#"{"type":"progress","phase":"preparing","phase":"running"}"#
    )
    .is_err());
}

#[test]
fn phases_and_observations_only_move_forward() {
    let codex = Provider::Codex;
    let luna = Some("gpt-6-luna");
    for (phase, next, accepted) in [
        (Phase::Starting, "preparing", true),
        (Phase::Starting, "running", false),
        (Phase::Starting, "cleaning", true),
        (Phase::Preparing, "running", true),
        (Phase::Preparing, "verifying", false),
        (Phase::Preparing, "cleaning", true),
        (Phase::Preparing, "preparing", false),
        (Phase::Running, "verifying", true),
        (Phase::Running, "cleaning", true),
        (Phase::Running, "running", false),
        (Phase::Running, "preparing", false),
        (Phase::Verifying, "cleaning", true),
        (Phase::Verifying, "running", false),
        (Phase::Verifying, "verifying", false),
        (Phase::Cleaning, "cleaning", false),
        (Phase::Cleaning, "verifying", false),
        (Phase::Running, "finished", false),
        (Phase::Running, "starting", false),
        (Phase::Finished, "cleaning", false),
    ] {
        check(codex, phase, 0, None, progress_frame(next), accepted);
    }
    for (phase, accepted) in [
        (Phase::Starting, false),
        (Phase::Preparing, false),
        (Phase::Running, true),
        (Phase::Verifying, true),
        (Phase::Cleaning, false),
    ] {
        check(
            codex,
            phase,
            0,
            None,
            json!({"type":"activity","tool_calls":1}),
            accepted,
        );
        check(
            codex,
            phase,
            0,
            None,
            json!({"type":"model","observed":"gpt-6-luna"}),
            accepted,
        );
    }
    for (calls, next, accepted) in [
        (0, 0, true),
        (0, 1, true),
        (0, 16, true),
        (0, 17, false),
        (3, 2, false),
        (3, 3, true),
        (3, 4, true),
        (16, 16, true),
        (16, 17, false),
        (3, 0, false),
        (0, 1000, false),
    ] {
        check(
            codex,
            Phase::Running,
            calls,
            None,
            json!({"type":"activity","tool_calls":next}),
            accepted,
        );
    }
    for (provider, observed, next, accepted) in [
        (codex, None, "gpt-6-luna", true),
        (codex, None, "gpt-6.1-sol", false),
        (codex, None, "GPT-6-LUNA", false),
        (codex, None, "", false),
        (codex, None, "claude-haiku-4-5", false),
        (codex, luna, "gpt-6-luna", true),
        (Provider::Claude, None, "claude-haiku-4-5-20251001", true),
        (Provider::Claude, None, "claude-haiku-4-5", true),
        (Provider::Claude, None, "claude-haiku-5-5", true),
        (Provider::Claude, None, "claude-haiku-3", false),
        (Provider::Claude, None, "haiku", false),
        (Provider::Claude, None, "claude-sonnet-4-5", false),
        (Provider::Claude, None, "gpt-6-luna", false),
        (
            Provider::Claude,
            Some("claude-haiku-4-5"),
            "claude-haiku-4-5",
            true,
        ),
        (
            Provider::Claude,
            Some("claude-haiku-4-5"),
            "claude-haiku-5-5",
            false,
        ),
        (
            Provider::Claude,
            Some("claude-haiku-5-5"),
            "claude-haiku-4-5-20251001",
            false,
        ),
    ] {
        check(
            provider,
            Phase::Running,
            1,
            observed,
            json!({"type":"model","observed":next}),
            accepted,
        );
    }
    // Accepted observations bump the revision exactly when they change state.
    let (owner, _rx) = primed(codex, Phase::Running, 0, None);
    let mut none = None;
    for (frame, revision) in [
        (json!({"type":"activity","tool_calls":0}), 10),
        (json!({"type":"activity","tool_calls":2}), 11),
        (json!({"type":"activity","tool_calls":2}), 11),
        (json!({"type":"model","observed":"gpt-6-luna"}), 12),
        (json!({"type":"model","observed":"gpt-6-luna"}), 12),
        (progress_frame("verifying"), 13),
    ] {
        assert!(feed(&owner, &frame, &mut none));
        assert_eq!(current(&owner).revision, revision, "{frame}");
    }
    assert!(!feed(
        &owner,
        &json!({"type":"activity","tool_calls":1}),
        &mut none
    ));
    assert_eq!(current(&owner).tool_calls, 2);
}

#[test]
fn result_frames_are_accepted_only_when_the_public_status_would_be_valid() {
    let patch_only = |patch: &str| {
        let mut r = ok_result();
        r["patch"] = json!(patch);
        r
    };
    let with = |base: Value, path: &[&str], replacement: Value| {
        let mut base = base;
        let mut node = &mut base;
        for key in path {
            node = &mut node[*key];
        }
        *node = replacement;
        base
    };
    // Verified outcomes.
    codex_cleaning(
        result_frame("passed", json!(null), "verified", ok_result()),
        true,
    );
    codex_cleaning(
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            no_result(),
        ),
        true,
    );
    codex_cleaning(
        result_frame("cancelled", json!("cancelled"), "verified", json!(null)),
        true,
    );
    for error in [
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
        "verifier_failed",
        "worker_failed",
        "cleanup_failed",
        "deadline_exceeded",
    ] {
        codex_cleaning(
            result_frame("failed", json!(error), "verified", json!(null)),
            true,
        );
        codex_cleaning(
            result_frame("needs_review", json!(error), "unknown", json!(null)),
            true,
        );
    }
    // Failures need neither a model nor tool calls.
    check(
        Provider::Codex,
        Phase::Cleaning,
        0,
        None,
        result_frame(
            "failed",
            json!("model_unavailable"),
            "verified",
            json!(null),
        ),
        true,
    );
    check(
        Provider::Claude,
        Phase::Cleaning,
        0,
        None,
        result_frame("cancelled", json!("cancelled"), "verified", json!(null)),
        true,
    );
    // Passed and rejected need an observed model and at least one tool call.
    for (calls, observed) in [(0, Some("gpt-6-luna")), (3, None), (0, None)] {
        check(
            Provider::Codex,
            Phase::Cleaning,
            calls,
            observed,
            result_frame("passed", json!(null), "verified", ok_result()),
            false,
        );
        check(
            Provider::Codex,
            Phase::Cleaning,
            calls,
            observed,
            result_frame(
                "rejected",
                json!("candidate_rejected"),
                "verified",
                no_result(),
            ),
            false,
        );
    }
    check(
        Provider::Claude,
        Phase::Cleaning,
        1,
        Some("claude-haiku-5-5"),
        result_frame("passed", json!(null), "verified", ok_result()),
        true,
    );
    for phase in [
        Phase::Starting,
        Phase::Preparing,
        Phase::Running,
        Phase::Verifying,
    ] {
        let (calls, observed) = if phase == Phase::Starting {
            (0, None)
        } else {
            (3, Some("gpt-6-luna"))
        };
        check(
            Provider::Codex,
            phase,
            calls,
            observed,
            result_frame("failed", json!("worker_failed"), "verified", json!(null)),
            false,
        );
    }
    for frame in [
        result_frame("passed", json!("worker_failed"), "verified", ok_result()),
        result_frame(
            "passed",
            json!("candidate_rejected"),
            "verified",
            ok_result(),
        ),
        result_frame("passed", json!(null), "unknown", ok_result()),
        result_frame("passed", json!(null), "pending", ok_result()),
        result_frame("passed", json!(null), "verified", json!(null)),
        result_frame("passed", json!(null), "verified", no_result()),
        result_frame("rejected", json!(null), "verified", no_result()),
        result_frame("rejected", json!("worker_failed"), "verified", no_result()),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            ok_result(),
        ),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            json!(null),
        ),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "unknown",
            no_result(),
        ),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            with(no_result(), &["patch"], json!(PATCH)),
        ),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            with(no_result(), &["patch_sha256"], json!(H2)),
        ),
        result_frame("cancelled", json!("worker_failed"), "verified", json!(null)),
        result_frame("cancelled", json!(null), "verified", json!(null)),
        result_frame("cancelled", json!("cancelled"), "unknown", json!(null)),
        result_frame("cancelled", json!("cancelled"), "verified", ok_result()),
        result_frame("failed", json!(null), "verified", json!(null)),
        result_frame(
            "failed",
            json!("candidate_rejected"),
            "verified",
            json!(null),
        ),
        result_frame("failed", json!("cancelled"), "verified", json!(null)),
        result_frame("failed", json!("PRIVATE_SECRET"), "verified", json!(null)),
        result_frame("failed", json!("provider_failed"), "unknown", json!(null)),
        result_frame("failed", json!("provider_failed"), "pending", json!(null)),
        result_frame("failed", json!("provider_failed"), "verified", ok_result()),
        result_frame("needs_review", json!(null), "unknown", json!(null)),
        result_frame("needs_review", json!("cancelled"), "unknown", json!(null)),
        result_frame(
            "needs_review",
            json!("candidate_rejected"),
            "unknown",
            json!(null),
        ),
        result_frame(
            "needs_review",
            json!("worker_failed"),
            "verified",
            json!(null),
        ),
        result_frame(
            "needs_review",
            json!("worker_failed"),
            "unknown",
            ok_result(),
        ),
        // Verifier and digest rules.
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(
                ok_result(),
                &["verifier", "sparse_cases_passed"],
                json!(false),
            ),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["verifier", "passed"], json!(false)),
        ),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            with(no_result(), &["verifier", "passed"], json!(true)),
        ),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            with(
                no_result(),
                &["verifier", "sparse_cases_passed"],
                json!(true),
            ),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["verifier", "cases"], json!(0)),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["verifier", "cases"], json!(1001)),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["candidate_sha256"], json!(H.to_uppercase())),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["candidate_sha256"], json!(&H[..63])),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(
                ok_result(),
                &["patch_sha256"],
                json!(format!("{}g", &H2[..63])),
            ),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["patch_sha256"], json!(null)),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["patch"], json!(null)),
        ),
        // Patch rules.
        result_frame("passed", json!(null), "verified", patch_only("")),
        result_frame(
            "passed",
            json!(null),
            "verified",
            patch_only("--- a/sum.mjs\n"),
        ),
        result_frame("passed", json!(null), "verified", patch_of("\r")),
        result_frame("passed", json!(null), "verified", patch_of("\u{0}")),
        result_frame("passed", json!(null), "verified", patch_of("\u{202a}")),
        result_frame("passed", json!(null), "verified", patch_of("\u{202e}")),
        result_frame("passed", json!(null), "verified", patch_of("\u{2066}")),
        result_frame("passed", json!(null), "verified", patch_of("\u{2069}")),
        result_frame(
            "passed",
            json!(null),
            "verified",
            patch_of(&"x".repeat(MAX_PATCH_BYTES)),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            patch_only("diff --git a/sum.mjs b/sum.mjs\r\n+x\n"),
        ),
    ] {
        codex_cleaning(frame, false);
    }
    for good in [
        result_frame(
            "passed",
            json!(null),
            "verified",
            patch_only(&format!(
                "{PATCH_HEADER}{}",
                "a".repeat(MAX_PATCH_BYTES - PATCH_HEADER.len())
            )),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            patch_of("é\u{202f}\u{2065}\u{206a}"),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["verifier", "cases"], json!(1)),
        ),
        result_frame(
            "passed",
            json!(null),
            "verified",
            with(ok_result(), &["verifier", "cases"], json!(1000)),
        ),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            with(
                with(
                    no_result(),
                    &["verifier", "json_cases_passed"],
                    json!(false),
                ),
                &["verifier", "passed"],
                json!(false),
            ),
        ),
    ] {
        codex_cleaning(good, true);
    }
    // Status JSON is bounded: a patch that is small in bytes can still be too
    // large once escaped, so the whole projected status is judged.
    let newlines = |count: usize| patch_only(&format!("{PATCH_HEADER}{}", "\n".repeat(count)));
    codex_cleaning(
        result_frame("passed", json!(null), "verified", newlines(20_000)),
        true,
    );
    codex_cleaning(
        result_frame("passed", json!(null), "verified", newlines(32_800)),
        false,
    );
    // One accepted result closes the stream: no frame may follow it.
    let (owner, _rx) = primed(Provider::Codex, Phase::Cleaning, 3, Some("gpt-6-luna"));
    let mut result = None;
    assert!(feed(
        &owner,
        &result_frame("passed", json!(null), "verified", ok_result()),
        &mut result
    ));
    assert_eq!(current(&owner).phase, Phase::Cleaning);
    assert!(result.is_some());
    for frame in [
        progress_frame("cleaning"),
        json!({"type":"activity","tool_calls":3}),
        result_frame("passed", json!(null), "verified", ok_result()),
    ] {
        assert!(!feed(&owner, &frame, &mut result));
    }
}

#[test]
fn cancellation_keeps_its_revision_and_outranks_late_progress() {
    let (owner, rx) = primed(Provider::Codex, Phase::Running, 1, Some("gpt-6-luna"));
    assert!(owner.cancel(cancel(ID, 9)).is_err());
    assert!(owner.cancel(cancel(OTHER, 10)).is_err());
    assert!(owner
        .cancel(Cancel {
            schema_version: "2.0".into(),
            ..cancel(ID, 10)
        })
        .is_err());
    assert!(owner.cancel(cancel(ID, MAX_REVISION + 1)).is_err());
    let cancelled = owner.cancel(cancel(ID, 10)).unwrap().operation.unwrap();
    assert_eq!((cancelled.revision, cancelled.phase), (11, Phase::Running));
    assert!(rx.try_recv().is_ok());
    // Idempotent: a second cancel neither bumps nor re-signals.
    assert!(owner.cancel(cancel(ID, 10)).is_err());
    assert_eq!(
        owner
            .cancel(cancel(ID, 11))
            .unwrap()
            .operation
            .unwrap()
            .revision,
        11
    );
    assert!(rx.try_recv().is_err());
    let mut result = None;
    // Late forward progress is consumed but never displayed; cleaning is.
    assert!(feed(&owner, &progress_frame("verifying"), &mut result));
    assert_eq!(current(&owner).phase, Phase::Running);
    assert!(feed(&owner, &progress_frame("cleaning"), &mut result));
    assert_eq!(
        (current(&owner).phase, current(&owner).revision),
        (Phase::Cleaning, 12)
    );
    assert!(!feed(&owner, &progress_frame("cleaning"), &mut result));
    // A result produced after cancellation is overridden, never published.
    assert!(feed(
        &owner,
        &result_frame("passed", json!(null), "verified", ok_result()),
        &mut result
    ));
    owner.finish(ID, result.unwrap());
    let operation = current(&owner);
    assert_eq!(
        (operation.outcome, operation.error_code.as_deref()),
        (Some(Outcome::Cancelled), Some("cancelled"))
    );
    assert!(operation.result.is_none() && valid_operation(&operation));
    assert!(!owner.active());
    // Finished operations ignore both late terminals and further cancels.
    owner.finish(ID, End::failed("worker_failed"));
    assert_eq!(current(&owner).outcome, Some(Outcome::Cancelled));
    assert_eq!(
        owner
            .cancel(cancel(ID, current(&owner).revision))
            .unwrap()
            .operation
            .unwrap()
            .outcome,
        Some(Outcome::Cancelled)
    );
}

#[test]
fn cancellation_keeps_buffered_frame_validation_without_projecting_observations() {
    for (provider, model, other_model) in [
        (Provider::Codex, "gpt-6-luna", "gpt-6.1-sol"),
        (Provider::Claude, "claude-haiku-4-5", "claude-haiku-5-5"),
    ] {
        for phase in [Phase::Starting, Phase::Preparing] {
            let (owner, _rx) = primed(provider, phase, 0, None);
            let cancelled = owner.cancel(cancel(ID, 10)).unwrap();
            let before = value(&cancelled);
            let mut result = None;
            // Cancellation is not permission to accept out-of-order or
            // malformed observations, even while the public phase is frozen.
            assert!(!feed(
                &owner,
                &json!({"type":"model","observed":model}),
                &mut result
            ));
            assert!(!feed(
                &owner,
                &json!({"type":"activity","tool_calls":1}),
                &mut result
            ));
            if phase == Phase::Starting {
                assert!(feed(&owner, &progress_frame("preparing"), &mut result));
            }
            assert!(!feed(&owner, &progress_frame("verifying"), &mut result));
            assert!(feed(&owner, &progress_frame("running"), &mut result));
            assert!(feed(
                &owner,
                &json!({"type":"model","observed":model}),
                &mut result
            ));
            assert!(feed(
                &owner,
                &json!({"type":"activity","tool_calls":3}),
                &mut result
            ));
            for invalid in [
                json!({"type":"model","observed":other_model}),
                json!({"type":"model","observed":""}),
                json!({"type":"model","observed":null}),
                json!({"type":"activity","tool_calls":2}),
                json!({"type":"activity","tool_calls":17}),
                json!({"type":"activity","tool_calls":-1}),
                json!({"type":"activity","tool_calls":1.5}),
                json!({"type":"activity","tool_calls":"3"}),
                progress_frame("preparing"),
            ] {
                assert!(!feed(&owner, &invalid, &mut result), "{phase:?}: {invalid}");
            }
            assert!(feed(&owner, &progress_frame("verifying"), &mut result));
            assert_eq!(value(&owner.status()), before);
            assert!(feed(&owner, &progress_frame("cleaning"), &mut result));
            assert!(!feed(
                &owner,
                &json!({"type":"model","observed":model}),
                &mut result
            ));
            assert!(!feed(
                &owner,
                &json!({"type":"activity","tool_calls":3}),
                &mut result
            ));
            assert!(!feed(&owner, &progress_frame("running"), &mut result));
            assert!(!feed(
                &owner,
                &result_frame("passed", json!(null), "verified", patch_of("\0")),
                &mut result
            ));
            assert!(feed(
                &owner,
                &result_frame("passed", json!(null), "verified", ok_result()),
                &mut result
            ));
            owner.finish(ID, result.unwrap());
            let end = current(&owner);
            assert_eq!(
                (end.outcome, end.cleanup),
                (Some(Outcome::Cancelled), Cleanup::Verified)
            );
            assert!(valid_operation(&end));
            assert_eq!(end.tool_calls, 0);
            assert!(end.model.observed.is_none() && end.result.is_none());
        }
    }
}

#[test]
fn shutdown_requests_cancel_and_force_review_never_claims_cleanup() {
    let (owner, rx) = primed(
        Provider::Claude,
        Phase::Running,
        2,
        Some("claude-haiku-4-5"),
    );
    assert!(owner.shutdown());
    assert!(rx.try_recv().is_ok());
    assert_eq!(current(&owner).revision, 11);
    owner.force_review();
    let operation = current(&owner);
    assert_eq!(
        (operation.outcome, operation.cleanup),
        (Some(Outcome::NeedsReview), Cleanup::Unknown)
    );
    assert_eq!(operation.error_code.as_deref(), Some("cleanup_failed"));
    assert!(operation.result.is_none() && valid_operation(&operation));
    assert!(!owner.active());
    let mut result = None;
    assert!(!feed(&owner, &progress_frame("cleaning"), &mut result));
    owner.finish(ID, End::failed("worker_failed"));
    assert_eq!(current(&owner).outcome, Some(Outcome::NeedsReview));
    // An idle supervisor refuses new work once shutting down.
    let fixture = Fixture::new();
    fixture.registry("codex");
    let idle = Arc::new(TaskRun::default());
    assert!(!idle.shutdown());
    assert!(go(&idle, &fixture, &fixture.directory.join("launcher"), ID).is_err());
    assert!(idle.status().operation.is_none());
}

#[test]
fn owned_fixture_boot_resolves_saved_provider_and_truthful_status() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker("codex", PASS));
    let owner = Owner::new();
    let admitted = go(&owner, &fixture, &root, ID).unwrap();
    assert_eq!(
        value(&admitted),
        json!({"schema_version":"1.0","availability":"available","operation":{"request_id":ID,"profile_id":PROFILE,"provider":"codex","task_id":"controlled-sum-integers-v1","revision":0,"phase":"starting","outcome":null,"error_code":null,"cleanup":"pending","tool_calls":0,"model":{"requested":"gpt-6-luna","observed":null},"result":null}})
    );
    assert!(valid_status(&admitted));
    let sampler = sample(&owner);
    let result = wait(&owner, Phase::Finished);
    assert_eq!(
        value(&owner.status()),
        json!({"schema_version":"1.0","availability":"available","operation":{"request_id":ID,"profile_id":PROFILE,"provider":"codex","task_id":"controlled-sum-integers-v1","revision":8,"phase":"finished","outcome":"passed","error_code":null,"cleanup":"verified","tool_calls":3,"model":{"requested":"gpt-6-luna","observed":"gpt-6-luna"},"result":{"verifier":{"passed":true,"cases":34,"json_cases_passed":true,"sparse_cases_passed":true},"candidate_sha256":H,"patch_sha256":H2,"patch":PATCH}}})
    );
    let seen = sampler.join().unwrap();
    assert_monotone(&seen);
    assert!(seen.len() > 3);
    assert!(valid_operation(&result));
    assert!(fixture.home().is_dir());
    assert!(!serde_json::to_string(&owner.status())
        .unwrap()
        .contains("PRIVATE"));
    assert!(!owner.active());
    // The same request is idempotent; a different one after a pass is not
    // blocked, and an already used request id is never replayed.
    assert_eq!(
        value(&go(&owner, &fixture, &root, ID).unwrap()),
        value(&owner.status())
    );
    assert!(owner
        .start(
            Start {
                profile_id: OTHER.into(),
                ..start(ID)
            },
            root.clone(),
            fixture.directory.clone()
        )
        .is_err());
    go(&owner, &fixture, &root, OTHER).unwrap();
    assert_eq!(current(&owner).request_id, OTHER);
    wait(&owner, Phase::Finished);
    assert!(go(&owner, &fixture, &root, ID).is_err());
}

#[test]
fn claude_rejection_hides_the_diff_and_keeps_requested_model_separate() {
    let fixture = Fixture::new();
    fixture.registry("claude");
    let root = fixture.resources(&worker("claude", "P('preparing');P('running');M('claude-haiku-5-5');A(2);P('verifying');P('cleaning');R('rejected','candidate_rejected','verified',NO);"));
    let owner = Owner::new();
    let admitted = go(&owner, &fixture, &root, ID).unwrap().operation.unwrap();
    assert_eq!(
        (admitted.provider, admitted.model.requested),
        (Provider::Claude, "haiku")
    );
    wait(&owner, Phase::Finished);
    assert_eq!(
        value(&owner.status().operation),
        json!({"request_id":ID,"profile_id":PROFILE,"provider":"claude","task_id":"controlled-sum-integers-v1","revision":7,"phase":"finished","outcome":"rejected","error_code":"candidate_rejected","cleanup":"verified","tool_calls":2,"model":{"requested":"haiku","observed":"claude-haiku-5-5"},"result":{"verifier":{"passed":false,"cases":34,"json_cases_passed":true,"sparse_cases_passed":false},"candidate_sha256":H,"patch_sha256":null,"patch":null}})
    );
}

#[test]
fn large_valid_patch_survives_and_status_overflow_is_a_protocol_violation() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker("codex", ""));
    let big = finished(
        &fixture,
        &root,
        &format!(
            "RUN();R('passed',null,'verified',{{...OK,patch:'{}'+'\\n'.repeat(20000)}});",
            PATCH_HEADER.replace('\n', "\\n")
        ),
        "codex",
    );
    assert_eq!(big.outcome, Some(Outcome::Passed));
    assert_eq!(
        big.result.unwrap().patch.unwrap().len(),
        PATCH_HEADER.len() + 20_000
    );
    // The largest frame the line limit admits still projects past the status
    // bound, so the worker's claim cannot be published.
    let frame = |count: usize| {
        let mut result = ok_result();
        result["patch"] = json!(format!("{PATCH_HEADER}{}", "\n".repeat(count)));
        result_frame("passed", json!(null), "verified", result).to_string()
    };
    let count = (30_000..MAX_PATCH_BYTES)
        .take_while(|count| frame(*count).len() < MAX_FRAME_BYTES)
        .last()
        .unwrap();
    let line = frame(count);
    let mut candidate = operation(Provider::Codex, Phase::Finished);
    candidate.revision = MAX_REVISION;
    candidate.outcome = Some(Outcome::Passed);
    candidate.cleanup = Cleanup::Verified;
    candidate.tool_calls = 3;
    candidate.model.observed = Some("gpt-6-luna".into());
    let parsed: Value = serde_json::from_str(&line).unwrap();
    candidate.result = Some(serde_json::from_value(parsed["result"].clone()).unwrap());
    assert!(valid_operation(&candidate));
    assert!(!valid_status(&Status {
        schema_version: "1.0",
        availability: "available",
        operation: Some(candidate)
    }));
    let body = format!(
        "RUN();raw({}+'\\n');",
        serde_json::to_string(&line).unwrap()
    );
    let overflow = finished(&fixture, &root, &body, "codex");
    assert_eq!(
        (overflow.outcome, overflow.cleanup),
        (Some(Outcome::NeedsReview), Cleanup::Unknown)
    );
    assert_eq!(overflow.error_code.as_deref(), Some("worker_failed"));
    assert!(overflow.result.is_none());
}

#[test]
fn worker_protocol_violations_cannot_claim_cleanup_or_expose_raw_output() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker("codex", ""));
    for (name, body) in [
        ("oversized line", "P('preparing');raw('PRIVATE'.repeat(10000)+'\\n');await sleep(60000);"),
        ("padded valid json", "raw(JSON.stringify({type:'progress',phase:'preparing'})+' '.repeat(70000)+'\\n');await sleep(60000);"),
        ("not json", "raw('PRIVATE_AUTH not json\\n');await sleep(60000);"),
        ("invalid utf8", "raw(Buffer.from([0xff,0xfe,0x0a]));await sleep(60000);"),
        ("no trailing newline", "raw(JSON.stringify({type:'progress',phase:'preparing'}));"),
        ("too many lines", "P('preparing');P('running');for(let i=0;i<70;i++)A(0);await sleep(60000);"),
        ("frame after result", "RUN();R('passed',null,'verified',OK);P('cleaning');await sleep(60000);"),
        ("second result", "RUN();R('passed',null,'verified',OK);R('passed',null,'verified',OK);await sleep(60000);"),
        ("skipped phase", "P('running');await sleep(60000);"),
        ("rewound phase", "P('preparing');P('running');P('preparing');await sleep(60000);"),
        ("model off allow list", "P('preparing');P('running');M('gpt-6.1-sol');await sleep(60000);"),
        ("tool calls rewind", "P('preparing');P('running');A(5);A(4);await sleep(60000);"),
        ("tool calls over limit", "P('preparing');P('running');A(17);await sleep(60000);"),
        ("patch with carriage return", "RUN();R('passed',null,'verified',{...OK,patch:PATCH+'\\r'});await sleep(60000);"),
        ("patch with bidi control", "RUN();R('passed',null,'verified',{...OK,patch:PATCH+'\\u202e'});await sleep(60000);"),
        ("patch too large", "RUN();R('passed',null,'verified',{...OK,patch:PATCH+'x'.repeat(49152)});await sleep(60000);"),
        ("patch wrong header", "RUN();R('passed',null,'verified',{...OK,patch:'--- a/sum.mjs\\n'});await sleep(60000);"),
        ("rejected with patch", "RUN();R('rejected','candidate_rejected','verified',{...NO,patch:PATCH});await sleep(60000);"),
        ("passed without a model", "P('preparing');P('running');A(1);P('verifying');P('cleaning');R('passed',null,'verified',OK);await sleep(60000);"),
        ("cleanup not verified", "RUN();R('passed',null,'unknown',OK);await sleep(60000);"),
        ("result before cleaning", "P('preparing');P('running');M(MODEL);A(1);R('passed',null,'verified',OK);await sleep(60000);"),
        ("worker crash", "P('preparing');process.exit(1);"),
        ("exit without result", "P('preparing');P('running');"),
        ("result then crash", "RUN();R('passed',null,'verified',OK);process.exit(1);"),
        ("crash after a clean result", "P('preparing');P('cleaning');R('failed','provider_failed','verified',null);process.exit(5);"),
    ] {
        let result = finished(&fixture, &root, body, "codex");
        assert_eq!(result.outcome, Some(Outcome::NeedsReview), "{name}");
        assert_eq!(result.cleanup, Cleanup::Unknown, "{name}");
        assert_eq!(result.error_code.as_deref(), Some("worker_failed"), "{name}");
        assert!(result.result.is_none(), "{name}");
        assert!(valid_operation(&result), "{name}");
        assert!(!serde_json::to_string(&result).unwrap().contains("PRIVATE"), "{name}");
    }
}

#[test]
fn worker_reported_failures_keep_cleanup_truth_and_needs_review_blocks_new_runs() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker(
        "codex",
        "P('preparing');P('cleaning');R('failed','model_unavailable','verified',null);",
    ));
    let owner = Owner::new();
    go(&owner, &fixture, &root, ID).unwrap();
    let failed = wait(&owner, Phase::Finished);
    assert_eq!(
        (failed.outcome, failed.cleanup),
        (Some(Outcome::Failed), Cleanup::Verified)
    );
    assert_eq!(failed.error_code.as_deref(), Some("model_unavailable"));
    assert_eq!((failed.tool_calls, failed.model.observed), (0, None));
    // A verified failure frees the profile for a new request.
    go(&owner, &fixture, &root, OTHER).unwrap();
    wait(&owner, Phase::Finished);
    drop(owner);
    fixture.swap(
        &root,
        &worker(
            "codex",
            "P('preparing');P('cleaning');R('needs_review','cleanup_failed','unknown',null);",
        ),
    );
    let owner = Owner::new();
    go(&owner, &fixture, &root, ID).unwrap();
    let review = wait(&owner, Phase::Finished);
    assert_eq!(
        (review.outcome, review.cleanup),
        (Some(Outcome::NeedsReview), Cleanup::Unknown)
    );
    assert_eq!(review.error_code.as_deref(), Some("cleanup_failed"));
    let before = value(&owner.status());
    assert!(go(&owner, &fixture, &root, OTHER).is_err());
    assert!(go(
        &owner,
        &fixture,
        &root,
        "44444444-4444-4444-8444-444444444444"
    )
    .is_err());
    assert_eq!(value(&owner.status()), before);
    // Observing the same blocked request stays possible and truthful.
    assert_eq!(value(&go(&owner, &fixture, &root, ID).unwrap()), before);
    // A worker crash blocks the same way.
    let crashed = Owner::new();
    fixture.swap(&root, &worker("codex", "P('preparing');process.exit(1);"));
    go(&crashed, &fixture, &root, ID).unwrap();
    assert_eq!(
        wait(&crashed, Phase::Finished).outcome,
        Some(Outcome::NeedsReview)
    );
    assert!(go(&crashed, &fixture, &root, OTHER).is_err());
}

#[test]
fn cancellation_during_a_run_is_revision_bound_and_drops_late_results() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker(
        "codex",
        "P('preparing');P('running');M(MODEL);A(2);await CANCELLED();await sleep(100);P('cleaning');R('cancelled','cancelled','verified',null);",
    ));
    let owner = Owner::new();
    go(&owner, &fixture, &root, ID).unwrap();
    let running = until(&owner, "tool calls", |operation| operation.tool_calls == 2);
    assert!(owner.cancel(cancel(ID, running.revision - 1)).is_err());
    assert!(owner.cancel(cancel(OTHER, running.revision)).is_err());
    let asked = owner
        .cancel(cancel(ID, running.revision))
        .unwrap()
        .operation
        .unwrap();
    assert_eq!(
        (asked.revision, asked.phase, asked.outcome),
        (running.revision + 1, Phase::Running, None)
    );
    assert!(owner.cancel(cancel(ID, running.revision)).is_err());
    assert_eq!(
        owner
            .cancel(cancel(ID, asked.revision))
            .unwrap()
            .operation
            .unwrap()
            .revision,
        asked.revision
    );
    let result = wait(&owner, Phase::Finished);
    assert_eq!(
        (result.outcome, result.cleanup),
        (Some(Outcome::Cancelled), Cleanup::Verified)
    );
    assert_eq!(result.error_code.as_deref(), Some("cancelled"));
    assert!(result.result.is_none() && valid_operation(&result));
    assert_eq!(
        owner
            .cancel(cancel(ID, result.revision))
            .unwrap()
            .operation
            .unwrap()
            .revision,
        result.revision
    );
    // A result that races the cancellation is never published. Each worker
    // has sent its last frame before `ready` holds, so the revision is stable.
    for (body, ready) in [
        ("P('preparing');P('running');M(MODEL);A(1);await CANCELLED();P('cleaning');R('passed',null,'verified',OK);", Phase::Running),
        ("RUN();await CANCELLED();R('passed',null,'verified',OK);", Phase::Cleaning),
        ("RUN();onCancel=()=>{};R('passed',null,'verified',OK);await sleep(1500);", Phase::Cleaning),
    ] {
        fixture.swap(&root, &worker("codex", body));
        let racing = Owner::new();
        go(&racing, &fixture, &root, ID).unwrap();
        let last = until(&racing, "last frame", |operation| operation.phase == ready && (ready != Phase::Running || operation.tool_calls == 1));
        racing.cancel(cancel(ID, last.revision)).unwrap();
        let end = wait(&racing, Phase::Finished);
        assert_eq!((end.outcome, end.error_code.as_deref()), (Some(Outcome::Cancelled), Some("cancelled")), "{body}");
        assert!(end.result.is_none() && valid_operation(&end), "{body}");
    }
}

#[test]
fn cancellation_consumes_buffered_observations_before_running_and_keeps_cleanup_verified() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker("codex", PASS));
    for (phase, prefix, suffix) in [
        (Phase::Starting, "", "P('preparing');P('running');"),
        (Phase::Preparing, "P('preparing');", "P('running');"),
    ] {
        for terminal in [
            "R('cancelled','cancelled','verified',null);",
            "R('passed',null,'verified',OK);",
        ] {
            // A ready marker makes cancellation deterministic even before the
            // worker's first progress frame. Release its pending observations
            // only after it has received the native cancellation message.
            let body = format!("{prefix}const cancelled=CANCELLED();(await import('node:fs')).writeFileSync('ready','');await cancelled;{suffix}M(MODEL);A(1);A(3);P('verifying');P('cleaning');{terminal}");
            fixture.swap(&root, &worker("codex", &body));
            let owner = Owner::new();
            go(&owner, &fixture, &root, ID).unwrap();
            let ready = fixture.home().join("ready");
            let deadline = Instant::now() + Duration::from_secs(20);
            while !ready.exists() {
                assert!(Instant::now() < deadline, "worker did not become ready");
                thread::sleep(Duration::from_millis(5));
            }
            let before = wait(&owner, phase);
            let cancelled = owner.cancel(cancel(ID, before.revision)).unwrap();
            let seen = sample(&owner);
            let end = wait(&owner, Phase::Finished);
            assert_eq!(
                (end.outcome, end.cleanup, end.error_code.as_deref()),
                (
                    Some(Outcome::Cancelled),
                    Cleanup::Verified,
                    Some("cancelled")
                ),
                "{phase:?}: {terminal}"
            );
            assert_eq!(end.tool_calls, 0);
            assert!(end.model.observed.is_none() && end.result.is_none());
            assert_eq!(end.revision, before.revision + 3);
            let mut seen = seen.join().unwrap();
            seen.insert(0, cancelled);
            assert_monotone(&seen);
            for status in seen {
                let operation = status.operation.unwrap();
                assert!(
                    matches!(operation.phase, Phase::Cleaning | Phase::Finished)
                        || operation.phase == phase
                );
                assert_eq!(operation.tool_calls, 0);
                assert!(operation.model.observed.is_none());
            }
            drop(owner);
            fs::remove_file(ready).unwrap();
        }
    }
}

#[test]
fn cancellation_reports_unverified_cleanup_and_stuck_workers_as_review() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker(
        "codex",
        "P('preparing');P('running');await CANCELLED();P('cleaning');R('needs_review','cleanup_failed','unknown',null);",
    ));
    let owner = Owner::new();
    go(&owner, &fixture, &root, ID).unwrap();
    let running = wait(&owner, Phase::Running);
    owner.cancel(cancel(ID, running.revision)).unwrap();
    let review = wait(&owner, Phase::Finished);
    assert_eq!(
        (review.outcome, review.cleanup),
        (Some(Outcome::NeedsReview), Cleanup::Unknown)
    );
    assert_eq!(review.error_code.as_deref(), Some("cleanup_failed"));
    assert!(go(&owner, &fixture, &root, OTHER).is_err());
    drop(owner);
    // A worker that ignores cancellation is terminated after the grace; the
    // contract has no cancelled/unknown state, so it is a cleanup failure.
    fixture.swap(
        &root,
        &worker(
            "codex",
            "P('preparing');P('running');onCancel=()=>{};await sleep(60000);",
        ),
    );
    let owner = Owner::new();
    let limits = Limits {
        deadline: Duration::from_secs(60),
        grace: Duration::from_millis(300),
    };
    go_with(&owner, &fixture, &root, limits).unwrap();
    let running = wait(&owner, Phase::Running);
    owner.cancel(cancel(ID, running.revision)).unwrap();
    let stuck = wait(&owner, Phase::Finished);
    assert_eq!(
        (stuck.outcome, stuck.cleanup),
        (Some(Outcome::NeedsReview), Cleanup::Unknown)
    );
    assert_eq!(stuck.error_code.as_deref(), Some("cleanup_failed"));
    assert!(valid_operation(&stuck));
}

#[test]
fn cancel_before_the_worker_is_spawned_never_starts_it() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker("codex", PASS));
    let (owner, rx) = primed(Provider::Codex, Phase::Starting, 0, None);
    {
        let mut inner = owner.inner.lock().unwrap();
        inner.status.operation.as_mut().unwrap().revision = 0;
    }
    assert_eq!(
        owner
            .cancel(cancel(ID, 0))
            .unwrap()
            .operation
            .unwrap()
            .revision,
        1
    );
    owner.run(current(&owner), root, fixture.directory.clone(), rx, LIMITS);
    let result = current(&owner);
    assert_eq!(
        (result.outcome, result.cleanup),
        (Some(Outcome::Cancelled), Cleanup::Verified)
    );
    assert_eq!(result.error_code.as_deref(), Some("cancelled"));
    assert!(valid_operation(&result) && result.revision == 2);
    assert!(!fixture.home().exists());
}

#[test]
fn deadline_is_enforced_with_an_independent_cleanup_grace() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    // Cleanup that takes longer than the whole deadline still counts as verified.
    let root = fixture.resources(&worker(
        "codex",
        "P('preparing');P('running');M(MODEL);A(1);await CANCELLED();await sleep(5500);P('cleaning');R('cancelled','cancelled','verified',null);",
    ));
    let owner = Owner::new();
    let limits = Limits {
        // Include native runtime hashing and Windows process startup in the
        // budget, then confirm the worker is running before testing expiry.
        deadline: Duration::from_secs(5),
        grace: Duration::from_secs(20),
    };
    go_with(&owner, &fixture, &root, limits).unwrap();
    wait(&owner, Phase::Running);
    let late = wait(&owner, Phase::Finished);
    assert_eq!(
        (late.outcome, late.cleanup),
        (Some(Outcome::Failed), Cleanup::Verified)
    );
    assert_eq!(late.error_code.as_deref(), Some("deadline_exceeded"));
    assert!(late.result.is_none() && valid_operation(&late));
    drop(owner);
    // A result that arrives after the deadline is not a success.
    fixture.swap(&root, &worker("codex", "P('preparing');P('running');M(MODEL);A(1);P('verifying');P('cleaning');await CANCELLED();R('passed',null,'verified',OK);"));
    let owner = Owner::new();
    go_with(&owner, &fixture, &root, limits).unwrap();
    wait(&owner, Phase::Cleaning);
    let late = wait(&owner, Phase::Finished);
    assert_eq!(
        (late.outcome, late.error_code.as_deref()),
        (Some(Outcome::Failed), Some("deadline_exceeded"))
    );
    assert!(late.result.is_none() && valid_operation(&late));
    drop(owner);
    // A worker that never cleans up is terminated after the grace.
    fixture.swap(
        &root,
        &worker(
            "codex",
            "P('preparing');P('running');onCancel=()=>{};await sleep(60000);",
        ),
    );
    let owner = Owner::new();
    let limits = Limits {
        deadline: Duration::from_secs(5),
        grace: Duration::from_millis(400),
    };
    go_with(&owner, &fixture, &root, limits).unwrap();
    wait(&owner, Phase::Running);
    let stuck = wait(&owner, Phase::Finished);
    assert_eq!(
        (stuck.outcome, stuck.cleanup),
        (Some(Outcome::NeedsReview), Cleanup::Unknown)
    );
    assert_eq!(stuck.error_code.as_deref(), Some("deadline_exceeded"));
    assert!(valid_operation(&stuck));
    drop(owner);
    // An expired deadline never reaches the worker.
    fs::remove_dir_all(fixture.home()).ok();
    let owner = Owner::new();
    go_with(
        &owner,
        &fixture,
        &root,
        Limits {
            deadline: Duration::ZERO,
            grace: LIMITS.grace,
        },
    )
    .unwrap();
    let expired = wait(&owner, Phase::Finished);
    assert_eq!(
        (expired.outcome, expired.cleanup),
        (Some(Outcome::Failed), Cleanup::Verified)
    );
    assert_eq!(expired.error_code.as_deref(), Some("deadline_exceeded"));
    assert!(!fixture.home().exists());
    assert_eq!(LIMITS.deadline, Duration::from_secs(1200));
    assert_eq!(LIMITS.grace, Duration::from_secs(35));
}

#[test]
fn requests_are_denied_without_a_saved_selected_profile_or_valid_assets() {
    let fixture = Fixture::new();
    let owner = Owner::new();
    let absent = fixture.directory.join("absent");
    assert!(go(&owner, &fixture, &absent, ID).is_err());
    fixture.registry("codex");
    for bad in [
        Start {
            profile_id: OTHER.into(),
            ..start(ID)
        },
        Start {
            request_id: "nope".into(),
            ..start(ID)
        },
        Start {
            schema_version: "2.0".into(),
            ..start(ID)
        },
        Start {
            task_id: "controlled-sum-integers-v2".into(),
            ..start(ID)
        },
        Start {
            approved: false,
            ..start(ID)
        },
    ] {
        assert!(owner
            .start(bad, absent.clone(), fixture.directory.clone())
            .is_err());
    }
    assert!(owner.status().operation.is_none());
    assert!(!fixture.home().exists());
    // Missing, then malformed, launcher resources are reported without a spawn.
    go(&owner, &fixture, &absent, ID).unwrap();
    let missing = wait(&owner, Phase::Finished);
    assert_eq!(
        (missing.outcome, missing.cleanup),
        (Some(Outcome::Failed), Cleanup::Verified)
    );
    assert_eq!(missing.error_code.as_deref(), Some("asset_missing"));
    let broken = fixture.directory.join("broken");
    fs::create_dir(&broken).unwrap();
    fs::write(broken.join("manifest.json"), "{}").unwrap();
    fs::write(broken.join(node_name()), "x").unwrap();
    fs::write(broken.join("worker.mjs"), "x").unwrap();
    go(&owner, &fixture, &broken, OTHER).unwrap();
    let invalid = until(&owner, "second run", |operation| {
        operation.request_id == OTHER && operation.phase == Phase::Finished
    });
    assert_eq!(invalid.error_code.as_deref(), Some("asset_invalid"));
    assert!(valid_operation(&invalid));
    assert!(!fixture.home().exists());
}

#[test]
fn only_one_run_is_active_and_a_second_request_is_denied() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&worker("codex", "P('preparing');P('running');await CANCELLED();P('cleaning');R('cancelled','cancelled','verified',null);"));
    let owner = Owner::new();
    let first = go(&owner, &fixture, &root, ID).unwrap();
    assert!(go(&owner, &fixture, &root, OTHER).is_err());
    assert!(owner.active());
    assert_eq!(current(&owner).request_id, ID);
    assert_eq!(first.operation.unwrap().request_id, ID);
    assert!(go(&owner, &fixture, &root, ID).is_ok());
    owner.shutdown();
    wait(&owner, Phase::Finished);
    assert!(go(&owner, &fixture, &root, OTHER).is_err());
}

#[test]
fn task_ids_and_patch_headers_follow_the_browser_contract() {
    assert_eq!(TASK_IDS, ["controlled-sum-integers-v1", "software-bounds"]);
    assert_eq!(task_id("software-bounds"), Some(SOFTWARE_TASK));
    assert_eq!(task_id("controlled-sum-integers-v1"), Some(CONTROLLED_TASK));
    for unknown in [
        "",
        "Software-Bounds",
        "software-bounds ",
        "software-bounds-v2",
    ] {
        assert_eq!(task_id(unknown), None, "{unknown:?}");
    }
    assert_eq!(patch_header(CONTROLLED_TASK).as_deref(), Some(PATCH_HEADER));
    assert_eq!(
        patch_header(SOFTWARE_TASK).as_deref(),
        Some("diff --git a/src/search.ts b/src/search.ts\n")
    );
    assert_eq!(patch_header("other"), None);
    let request = |task: &str| json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"task_id":task,"approved":true}});
    assert!(preflight(&request(SOFTWARE_TASK), Shape::Start));
    for unknown in ["software-bounds-v2", "SOFTWARE-BOUNDS", ""] {
        assert!(!preflight(&request(unknown), Shape::Start), "{unknown:?}");
    }
    // Patches are bound to their own task's file.
    assert!(valid_patch(SOFT_PATCH, SOFTWARE_TASK) && !valid_patch(SOFT_PATCH, CONTROLLED_TASK));
    assert!(valid_patch(PATCH, CONTROLLED_TASK) && !valid_patch(PATCH, SOFTWARE_TASK));
    assert!(!valid_patch(SOFT_PATCH, "other") && !valid_patch(PATCH, ""));
    assert!(!valid_patch(
        "diff --git a/search.ts b/search.ts\n+x\n",
        SOFTWARE_TASK
    ));
}

#[test]
fn verifier_shapes_are_exclusive_and_bound_to_their_task() {
    let controlled: TaskResult = serde_json::from_value(ok_result()).unwrap();
    let controlled_no: TaskResult = serde_json::from_value(no_result()).unwrap();
    let software: TaskResult = serde_json::from_value(soft_ok_result()).unwrap();
    let software_no: TaskResult = serde_json::from_value(soft_no_result()).unwrap();
    assert!(matches!(controlled.verifier, Verifier::Controlled(_)));
    assert!(matches!(software.verifier, Verifier::Software(_)));
    assert!(software.valid(Outcome::Passed, SOFTWARE_TASK));
    assert!(software_no.valid(Outcome::Rejected, SOFTWARE_TASK));
    assert!(!software.valid(Outcome::Rejected, SOFTWARE_TASK));
    assert!(!software_no.valid(Outcome::Passed, SOFTWARE_TASK));
    // A verifier of the other task's shape never validates, in both directions.
    for outcome in [Outcome::Passed, Outcome::Rejected] {
        assert!(!software.valid(outcome, CONTROLLED_TASK));
        assert!(!software_no.valid(outcome, CONTROLLED_TASK));
        assert!(!controlled.valid(outcome, SOFTWARE_TASK));
        assert!(!controlled_no.valid(outcome, SOFTWARE_TASK));
        assert!(!software.valid(outcome, "other") && !controlled.valid(outcome, "other"));
    }
    // The controlled patch cannot ride a software verifier, or the reverse.
    let mut wrong_patch = software.clone();
    wrong_patch.patch = Some(PATCH.into());
    assert!(!wrong_patch.valid(Outcome::Passed, SOFTWARE_TASK));
    let mut wrong_patch = controlled.clone();
    wrong_patch.patch = Some(SOFT_PATCH.into());
    assert!(!wrong_patch.valid(Outcome::Passed, CONTROLLED_TASK));
    // Software rules: passed is exactly the AND of its two checks; cases 1..=1000.
    let soft = |change: &dyn Fn(&mut SoftwareVerifier)| {
        let mut copy = software.clone();
        match &mut copy.verifier {
            Verifier::Software(verifier) => change(verifier),
            Verifier::Controlled(_) => unreachable!(),
        }
        copy
    };
    for broken in [
        soft(&|v| v.cases = 0),
        soft(&|v| v.cases = 1001),
        soft(&|v| v.visible_tests_passed = false),
        soft(&|v| v.hidden_cases_passed = false),
        soft(&|v| v.passed = false),
    ] {
        assert!(!broken.valid(Outcome::Passed, SOFTWARE_TASK));
    }
    assert!(soft(&|v| v.cases = 1).valid(Outcome::Passed, SOFTWARE_TASK));
    assert!(soft(&|v| v.cases = 1000).valid(Outcome::Passed, SOFTWARE_TASK));
    let mut inconsistent = software_no.clone();
    let mut both_failed = software_no.clone();
    if let (Verifier::Software(a), Verifier::Software(b)) =
        (&mut inconsistent.verifier, &mut both_failed.verifier)
    {
        a.passed = true;
        b.visible_tests_passed = false;
    }
    assert!(!inconsistent.valid(Outcome::Rejected, SOFTWARE_TASK));
    assert!(both_failed.valid(Outcome::Rejected, SOFTWARE_TASK));
    // Untagged variants still deny unknown fields: no cross-shape or mixed
    // verifier deserializes, so the wire frame is refused outright.
    let with = |field: &str, replacement: Value| {
        let mut base = soft_ok_result();
        base["verifier"][field] = replacement;
        base
    };
    let mixed = [
        with("json_cases_passed", json!(true)),
        with("extra", json!(1)),
        {
            let mut base = ok_result();
            base["verifier"] = json!({"passed":true,"cases":34,"visible_tests_passed":true,"hidden_cases_passed":true,"json_cases_passed":true});
            base
        },
        {
            let mut base = ok_result();
            base["verifier"] = json!({"passed":true,"cases":34,"json_cases_passed":true,"hidden_cases_passed":true});
            base
        },
        {
            let mut base = soft_ok_result();
            base["verifier"] = json!({"passed":true,"cases":21,"visible_tests_passed":true});
            base
        },
        {
            let mut base = soft_ok_result();
            base["verifier"] = json!({"passed":true,"cases":21,"visible_tests_passed":true,"hidden_cases_passed":"yes"});
            base
        },
        with("cases", json!(-1)),
        with("cases", json!(1.5)),
        with("passed", json!(0)),
    ];
    for result in mixed {
        assert!(
            serde_json::from_value::<TaskResult>(result.clone()).is_err(),
            "{result}"
        );
    }
    // The public projection keeps exactly the browser field names.
    assert_eq!(value(&software), soft_ok_result());
    assert_eq!(value(&software_no), soft_no_result());
    assert_eq!(value(&controlled), ok_result());
    // A software result is accepted for a software operation only.
    soft_cleaning(
        result_frame("passed", json!(null), "verified", soft_ok_result()),
        true,
    );
    soft_cleaning(
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            soft_no_result(),
        ),
        true,
    );
    for frame in [
        result_frame("passed", json!(null), "verified", ok_result()),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            no_result(),
        ),
        // The controlled patch header on a software verifier.
        result_frame("passed", json!(null), "verified", {
            let mut r = soft_ok_result();
            r["patch"] = json!(PATCH);
            r
        }),
        result_frame("passed", json!(null), "verified", {
            let mut r = soft_ok_result();
            r["verifier"]["hidden_cases_passed"] = json!(false);
            r
        }),
    ] {
        soft_cleaning(frame, false);
    }
    // Conversely a software result never fits the controlled task.
    for frame in [
        result_frame("passed", json!(null), "verified", soft_ok_result()),
        result_frame(
            "rejected",
            json!("candidate_rejected"),
            "verified",
            soft_no_result(),
        ),
    ] {
        codex_cleaning(frame, false);
    }
}

#[test]
fn software_task_boots_with_its_id_and_publishes_the_software_verifier() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let body = "RUN();R('passed',null,'verified',SOK);";
    let root = fixture.resources(&worker_for("codex", SOFTWARE_TASK, body));
    let owner = Owner::new();
    let admitted = go_task(&owner, &fixture, &root, ID, SOFTWARE_TASK).unwrap();
    assert_eq!(
        value(&admitted)["operation"]["task_id"],
        json!("software-bounds")
    );
    // The worker's boot check exits on any other task id, so reaching a
    // passed result proves the boot message carried the operation's task.
    let end = wait(&owner, Phase::Finished);
    assert_eq!(
        value(&owner.status()),
        json!({"schema_version":"1.0","availability":"available","operation":{"request_id":ID,"profile_id":PROFILE,"provider":"codex","task_id":"software-bounds","revision":8,"phase":"finished","outcome":"passed","error_code":null,"cleanup":"verified","tool_calls":3,"model":{"requested":"gpt-6-luna","observed":"gpt-6-luna"},"result":{"verifier":{"passed":true,"cases":21,"visible_tests_passed":true,"hidden_cases_passed":true},"candidate_sha256":H,"patch_sha256":H2,"patch":SOFT_PATCH}}})
    );
    assert!(valid_operation(&end) && end.task_id == SOFTWARE_TASK);
    // The controlled worker contract is unchanged on the same fixture.
    drop(owner);
    fixture.swap(&root, &worker("codex", PASS));
    let owner = Owner::new();
    go(&owner, &fixture, &root, ID).unwrap();
    let controlled = wait(&owner, Phase::Finished);
    assert_eq!(
        (controlled.outcome, controlled.task_id),
        (Some(Outcome::Passed), CONTROLLED_TASK)
    );
    drop(owner);
    // A worker built for the controlled task refuses a software boot.
    let mismatch = finished_task(&fixture, &root, SOFTWARE_TASK, &worker("codex", PASS));
    assert_eq!(
        (mismatch.outcome, mismatch.error_code.as_deref()),
        (Some(Outcome::NeedsReview), Some("worker_failed"))
    );
    // A software rejection projects no patch.
    let rejected = finished_task(
        &fixture,
        &root,
        SOFTWARE_TASK,
        &worker_for("codex", SOFTWARE_TASK, "P('preparing');P('running');M(MODEL);A(2);P('verifying');P('cleaning');R('rejected','candidate_rejected','verified',{verifier:{passed:false,cases:21,visible_tests_passed:true,hidden_cases_passed:false},candidate_sha256:H,patch_sha256:null,patch:null});"),
    );
    assert_eq!(rejected.outcome, Some(Outcome::Rejected));
    assert!(valid_operation(&rejected) && rejected.result.unwrap().patch.is_none());
    // A controlled-shaped verifier from a software run is a protocol violation.
    let crossed = finished_task(
        &fixture,
        &root,
        SOFTWARE_TASK,
        &worker_for(
            "codex",
            SOFTWARE_TASK,
            "RUN();R('passed',null,'verified',OK);await sleep(60000);",
        ),
    );
    assert_eq!(
        (
            crossed.outcome,
            crossed.cleanup,
            crossed.error_code.as_deref()
        ),
        (
            Some(Outcome::NeedsReview),
            Cleanup::Unknown,
            Some("worker_failed")
        )
    );
    assert!(crossed.result.is_none());
}
// Runs a worker source for one task to completion on a fresh owner.
fn finished_task(fixture: &Fixture, root: &Path, task: &str, source: &str) -> Operation {
    fixture.swap(root, source);
    let owner = Owner::new();
    go_task(&owner, fixture, root, ID, task).unwrap();
    wait(&owner, Phase::Finished)
}

#[test]
fn unknown_tasks_and_task_changes_on_a_request_are_denied() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let absent = fixture.directory.join("absent");
    let owner = Owner::new();
    for unknown in ["software-bounds-v2", "", "Software-Bounds", "other-task"] {
        assert!(
            go_task(&owner, &fixture, &absent, ID, unknown).is_err(),
            "{unknown:?}"
        );
    }
    assert!(owner.status().operation.is_none() && !owner.active());
    assert!(!fixture.home().exists());
    // The same request id with a different task is not the same request.
    let root = fixture.resources(&worker(
        "codex",
        "P('preparing');P('running');await CANCELLED();P('cleaning');R('cancelled','cancelled','verified',null);",
    ));
    let first = go_task(&owner, &fixture, &root, ID, SOFTWARE_TASK).unwrap();
    let before = value(&owner.status());
    assert_eq!(
        value(&first)["operation"]["task_id"],
        json!("software-bounds")
    );
    assert!(go_task(&owner, &fixture, &root, ID, CONTROLLED_TASK).is_err());
    assert!(go_task(&owner, &fixture, &root, ID, "other-task").is_err());
    assert_eq!(current(&owner).task_id, SOFTWARE_TASK);
    assert_eq!(value(&owner.status())["operation"]["request_id"], json!(ID));
    // Repeating the identical request stays idempotent.
    assert!(go_task(&owner, &fixture, &root, ID, SOFTWARE_TASK).is_ok());
    assert_eq!(
        value(&owner.status())["operation"]["task_id"],
        before["operation"]["task_id"]
    );
    owner.shutdown();
    wait(&owner, Phase::Finished);
    // The reverse direction is denied as well, on a finished operation.
    let other = Owner::new();
    fixture.swap(&root, &worker("codex", PASS));
    go_task(&other, &fixture, &root, OTHER, CONTROLLED_TASK).unwrap();
    wait(&other, Phase::Finished);
    assert!(go_task(&other, &fixture, &root, OTHER, SOFTWARE_TASK).is_err());
    assert_eq!(current(&other).task_id, CONTROLLED_TASK);
}

fn universal_worker() -> String {
    r##"import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});let booted=false,session=false;const out=o=>console.log(JSON.stringify(o));lines.on('line',line=>{const b=JSON.parse(line);if(!booted){booted=true;session=b.type==='profile_session_boot';if(session){out({type:'progress',phase:'preparing'});if(b.action==='status'){out({type:'progress',phase:'checking'});out({type:'progress',phase:'cleaning'});out({type:'result',outcome:'passed',session_state:'unauthenticated',error_code:null,cleanup:'verified'});lines.close();process.stdin.destroy();}}else{out({type:'progress',phase:'preparing'});}return;}if(b.type==='cancel'){out({type:'progress',phase:'cleaning'});out(session?{type:'result',outcome:'cancelled',session_state:'unknown',error_code:'cancelled',cleanup:'verified'}:{type:'result',outcome:'cancelled',error_code:'cancelled',cleanup:'verified',result:null});lines.close();process.stdin.destroy();}});"##.into()
}
fn session_start(id: &str, action: &str) -> crate::profile_session::Start {
    serde_json::from_value(
        json!({"schema_version":"1.0","request_id":id,"profile_id":PROFILE,"action":action}),
    )
    .unwrap()
}
struct Pair(Arc<ProfileSession>, Arc<TaskRun>);
impl Pair {
    fn new() -> Self {
        let pair = Self(
            Arc::new(ProfileSession::default()),
            Arc::new(TaskRun::default()),
        );
        link(&pair.1, &pair.0);
        pair
    }
}
impl Drop for Pair {
    fn drop(&mut self) {
        self.0.shutdown();
        self.1.shutdown();
        let deadline = Instant::now() + Duration::from_secs(40);
        while (self.0.active() || self.1.active()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}
fn session_phase(sessions: &ProfileSession) -> Value {
    value(&sessions.status())["operation"]["phase"].clone()
}
#[test]
fn task_runs_and_account_operations_never_overlap() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(&universal_worker());
    let dir = fixture.directory.clone();
    // An active account operation blocks a task run.
    {
        let pair = Pair::new();
        pair.0
            .start(session_start(ID, "login"), root.clone(), dir.clone())
            .unwrap();
        assert!(pair.0.active());
        assert!(pair
            .1
            .start(start(OTHER), root.clone(), dir.clone())
            .is_err());
        assert!(pair.1.status().operation.is_none() && !pair.1.active());
        pair.0.shutdown();
        while pair.0.active() {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(session_phase(&pair.0), json!("finished"));
    }
    // An active task run blocks every account operation, then releases it.
    {
        let pair = Pair::new();
        pair.1.start(start(ID), root.clone(), dir.clone()).unwrap();
        assert!(pair.1.active());
        for action in ["login", "status", "logout"] {
            assert!(pair
                .0
                .start(session_start(OTHER, action), root.clone(), dir.clone())
                .is_err());
        }
        assert_eq!(session_phase(&pair.0), Value::Null);
        let running = wait(&pair.1, Phase::Preparing);
        pair.1.cancel(cancel(ID, running.revision)).unwrap();
        wait(&pair.1, Phase::Finished);
        assert_eq!(current(&pair.1).outcome, Some(Outcome::Cancelled));
        pair.0
            .start(session_start(OTHER, "status"), root.clone(), dir.clone())
            .unwrap();
        while session_phase(&pair.0) != json!("finished") {
            thread::sleep(Duration::from_millis(10));
        }
        // A finished account operation no longer blocks a task run.
        pair.1
            .start(start(OTHER), root.clone(), dir.clone())
            .unwrap();
        assert_eq!(current(&pair.1).request_id, OTHER);
    }
    // Simultaneous admission may deny both but never admits both.
    for _ in 0..6 {
        let pair = Pair::new();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let admitted = thread::scope(|scope| {
            let session = scope.spawn(|| {
                barrier.wait();
                pair.0
                    .start(session_start(ID, "login"), root.clone(), dir.clone())
                    .is_ok()
            });
            let run = scope.spawn(|| {
                barrier.wait();
                pair.1
                    .start(start(OTHER), root.clone(), dir.clone())
                    .is_ok()
            });
            [session.join().unwrap(), run.join().unwrap()]
        });
        assert!(!(admitted[0] && admitted[1]), "both admitted");
    }
}

#[test]
fn main_only_acl_and_wrappers_reject_remote_extra_raw_and_url_payloads() {
    let mut context = crate::application_context();
    let fixture = Fixture::new();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(fixture.directory.clone()),
    );
    let app = mock_builder()
        .manage(Arc::new(TaskRun::default()))
        .invoke_handler(tauri::generate_handler![
            local_task_run_start,
            local_task_run_status,
            local_task_run_cancel
        ])
        .build(context)
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = WebviewWindowBuilder::new(&app, "other", Default::default())
        .build()
        .unwrap();
    let local = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let invoke = |window: &tauri::WebviewWindow<MockRuntime>,
                  url: &str,
                  command: &str,
                  body: InvokeBody|
     -> Result<InvokeResponseBody, Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body,
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let status = invoke(
        &main,
        local,
        "local_task_run_status",
        InvokeBody::Json(json!({})),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(
        status,
        json!({"schema_version":"1.0","availability":"available","operation":null})
    );
    for (command, body) in [
        (
            "local_task_run_start",
            json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"task_id":TASK_ID,"approved":true}}),
        ),
        ("local_task_run_status", json!({})),
        (
            "local_task_run_cancel",
            json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":0}}),
        ),
    ] {
        assert!(invoke(&other, local, command, InvokeBody::Json(body.clone())).is_err());
        for remote in [
            "https://example.invalid",
            "http://localhost:1420",
            "http://127.0.0.1:1421",
            "https://tauri.localhost.example.invalid",
        ] {
            assert!(invoke(&main, remote, command, InvokeBody::Json(body.clone())).is_err());
        }
        for hostile in [
            json!(null),
            json!({"request":body,"extra":true}),
            json!({"url":"https://example.invalid"}),
            json!({"path":"PRIVATE_PATH"}),
        ] {
            assert!(invoke(&main, local, command, InvokeBody::Json(hostile)).is_err());
        }
        assert!(invoke(&main, local, command, InvokeBody::Raw(vec![])).is_err());
    }
    // Caller-owned execution inputs never reach admission, even from main.
    for request in [
        json!({"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"task_id":TASK_ID,"approved":false}),
        json!({"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"task_id":TASK_ID,"approved":true,"model":"opus"}),
        json!({"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"task_id":"other-task","approved":true}),
    ] {
        assert_eq!(
            invoke(
                &main,
                local,
                "local_task_run_start",
                InvokeBody::Json(json!({"request":request}))
            )
            .unwrap_err(),
            json!(DENIED)
        );
    }
    // A syntactically valid cancel finds nothing to cancel.
    assert_eq!(
        invoke(
            &main,
            local,
            "local_task_run_cancel",
            InvokeBody::Json(
                json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":0}})
            )
        )
        .unwrap_err(),
        json!(DENIED)
    );
    assert_eq!(fs::read_dir(&fixture.directory).unwrap().count(), 0);
}
