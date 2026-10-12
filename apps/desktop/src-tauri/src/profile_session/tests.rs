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
const ID: &str = "11111111-1111-4111-8111-111111111111";
const PROFILE: &str = "22222222-2222-4222-8222-222222222222";
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "cg-profile-session-{}-{}-{}",
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
        fs::write(root.join("worker.mjs"), source).unwrap();
        fs::write(root.join("manifest.json"), json!({"schema_version":"1.0", "node_sha256":digest(&root.join(node_name())).unwrap(), "worker_sha256":digest(&root.join("worker.mjs")).unwrap()}).to_string()).unwrap();
        root
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
struct Owner(Arc<ProfileSession>);
impl Owner {
    fn new() -> Self {
        Self(Arc::new(ProfileSession::default()))
    }
}
impl std::ops::Deref for Owner {
    type Target = Arc<ProfileSession>;
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
fn start(action: Action) -> Start {
    Start {
        schema_version: "1.0".into(),
        request_id: ID.into(),
        profile_id: PROFILE.into(),
        action,
    }
}
fn wait(owner: &ProfileSession, phase: Phase) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(operation) = owner.status().operation {
            if operation.phase == phase {
                return operation;
            }
        }
        assert!(
            Instant::now() < deadline,
            "synthetic worker did not reach phase {phase:?}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
const PASS: &str = r#"import{createInterface}from'node:readline';import path from'node:path';const lines=createInterface({input:process.stdin});lines.once('line',line=>{const b=JSON.parse(line);const keys=['type','schema_version','request_id','profile_id','provider','action','journal_root','assets_root','profile_registry_root'];if(Object.keys(b).sort().join()!==keys.sort().join()||b.type!=='profile_session_boot'||b.schema_version!=='1.0'||b.provider!=='codex'||b.action!=='status'||path.basename(b.profile_registry_root)!=='managed-profiles'||path.basename(b.journal_root)!=='managed-operation-journal'||path.basename(b.assets_root)!=='assets')process.exit(2);for(const phase of ['preparing','checking','cleaning'])console.log(JSON.stringify({type:'progress',phase}));console.log(JSON.stringify({type:'result',outcome:'passed',session_state:'unauthenticated',error_code:null,cleanup:'verified'}));lines.close();process.stdin.destroy();});"#;
fn claude_url() -> String {
    let mut url = tauri::Url::parse("https://claude.com/cai/oauth/authorize").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("code", "true"),
        ("client_id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
        ("response_type", "code"),
        ("redirect_uri", "https://platform.claude.com/oauth/code/callback"),
        ("scope", "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"),
        ("code_challenge", &"B".repeat(43)),
        ("code_challenge_method", "S256"),
        ("state", &"A".repeat(43)),
    ]);
    url.into()
}
fn claude_waiting() -> (ProfileSession, mpsc::Receiver<String>, mpsc::Receiver<()>) {
    let owner = ProfileSession::default();
    let (code_tx, codes) = mpsc::sync_channel(1);
    let (cancel_tx, cancellation) = mpsc::sync_channel(1);
    {
        let mut inner = owner.inner.lock().unwrap();
        inner.cancel = Some(cancel_tx);
        inner.code_input = Some(code_tx);
        inner.status.operation = Some(Operation {
            request_id: ID.into(),
            profile_id: PROFILE.into(),
            provider: Provider::Claude,
            action: Action::Login,
            revision: 4,
            phase: Phase::WaitingForLogin,
            outcome: None,
            session_state: SessionState::Unknown,
            challenge: Some(Challenge::Claude(ClaudeChallenge {
                authorization_url: claude_url(),
            })),
            error_code: None,
            cleanup: Cleanup::Pending,
        });
    }
    (owner, codes, cancellation)
}
fn submit(revision: u32, code: String) -> SubmitCode {
    SubmitCode {
        schema_version: "1.0".into(),
        request_id: ID.into(),
        expected_revision: revision,
        code,
    }
}
fn open_claude(revision: u32) -> OpenClaude {
    OpenClaude {
        schema_version: "1.0".into(),
        request_id: ID.into(),
        expected_revision: revision,
    }
}
#[test]
fn claude_challenge_and_code_are_bound_to_the_pinned_official_flow() {
    let good = claude_url();
    assert_eq!(claude_url_state(&good).unwrap(), "A".repeat(43));
    assert!(Challenge::Claude(ClaudeChallenge {
        authorization_url: good.clone()
    })
    .valid_for(Provider::Claude));
    assert!(!Challenge::Claude(ClaudeChallenge {
        authorization_url: good.clone()
    })
    .valid_for(Provider::Codex));
    for hostile in [
        good.replace("https://claude.com/", "http://claude.com/"),
        good.replace("https://claude.com/", "https://claude.com:443/"),
        good.replace("https://claude.com/", "https://claude.com.example.invalid/"),
        good.replace("https://claude.com/", "https://user@claude.com/"),
        good.replace("/cai/oauth/authorize?", "/oauth/authorize?"),
        good.replace("code=true", "code=false"),
        good.replace("code_challenge_method=S256", "code_challenge_method=plain"),
        good.replace("user%3Aplugins", "user%3Aprivileged"),
        good.replace("platform.claude.com", "example.invalid"),
        format!("{good}&state={}", "A".repeat(43)),
        format!("{good}&private=unknown"),
        format!("{good}#fragment"),
        format!("{good}\n"),
        format!("{good}\\"),
        "X".repeat(2049),
    ] {
        assert!(claude_url_state(&hostile).is_none());
    }
    let code = format!("FIXTURE_AUTHORIZATION#{}", "A".repeat(43));
    assert_eq!(claude_code_state(&code), Some("A".repeat(43).as_str()));
    for hostile in [
        format!("{code}\n"),
        format!(" {code}"),
        format!("{code}#extra"),
        format!("bad.code#{}", "A".repeat(43)),
        format!("#{}", "A".repeat(43)),
        format!("token#{}", "A".repeat(42)),
        format!("{}#{}", "X".repeat(2048), "A".repeat(43)),
        format!("token\0#{}", "A".repeat(43)),
    ] {
        assert!(claude_code_state(&hostile).is_none());
    }
    for challenge in [
        json!({"authorization_url":good,"user_code":"PRIVATE"}),
        json!({"authorization_url":good,"extra":true}),
    ] {
        assert!(
            serde_json::from_value::<Frame>(json!({"type":"challenge","challenge":challenge}))
                .is_err()
        );
    }
}
#[test]
fn claude_submit_is_one_shot_revision_checked_transient_and_state_matched() {
    let (owner, codes, _cancel) = claude_waiting();
    assert_eq!(
        owner.claude_open_target(&open_claude(4)).unwrap(),
        claude_url()
    );
    assert!(owner.claude_open_target(&open_claude(3)).is_err());
    assert!(!owner.can_open_device());
    let code = format!("FIXTURE_AUTHORIZATION#{}", "A".repeat(43));
    assert!(owner.submit_code(submit(3, code.clone())).is_err());
    assert!(owner
        .submit_code(submit(4, format!("FIXTURE#{}", "B".repeat(43))))
        .is_err());
    assert!(codes.try_recv().is_err());
    let result = owner.submit_code(submit(4, code.clone())).unwrap();
    let operation = result.operation.as_ref().unwrap();
    assert_eq!(operation.revision, 5);
    assert_eq!(operation.phase, Phase::WaitingForLogin);
    assert!(operation.challenge.is_none());
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("FIXTURE_AUTHORIZATION"));
    assert_eq!(codes.try_recv().unwrap(), code);
    assert!(owner.submit_code(submit(5, code)).is_err());
    assert!(owner.claude_open_target(&open_claude(5)).is_err());
    let mut result = None;
    assert!(!owner.frame(
        ID,
        Frame::Challenge {
            challenge: Challenge::Claude(ClaudeChallenge {
                authorization_url: claude_url()
            })
        },
        &mut result
    ));
    owner.force_review();
    assert!(owner.inner.lock().unwrap().code_input.is_none());
}
#[test]
fn claude_controls_reject_wrong_operation_and_close_on_cancellation_or_shutdown() {
    for fault in ["provider", "action", "phase", "id", "cancel", "shutdown"] {
        let (owner, codes, _cancel) = claude_waiting();
        match fault {
            "cancel" => {
                owner
                    .cancel(Cancel {
                        schema_version: "1.0".into(),
                        request_id: ID.into(),
                        expected_revision: 4,
                    })
                    .unwrap();
            }
            "shutdown" => {
                owner.shutdown();
            }
            _ => {
                let mut inner = owner.inner.lock().unwrap();
                let operation = inner.status.operation.as_mut().unwrap();
                match fault {
                    "provider" => operation.provider = Provider::Codex,
                    "action" => operation.action = Action::Status,
                    "phase" => operation.phase = Phase::Cleaning,
                    "id" => operation.request_id = PROFILE.into(),
                    _ => unreachable!(),
                }
            }
        }
        assert!(owner
            .submit_code(submit(4, format!("FIXTURE#{}", "A".repeat(43))))
            .is_err());
        assert!(owner.claude_open_target(&open_claude(4)).is_err());
        assert!(codes.try_recv().is_err());
    }
}
#[test]
fn owned_claude_fixture_receives_only_the_bounded_operation_input() {
    let fixture = Fixture::new();
    fixture.registry("claude");
    let source = r#"import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});let boot;lines.on('line',line=>{const b=JSON.parse(line);if(!boot){boot=b;if(b.provider!=='claude'||b.action!=='login')process.exit(2);for(const phase of ['preparing','checking'])console.log(JSON.stringify({type:'progress',phase}));console.log(JSON.stringify({type:'challenge',challenge:{authorization_url:AUTHORIZATION_URL}}));}else{if(Object.keys(b).sort().join()!=='code,request_id,type'||b.type!=='claude_login_code'||b.request_id!==boot.request_id||b.code!=='FIXTURE_AUTHORIZATION#'+'A'.repeat(43))process.exit(3);console.log(JSON.stringify({type:'progress',phase:'cleaning'}));console.log(JSON.stringify({type:'result',outcome:'passed',session_state:'authenticated',error_code:null,cleanup:'verified'}));lines.close();process.stdin.destroy();}});"#
        .replace("AUTHORIZATION_URL", &serde_json::to_string(&claude_url()).unwrap());
    let root = fixture.resources(&source);
    let owner = Owner::new();
    owner
        .start(start(Action::Login), root, fixture.directory.clone())
        .unwrap();
    let operation = wait(&owner, Phase::WaitingForLogin);
    owner
        .submit_code(submit(
            operation.revision,
            format!("FIXTURE_AUTHORIZATION#{}", "A".repeat(43)),
        ))
        .unwrap();
    let result = wait(&owner, Phase::Finished);
    assert_eq!(result.outcome, Some(Outcome::Passed));
    assert_eq!(result.session_state, SessionState::Authenticated);
    assert_eq!(result.cleanup, Cleanup::Verified);
    assert!(result.challenge.is_none());
    assert!(!serde_json::to_string(&owner.status())
        .unwrap()
        .contains("FIXTURE_AUTHORIZATION"));
    assert!(owner.inner.lock().unwrap().code_input.is_none());
}
#[test]
fn exact_preflight_rejects_nested_large_and_caller_owned_inputs() {
    let valid = json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"action":"login"}});
    assert!(preflight(&valid, Shape::Start));
    assert!(preflight(&json!({}), Shape::Status));
    for value in [
        json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"action":"login","provider":"codex"}}),
        json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":"x".repeat(100000),"action":"login"}}),
        json!({"request":{"schema_version":"1.0","request_id":{"private":"nested"},"profile_id":PROFILE,"action":"login"}}),
        json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"action":"shell"}}),
        json!({"request":valid,"path":"private"}),
    ] {
        assert!(!preflight(&value, Shape::Start));
    }
    assert!(!preflight(
        &json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":-1}}),
        Shape::Cancel
    ));
    assert!(!preflight(
        &json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":1000000001u64}}),
        Shape::Cancel
    ));
    assert!(!preflight(
        &json!({"url":"https://example.invalid"}),
        Shape::Status
    ));
    let code = format!("FIXTURE_AUTHORIZATION#{}", "A".repeat(43));
    assert!(preflight(
        &json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":4,"code":code}}),
        Shape::SubmitCode
    ));
    assert!(preflight(
        &json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":4}}),
        Shape::OpenClaude
    ));
    for hostile in [
        json!(null),
        json!([code.clone()]),
        json!(format!("{code}\r\n")),
        json!("x".repeat(100000)),
        json!(true),
    ] {
        assert!(!preflight(
            &json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":4,"code":hostile}}),
            Shape::SubmitCode
        ));
    }
    assert!(!preflight(
        &json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":4,"url":claude_url()}}),
        Shape::OpenClaude
    ));
}
#[test]
fn result_and_challenge_contracts_fail_closed() {
    let good = DeviceChallenge {
        verification_url: "https://auth.openai.com/codex/device".into(),
        user_code: "ABCD-1234".into(),
    };
    assert!(good.valid());
    for challenge in [
        DeviceChallenge {
            verification_url: "https://auth.openai.com/codex/device?secret=private".into(),
            ..good.clone()
        },
        DeviceChallenge {
            user_code: "abcD".into(),
            ..good.clone()
        },
        DeviceChallenge {
            user_code: "X".repeat(33),
            ..good.clone()
        },
        DeviceChallenge {
            user_code: "ABC\nPRIVATE".into(),
            ..good.clone()
        },
    ] {
        assert!(!challenge.valid());
    }
    assert!(valid_result(
        Action::Login,
        Outcome::Passed,
        SessionState::Authenticated,
        &None,
        Cleanup::Verified
    ));
    assert!(!valid_result(
        Action::Login,
        Outcome::Passed,
        SessionState::Unauthenticated,
        &None,
        Cleanup::Verified
    ));
    assert!(!valid_result(
        Action::Logout,
        Outcome::Passed,
        SessionState::Authenticated,
        &None,
        Cleanup::Verified
    ));
    assert!(!valid_result(
        Action::Status,
        Outcome::Passed,
        SessionState::Unknown,
        &None,
        Cleanup::Verified
    ));
    assert!(!valid_result(
        Action::Status,
        Outcome::Failed,
        SessionState::Unknown,
        &Some("PRIVATE_ERROR".into()),
        Cleanup::Verified
    ));
    assert!(!valid_result(
        Action::Status,
        Outcome::NeedsReview,
        SessionState::Unknown,
        &Some("cleanup_failed".into()),
        Cleanup::Verified
    ));
    assert!(serde_json::from_value::<Frame>(json!({"type":"result", "outcome":"passed", "session_state":"authenticated", "cleanup":"verified"})).is_err());
    assert!(serde_json::from_value::<Frame>(json!({"type":"challenge", "challenge":{"verification_url":good.verification_url,"user_code":good.user_code,"private":"secret"}})).is_err());
}
#[test]
fn owned_fixture_boot_resolves_saved_provider_and_truthful_status() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(PASS);
    let owner = Owner::new();
    let admitted = owner
        .start(
            start(Action::Status),
            root.clone(),
            fixture.directory.clone(),
        )
        .unwrap();
    assert_eq!(admitted.operation.unwrap().provider, Provider::Codex);
    let result = wait(&owner, Phase::Finished);
    assert_eq!(result.outcome, Some(Outcome::Passed));
    assert_eq!(result.session_state, SessionState::Unauthenticated);
    assert_eq!(result.cleanup, Cleanup::Verified);
    assert!(result.challenge.is_none());
    assert_eq!(
        serde_json::to_value(owner.status())
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        serde_json::to_value(&result)
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        11
    );
    assert!(owner
        .start(
            start(Action::Status),
            root.clone(),
            fixture.directory.clone()
        )
        .is_ok());
    assert!(owner
        .start(start(Action::Logout), root, fixture.directory.clone())
        .is_err());
}
#[test]
fn cancellation_clears_challenge_and_late_frames_never_redisplay_it() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources(r#"import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});let boot=false;lines.on('line',line=>{const b=JSON.parse(line);if(!boot){boot=true;for(const phase of ['preparing','checking'])console.log(JSON.stringify({type:'progress',phase}));console.log(JSON.stringify({type:'challenge',challenge:{verification_url:'https://auth.openai.com/codex/device',user_code:'FIXTURE-1234'}}));}else if(b.type==='cancel'){console.log(JSON.stringify({type:'challenge',challenge:{verification_url:'https://auth.openai.com/codex/device',user_code:'LATE-1234'}}));setTimeout(()=>{console.log(JSON.stringify({type:'progress',phase:'cleaning'}));console.log(JSON.stringify({type:'result',outcome:'passed',session_state:'authenticated',error_code:null,cleanup:'verified'}));lines.close();process.stdin.destroy();},200);}});"#);
    let owner = Owner::new();
    owner
        .start(start(Action::Login), root, fixture.directory.clone())
        .unwrap();
    let waiting = wait(&owner, Phase::WaitingForLogin);
    assert!(owner.can_open_device());
    assert!(owner
        .cancel(Cancel {
            schema_version: "1.0".into(),
            request_id: ID.into(),
            expected_revision: waiting.revision - 1
        })
        .is_err());
    let cleared = owner
        .cancel(Cancel {
            schema_version: "1.0".into(),
            request_id: ID.into(),
            expected_revision: waiting.revision,
        })
        .unwrap()
        .operation
        .unwrap();
    assert_eq!(cleared.revision, waiting.revision + 1);
    assert!(cleared.challenge.is_none());
    assert!(!owner.can_open_device());
    let result = wait(&owner, Phase::Finished);
    assert_eq!(result.outcome, Some(Outcome::Cancelled));
    assert_eq!(result.session_state, SessionState::Unknown);
    assert!(result.challenge.is_none());
    assert_eq!(result.cleanup, Cleanup::Verified);
    assert_eq!(result.error_code.as_deref(), Some("cancelled"));
}
#[test]
fn shutdown_clears_transient_challenge_before_worker_cleanup() {
    let owner = ProfileSession::default();
    let (sender, _receiver) = mpsc::sync_channel(1);
    {
        let mut inner = owner.inner.lock().unwrap();
        inner.cancel = Some(sender);
        inner.status.operation = Some(Operation {
            request_id: ID.into(),
            profile_id: PROFILE.into(),
            provider: Provider::Codex,
            action: Action::Login,
            revision: 4,
            phase: Phase::WaitingForLogin,
            outcome: None,
            session_state: SessionState::Unknown,
            challenge: Some(Challenge::Codex(DeviceChallenge {
                verification_url: "https://auth.openai.com/codex/device".into(),
                user_code: "FIXTURE-1234".into(),
            })),
            error_code: None,
            cleanup: Cleanup::Pending,
        });
    }
    assert!(owner.can_open_device());
    assert!(owner.shutdown());
    let operation = owner.status().operation.unwrap();
    assert_eq!(operation.revision, 5);
    assert!(operation.challenge.is_none());
    assert!(!owner.can_open_device());
    let mut result = None;
    assert!(owner.frame(
        ID,
        Frame::Challenge {
            challenge: Challenge::Codex(DeviceChallenge {
                verification_url: "https://auth.openai.com/codex/device".into(),
                user_code: "LATE-1234".into()
            })
        },
        &mut result
    ));
    assert!(owner.status().operation.unwrap().challenge.is_none());
    owner.force_review();
    let result = owner.status().operation.unwrap();
    assert_eq!(result.outcome, Some(Outcome::NeedsReview));
    assert_eq!(result.cleanup, Cleanup::Unknown);
}
#[test]
fn worker_protocol_violation_cannot_claim_cleanup_or_expose_raw_output() {
    let fixture = Fixture::new();
    fixture.registry("codex");
    let root = fixture.resources("process.stdin.once('data',()=>{console.log('PRIVATE_AUTH'.repeat(1000));setInterval(()=>{},1000);});");
    let owner = Owner::new();
    owner
        .start(start(Action::Status), root, fixture.directory.clone())
        .unwrap();
    let result = wait(&owner, Phase::Finished);
    assert_eq!(result.outcome, Some(Outcome::NeedsReview));
    assert_eq!(result.cleanup, Cleanup::Unknown);
    assert_eq!(result.error_code.as_deref(), Some("worker_failed"));
    assert!(!serde_json::to_string(&owner.status())
        .unwrap()
        .contains("PRIVATE"));
}
#[test]
fn unsupported_login_is_truthful_and_no_assets_are_required_for_invalid_profile() {
    let fixture = Fixture::new();
    let owner = Owner::new();
    assert!(owner
        .start(
            start(Action::Login),
            fixture.directory.join("absent"),
            fixture.directory.clone()
        )
        .is_err());
    assert!(!fixture
        .directory
        .join("profile-session-worker-home")
        .exists());
    fixture.registry("claude");
    let root = fixture.resources(r#"process.stdin.once('data',()=>{console.log(JSON.stringify({type:'progress',phase:'cleaning'}));console.log(JSON.stringify({type:'result',outcome:'failed',session_state:'unknown',error_code:'unsupported',cleanup:'verified'}));process.stdin.destroy();});"#);
    owner
        .start(start(Action::Login), root, fixture.directory.clone())
        .unwrap();
    let result = wait(&owner, Phase::Finished);
    assert_eq!(result.provider, Provider::Claude);
    assert_eq!(result.outcome, Some(Outcome::Failed));
    assert_eq!(result.error_code.as_deref(), Some("unsupported"));
    assert_eq!(result.session_state, SessionState::Unknown);
    assert_eq!(result.cleanup, Cleanup::Verified);
}
#[test]
fn main_only_acl_and_wrappers_reject_remote_extra_raw_and_url_payloads() {
    let mut context = crate::application_context();
    let fixture = Fixture::new();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(fixture.directory.clone()),
    );
    let app = mock_builder()
        .manage(Arc::new(ProfileSession::default()))
        .invoke_handler(tauri::generate_handler![
            local_profile_session_start,
            local_profile_session_status,
            local_profile_session_cancel,
            local_profile_session_open_device,
            local_profile_session_submit_code,
            local_profile_session_open_claude
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
        "local_profile_session_status",
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
            "local_profile_session_start",
            json!({"request":{"schema_version":"1.0","request_id":ID,"profile_id":PROFILE,"action":"login"}}),
        ),
        ("local_profile_session_status", json!({})),
        (
            "local_profile_session_cancel",
            json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":0}}),
        ),
        ("local_profile_session_open_device", json!({})),
        (
            "local_profile_session_submit_code",
            json!({"request":{"schema_version":"1.0","request_id":ID,"expected_revision":0,"code":format!("FIXTURE#{}", "A".repeat(43))}}),
        ),
        (
            "local_profile_session_open_claude",
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
    // No actual browser open is performed: the idle operation rejects the click.
    assert_eq!(
        invoke(
            &main,
            local,
            "local_profile_session_open_device",
            InvokeBody::Json(json!({}))
        )
        .unwrap_err(),
        json!(DENIED)
    );
    assert_eq!(fs::read_dir(&fixture.directory).unwrap().count(), 0);
}
