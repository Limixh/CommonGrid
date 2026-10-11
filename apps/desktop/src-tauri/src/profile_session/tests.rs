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
}
#[test]
fn result_and_challenge_contracts_fail_closed() {
    let good = Challenge {
        verification_url: "https://auth.openai.com/codex/device".into(),
        user_code: "ABCD-1234".into(),
    };
    assert!(good.valid());
    for challenge in [
        Challenge {
            verification_url: "https://auth.openai.com/codex/device?secret=private".into(),
            ..good.clone()
        },
        Challenge {
            user_code: "abcD".into(),
            ..good.clone()
        },
        Challenge {
            user_code: "X".repeat(33),
            ..good.clone()
        },
        Challenge {
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
            challenge: Some(Challenge {
                verification_url: "https://auth.openai.com/codex/device".into(),
                user_code: "FIXTURE-1234".into(),
            }),
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
            challenge: Challenge {
                verification_url: "https://auth.openai.com/codex/device".into(),
                user_code: "LATE-1234".into()
            }
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
            local_profile_session_open_device
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
