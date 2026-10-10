use super::*;
use tauri::{
    ipc::{CallbackFn, InvokeResponseBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindowBuilder,
};
const ID: &str = "c9cd1d28-006f-48f1-85d5-fc9430a7ae23";
struct TestOwner(Arc<Launcher>);
impl std::ops::Deref for TestOwner {
    type Target = Arc<Launcher>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Drop for TestOwner {
    fn drop(&mut self) {
        self.0.shutdown();
        let deadline = Instant::now() + Duration::from_secs(35);
        while self.0.active() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}
struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "cg-launcher-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir(&directory).unwrap();
        Self { directory }
    }
    fn resources(&self, source: &str) -> PathBuf {
        let root = self.directory.join("launcher");
        fs::create_dir(&root).unwrap();
        // Use the prepared product runtime. PATH can contain a Volta shim,
        // which is not a standalone Node binary and needs ambient home data.
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
        fs::write(root.join("manifest.json"),serde_json::json!({"schema_version":"1.0","node_sha256":digest(&root.join(node_name())).unwrap(),"worker_sha256":digest(&root.join("worker.mjs")).unwrap()}).to_string()).unwrap();
        root
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Windows can retain a just-exited Node image briefly. Retry only this
        // fixture's verified absolute directory, never any linked target.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match fs::remove_dir_all(&self.directory) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                Err(_) if thread::panicking() => {
                    eprintln!("synthetic fixture cleanup unconfirmed after test panic");
                    break;
                }
                Err(error) => panic!("synthetic fixture cleanup failed: {error}"),
            }
        }
    }
}
fn start(provider: Provider) -> Start {
    Start {
        schema_version: "1.0".into(),
        request_id: ID.into(),
        provider,
    }
}
fn terminal(owner: &Launcher) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if let Some(value) = owner.status().operation {
            if value.phase == Phase::Finished {
                return value;
            }
        }
        assert!(Instant::now() < deadline, "synthetic worker did not finish");
        thread::sleep(Duration::from_millis(10));
    }
}
const PASS: &str = r#"import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});lines.once('line',line=>{const b=JSON.parse(line);if(b.type!=='boot'||b.schema_version!=='1.0')process.exit(2);console.log(JSON.stringify({type:'progress',phase:'preparing'}));console.log(JSON.stringify({type:'progress',phase:'checking'}));console.log(JSON.stringify({type:'progress',phase:'cleaning'}));console.log(JSON.stringify({type:'result',outcome:'passed',cli_version:'fixture-cli 1.2.3',error_code:null,cleanup:'verified'}));lines.close();process.stdin.destroy();});"#;
#[test]
fn protocol_rejects_unknown_fields_and_invalid_terminal_claims() {
    assert!(valid_result(
        Outcome::Failed,
        &None,
        &Some("image_missing".into()),
        Cleanup::Verified,
    ));
    assert!(serde_json::from_str::<Frame>(r#"{"type":"progress","phase":"preparing"}"#).is_ok());
    assert!(serde_json::from_str::<Frame>(r#"{"type":"result","outcome":"passed","cli_version":"fixture 1.0","error_code":null,"cleanup":"verified"}"#).is_ok());
    assert!(serde_json::from_value::<Wrapper<Start>>(serde_json::json!({"request":{"schema_version":"1.0","request_id":ID,"provider":"codex","argv":[]}})).is_err());
    assert!(serde_json::from_value::<Wrapper<Start>>(serde_json::json!({"request":{"schema_version":"1.0","request_id":ID,"provider":"codex"},"root":"ignored"})).is_err());
    assert!(!uuid("c9cd1d28-006f-18f1-85d5-fc9430a7ae23"));
    assert!(!valid_result(
        Outcome::Passed,
        &Some("1.0\nsecret".into()),
        &None,
        Cleanup::Verified
    ));
    assert!(!valid_result(
        Outcome::Passed,
        &Some("1.0".into()),
        &None,
        Cleanup::Unknown
    ));
    assert!(!valid_result(
        Outcome::Failed,
        &None,
        &Some("raw failure".into()),
        Cleanup::Verified
    ));
    assert!(serde_json::from_str::<Frame>(r#"{"type":"result","outcome":"passed","cli_version":"1.0","cleanup":"verified","error_code":null,"argv":[]}"#).is_err());
    assert!(!progress(Phase::Checking, Phase::Preparing));
}
#[test]
fn unavailable_assets_cannot_create_operation_or_home() {
    let fixture = Fixture::new();
    let owner = TestOwner(Arc::new(Launcher::default()));
    assert_eq!(
        owner
            .start(
                start(Provider::Codex),
                fixture.directory.join("missing"),
                fixture.directory.join("store")
            )
            .unwrap()
            .availability,
        "available"
    );
    let result = terminal(&owner);
    assert_eq!(result.outcome, Some(Outcome::Failed));
    assert_eq!(result.cleanup, Cleanup::Verified);
    assert_eq!(result.error_code.as_deref(), Some("asset_missing"));
    assert!(!fixture.directory.join("store").exists());
    assert!(!owner.active());
    assert!(owner
        .cancel(Cancel {
            schema_version: "1.0".into(),
            request_id: ID.into(),
            expected_revision: 0
        })
        .is_err());
}
#[test]
fn owned_fixture_result_is_version_only_and_request_is_idempotent() {
    let fixture = Fixture::new();
    let root = fixture.resources(PASS);
    let owner = TestOwner(Arc::new(Launcher::default()));
    let first = owner
        .start(
            start(Provider::Codex),
            root.clone(),
            fixture.directory.clone(),
        )
        .unwrap();
    assert_eq!(first.operation.unwrap().revision, 0);
    let operation = terminal(&owner);
    assert_eq!(operation.outcome, Some(Outcome::Passed));
    assert_eq!(operation.cleanup, Cleanup::Verified);
    assert_eq!(operation.revision, 4);
    let repeated = owner
        .start(
            start(Provider::Codex),
            root.clone(),
            fixture.directory.clone(),
        )
        .unwrap();
    assert_eq!(repeated.operation.unwrap().revision, 4);
    assert!(owner
        .start(start(Provider::Claude), root, fixture.directory.clone())
        .is_err());
    assert!(!owner.active());
}
#[test]
fn cancellation_is_revision_bound_and_shutdown_prevents_restart() {
    let fixture = Fixture::new();
    let root=fixture.resources(r#"import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});lines.on('line',line=>{const b=JSON.parse(line);if(b.type==='boot'){console.log(JSON.stringify({type:'progress',phase:'preparing'}));}else if(b.type==='cancel'){console.log(JSON.stringify({type:'progress',phase:'cleaning'}));console.log(JSON.stringify({type:'result',outcome:'cancelled',cli_version:null,error_code:'cancelled',cleanup:'verified'}));lines.close();process.stdin.destroy();}});"#);
    let owner = TestOwner(Arc::new(Launcher::default()));
    owner
        .start(
            start(Provider::Claude),
            root.clone(),
            fixture.directory.clone(),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    let operation = loop {
        let value = owner.status().operation.unwrap();
        if value.phase == Phase::Preparing {
            break value;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    };
    assert!(owner
        .cancel(Cancel {
            schema_version: "1.0".into(),
            request_id: ID.into(),
            expected_revision: operation.revision - 1
        })
        .is_err());
    assert!(owner.shutdown());
    let final_value = terminal(&owner);
    assert_eq!(final_value.outcome, Some(Outcome::Cancelled));
    assert_eq!(final_value.cleanup, Cleanup::Verified);
    assert!(owner
        .start(start(Provider::Claude), root, fixture.directory.clone())
        .is_err());
}
#[test]
fn malformed_worker_output_cannot_claim_cleanup_verified() {
    let fixture = Fixture::new();
    let root = fixture.resources(
        "process.stdin.once('data',()=>{console.log('x'.repeat(9000));setInterval(()=>{},1000);});",
    );
    let owner = TestOwner(Arc::new(Launcher::default()));
    owner
        .start(start(Provider::Codex), root, fixture.directory.clone())
        .unwrap();
    let result = terminal(&owner);
    assert_eq!(result.outcome, Some(Outcome::NeedsReview));
    assert_eq!(result.cleanup, Cleanup::Unknown);
    assert_eq!(result.error_code.as_deref(), Some("worker_failed"));
}
#[test]
fn unexpected_root_exit_terminates_its_owned_descendant() {
    let fixture = Fixture::new();
    let root=fixture.resources(r#"import{createInterface}from'node:readline';import{spawn}from'node:child_process';import fs from'node:fs';import path from'node:path';const lines=createInterface({input:process.stdin});lines.once('line',line=>{const home=path.dirname(JSON.parse(line).journal_root);const ready=path.join(home,'ready');const late=path.join(home,'late');spawn(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(ready)},'fixture');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'forbidden'),2000)`],{stdio:'inherit',windowsHide:true});const timer=setInterval(()=>{if(fs.existsSync(ready)){clearInterval(timer);process.exit(1);}},10);});"#);
    let owner = TestOwner(Arc::new(Launcher::default()));
    owner
        .start(start(Provider::Codex), root, fixture.directory.clone())
        .unwrap();
    let result = terminal(&owner);
    assert_eq!(result.outcome, Some(Outcome::NeedsReview));
    assert_eq!(result.cleanup, Cleanup::Unknown);
    assert!(fixture.directory.join("ready").exists());
    thread::sleep(Duration::from_millis(2300));
    assert!(!fixture.directory.join("late").exists());
}
#[test]
fn a_result_before_cleaning_cannot_claim_passed() {
    let fixture = Fixture::new();
    let root=fixture.resources(r#"process.stdin.once('data',()=>{console.log(JSON.stringify({type:'result',outcome:'passed',cli_version:'fixture 1.0',error_code:null,cleanup:'verified'}));process.stdin.destroy();});"#);
    let owner = TestOwner(Arc::new(Launcher::default()));
    owner
        .start(start(Provider::Codex), root, fixture.directory.clone())
        .unwrap();
    let result = terminal(&owner);
    assert_eq!(result.outcome, Some(Outcome::NeedsReview));
    assert_eq!(result.cleanup, Cleanup::Unknown);
}
#[test]
fn linked_worker_home_and_config_are_rejected_before_spawn() {
    let fixture = Fixture::new();
    let target = Fixture::new();
    let home = fixture.directory.join("home");
    fs::create_dir(&home).unwrap();
    let linked = home.join("docker");
    #[cfg(windows)]
    {
        assert!(std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&linked)
            .arg(&target.directory)
            .output()
            .unwrap()
            .status
            .success());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target.directory, &linked).unwrap();
    }
    assert!(OwnedWorker::spawn(
        &fixture.directory.join(node_name()),
        &fixture.directory.join("worker.mjs"),
        &home
    )
    .is_err());
    assert!(!home.join("tmp").exists());
    assert_eq!(fs::read_dir(&target.directory).unwrap().count(), 0);
    assert!(!safe_ancestors(&linked));
    assert!(!safe_ancestors(&linked.join("nested")));
    #[cfg(windows)]
    {
        fs::remove_dir(&linked).unwrap();
    }
    #[cfg(unix)]
    {
        fs::remove_file(&linked).unwrap();
    }
}
#[test]
fn application_acl_and_command_wrappers_reject_other_origins_and_arguments() {
    let mut context = crate::application_context();
    let fixture = Fixture::new();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(fixture.directory.clone()),
    );
    let app = mock_builder()
        .manage(Arc::new(Launcher::default()))
        .invoke_handler(tauri::generate_handler![
            local_cli_check_start,
            local_cli_check_status,
            local_cli_check_cancel
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
                  body: serde_json::Value|
     -> Result<InvokeResponseBody, serde_json::Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    assert!(invoke(
        &main,
        local,
        "local_cli_check_status",
        serde_json::json!({})
    )
    .is_ok());
    for command in [
        "local_cli_check_start",
        "local_cli_check_status",
        "local_cli_check_cancel",
    ] {
        assert!(invoke(&other, local, command, serde_json::json!({})).is_err());
        assert!(invoke(
            &main,
            "https://example.invalid",
            command,
            serde_json::json!({})
        )
        .is_err());
        assert!(invoke(
            &main,
            local,
            command,
            serde_json::json!({"shell":"ignored"})
        )
        .is_err());
    }
    for request in [
        serde_json::json!({"schema_version":"1.0","request_id":ID,"provider":"codex","argv":[]}),
        serde_json::json!({"schema_version":"1.0","request_id":ID,"provider":"other"}),
    ] {
        assert!(invoke(
            &main,
            local,
            "local_cli_check_start",
            serde_json::json!({"request":request})
        )
        .is_err());
    }
}
