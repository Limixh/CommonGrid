use super::*;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{
    ipc::{CallbackFn, InvokeResponseBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindow, WebviewWindowBuilder,
};

const ID: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_ID: &str = "22222222-2222-4222-8222-222222222222";
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "cg-profiles-{}-{stamp}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn root(&self) -> PathBuf {
        self.0.join("managed-profiles")
    }
    fn write(&self, value: Value) {
        fs::create_dir_all(self.root()).unwrap();
        fs::write(
            self.root().join("profiles.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn request(id: &str, revision: u32) -> Create {
    Create {
        schema_version: "1.0".into(),
        request_id: id.into(),
        provider: Provider::Codex,
        name: "Kişisel Codex".into(),
        expected_revision: revision,
    }
}
fn selection(id: &str, revision: u32) -> Select {
    Select {
        schema_version: "1.0".into(),
        profile_id: id.into(),
        expected_revision: revision,
    }
}
fn public(catalog: Catalog) -> Value {
    serde_json::to_value(catalog.status()).unwrap()
}

#[test]
fn session_provider_lookup_requires_the_saved_selected_profile() {
    let fixture = Fixture::new();
    assert!(selected_provider(&fixture.root(), ID).is_err());
    assert!(!fixture.root().exists());
    create(&fixture.root(), request(ID, 0)).unwrap();
    create(&fixture.root(), request(OTHER_ID, 1)).unwrap();
    assert!(selected_provider(&fixture.root(), ID).is_err());
    select(&fixture.root(), selection(ID, 2)).unwrap();
    assert_eq!(selected_provider(&fixture.root(), ID), Ok(Provider::Codex));
    assert!(selected_provider(&fixture.root(), OTHER_ID).is_err());
    assert!(selected_provider(&fixture.root(), "../host-auth").is_err());
    fixture
        .write(json!({"schema_version":"1.0","revision":3,"profiles":[],"selected_profile_id":ID}));
    assert!(selected_provider(&fixture.root(), ID).is_err());
}

#[test]
fn missing_read_is_empty_without_creating_a_store_and_selection_survives_restart() {
    let fixture = Fixture::new();
    assert_eq!(
        public(read(&fixture.root()).unwrap()),
        json!({"schema_version":"1.0","availability":"available","revision":0,"profiles":[],"selected_profile_id":null})
    );
    assert!(!fixture.root().exists());
    let created = create(&fixture.root(), request(ID, 0)).unwrap();
    assert_eq!(created.revision, 1);
    assert_eq!(created.selected_profile_id, None);
    let selected = select(&fixture.root(), selection(ID, 1)).unwrap();
    assert_eq!(selected.revision, 2);
    assert_eq!(selected.selected_profile_id.as_deref(), Some(ID));
    let after_restart = read(&fixture.root()).unwrap();
    assert_eq!(after_restart.revision, 2);
    assert_eq!(after_restart.selected_profile_id.as_deref(), Some(ID));
    assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 2);
    let disk = fs::read_to_string(fixture.root().join("profiles.json")).unwrap();
    for private in [
        "owner",
        "authenticated",
        "auth_volume",
        "credential",
        "token",
        "account",
    ] {
        assert!(!disk.contains(private));
    }
}

#[test]
fn duplicate_create_is_idempotent_but_mismatch_and_stale_mutations_conflict() {
    let fixture = Fixture::new();
    create(&fixture.root(), request(ID, 0)).unwrap();
    select(&fixture.root(), selection(ID, 1)).unwrap();
    let before = fs::read(fixture.root().join("profiles.json")).unwrap();
    assert_eq!(create(&fixture.root(), request(ID, 0)).unwrap().revision, 2);
    let mut mismatch = request(ID, 0);
    mismatch.provider = Provider::Claude;
    assert_eq!(create(&fixture.root(), mismatch).unwrap_err(), CONFLICT);
    let mut mismatch = request(ID, 2);
    mismatch.name = "Other".into();
    assert_eq!(create(&fixture.root(), mismatch).unwrap_err(), CONFLICT);
    assert_eq!(
        create(&fixture.root(), request(OTHER_ID, 0)).unwrap_err(),
        CONFLICT
    );
    assert_eq!(
        select(&fixture.root(), selection(ID, 1)).unwrap_err(),
        CONFLICT
    );
    assert_eq!(
        select(&fixture.root(), selection(OTHER_ID, 2)).unwrap_err(),
        CONFLICT
    );
    assert_eq!(
        select(&fixture.root(), selection(ID, 2)).unwrap().revision,
        2
    );
    assert_eq!(
        fs::read(fixture.root().join("profiles.json")).unwrap(),
        before
    );
}

#[test]
fn invalid_names_identities_and_capacity_are_rejected_without_publication() {
    let fixture = Fixture::new();
    assert!(name(&"é".repeat(48)));
    assert!(!name(&"é".repeat(49)));
    assert!(name("😀 Türkçe"));
    for value in [
        "",
        " trailing ",
        "\u{feff}name",
        "name\u{feff}",
        "line\nfeed",
        "nul\0",
        "c1\u{85}",
        "c1\u{9f}",
    ] {
        let mut invalid = request(ID, 0);
        invalid.name = value.into();
        assert_eq!(create(&fixture.root(), invalid).unwrap_err(), DENIED);
    }
    for id in [
        "11111111-1111-1111-8111-111111111111",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        "../path",
    ] {
        assert_eq!(create(&fixture.root(), request(id, 0)).unwrap_err(), DENIED);
    }
    assert!(!fixture.root().exists());
    for index in 0..MAX_PROFILES {
        let id = format!("{index:08x}-1111-4111-8111-111111111111");
        create(&fixture.root(), request(&id, index as u32)).unwrap();
    }
    assert_eq!(
        create(&fixture.root(), request(OTHER_ID, 16)).unwrap_err(),
        CONFLICT
    );
    assert_eq!(read(&fixture.root()).unwrap().profiles.len(), 16);
}

#[test]
fn malformed_oversized_and_inconsistent_store_is_not_reset() {
    let fixture = Fixture::new();
    let baseline = serde_json::to_value(Catalog::empty()).unwrap();
    let mut missing = baseline.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("selected_profile_id");
    let mut unknown = baseline.clone();
    unknown["auth"] = json!("PRIVATE_DATA");
    let mut selected = baseline.clone();
    selected["selected_profile_id"] = json!(ID);
    let mut revision = baseline.clone();
    revision["revision"] = json!(MAX_REVISION + 1);
    let mut duplicate = baseline.clone();
    duplicate["profiles"] = json!([{"profile_id":ID,"provider":"codex","name":"A"},{"profile_id":ID,"provider":"claude","name":"B"}]);
    for invalid in [missing, unknown, selected, revision, duplicate] {
        fixture.write(invalid);
        let before = fs::read(fixture.root().join("profiles.json")).unwrap();
        assert_eq!(read(&fixture.root()).unwrap_err(), UNAVAILABLE);
        assert_eq!(
            create(&fixture.root(), request(ID, 0)).unwrap_err(),
            UNAVAILABLE
        );
        assert_eq!(
            fs::read(fixture.root().join("profiles.json")).unwrap(),
            before
        );
    }
    for bytes in [b"{malformed".to_vec(), vec![b' ';MAX_BYTES+1], b"{\"schema_version\":\"1.0\",\"schema_version\":\"1.0\",\"revision\":0,\"profiles\":[],\"selected_profile_id\":null}".to_vec()] {
        fs::write(fixture.root().join("profiles.json"),&bytes).unwrap(); assert_eq!(read(&fixture.root()).unwrap_err(),UNAVAILABLE);
        assert_eq!(select(&fixture.root(),selection(ID,0)).unwrap_err(),UNAVAILABLE);
        assert_eq!(fs::read(fixture.root().join("profiles.json")).unwrap(),bytes);
    }
}

#[test]
fn publication_failure_preserves_the_old_catalog_and_removes_only_its_temporary() {
    let fixture = Fixture::new();
    create(&fixture.root(), request(ID, 0)).unwrap();
    let before = fs::read(fixture.root().join("profiles.json")).unwrap();
    let mut changed = read(&fixture.root()).unwrap();
    changed.revision += 1;
    changed.selected_profile_id = Some(ID.into());
    let result = publish_with(&fixture.root(), &changed, || {
        assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 3);
        Err(UNAVAILABLE)
    });
    assert_eq!(result.unwrap_err(), UNAVAILABLE);
    assert_eq!(
        fs::read(fixture.root().join("profiles.json")).unwrap(),
        before
    );
    assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 2);
    let mut exhausted = read(&fixture.root()).unwrap();
    exhausted.revision = MAX_REVISION;
    publish(&fixture.root(), &exhausted).unwrap();
    assert_eq!(
        create(&fixture.root(), request(OTHER_ID, MAX_REVISION)).unwrap_err(),
        CONFLICT
    );
    assert_eq!(
        select(&fixture.root(), selection(ID, MAX_REVISION)).unwrap_err(),
        CONFLICT
    );
}

#[test]
fn directory_and_file_links_cannot_redirect_read_or_write() {
    let fixture = Fixture::new();
    let target = Fixture::new();
    #[cfg(windows)]
    junction(&fixture.root(), &target.0);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target.0, fixture.root()).unwrap();
    assert_eq!(read(&fixture.root()).unwrap_err(), UNAVAILABLE);
    assert_eq!(
        create(&fixture.root(), request(ID, 0)).unwrap_err(),
        UNAVAILABLE
    );
    assert_eq!(
        read(&fixture.root().join("absent")).unwrap_err(),
        UNAVAILABLE
    );
    assert_eq!(fs::read_dir(&target.0).unwrap().count(), 0);
    #[cfg(windows)]
    fs::remove_dir(fixture.root()).unwrap();
    #[cfg(unix)]
    fs::remove_file(fixture.root()).unwrap();
    fs::create_dir(fixture.root()).unwrap();
    let original = target.0.join("private");
    fs::write(&original, b"DO_NOT_READ_OR_REPLACE").unwrap();
    #[cfg(windows)]
    junction(&fixture.root().join("profiles.json"), &target.0);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&original, fixture.root().join("profiles.json")).unwrap();
    assert_eq!(read(&fixture.root()).unwrap_err(), UNAVAILABLE);
    assert_eq!(
        create(&fixture.root(), request(ID, 0)).unwrap_err(),
        UNAVAILABLE
    );
    assert_eq!(fs::read(&original).unwrap(), b"DO_NOT_READ_OR_REPLACE");
    #[cfg(windows)]
    fs::remove_dir(fixture.root().join("profiles.json")).unwrap();
    #[cfg(unix)]
    fs::remove_file(fixture.root().join("profiles.json")).unwrap();
    fs::create_dir(fixture.root().join("profiles.json")).unwrap();
    assert_eq!(read(&fixture.root()).unwrap_err(), UNAVAILABLE);
    assert_eq!(
        create(&fixture.root(), request(ID, 0)).unwrap_err(),
        UNAVAILABLE
    );
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    assert!(std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap()
        .status
        .success());
}

#[test]
fn independent_file_handles_cannot_mutate_until_the_owner_handle_is_dropped() {
    let fixture = Fixture::new();
    let first = mutation_lock(&fixture.root()).unwrap();
    assert_eq!(mutation_lock(&fixture.root()).unwrap_err(), CONFLICT);
    assert_eq!(
        create(&fixture.root(), request(ID, 0)).unwrap_err(),
        CONFLICT
    );
    assert!(!fixture.root().join("profiles.json").exists());
    drop(first);
    let next = mutation_lock(&fixture.root()).unwrap();
    drop(next);
    create(&fixture.root(), request(ID, 0)).unwrap();
    assert_eq!(
        create(&fixture.root(), request(OTHER_ID, 0)).unwrap_err(),
        CONFLICT
    );
    assert_eq!(read(&fixture.root()).unwrap().revision, 1);
}

#[test]
fn unsafe_lock_file_is_rejected_without_replacing_its_target() {
    let fixture = Fixture::new();
    let target = Fixture::new();
    fs::create_dir(fixture.root()).unwrap();
    let original = target.0.join("private");
    fs::write(&original, b"UNCHANGED").unwrap();
    let linked = fixture.root().join(".profiles.lock");
    #[cfg(windows)]
    junction(&linked, &target.0);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&original, &linked).unwrap();
    assert_eq!(
        create(&fixture.root(), request(ID, 0)).unwrap_err(),
        UNAVAILABLE
    );
    assert!(!fixture.root().join("profiles.json").exists());
    assert_eq!(fs::read(&original).unwrap(), b"UNCHANGED");
    #[cfg(windows)]
    fs::remove_dir(linked).unwrap();
    #[cfg(unix)]
    fs::remove_file(linked).unwrap();
}

// Executed as a separate test process by the crash fixture below. It uses only
// the synthetic metadata directory supplied by that test, never an app account.
#[test]
fn lock_process_fixture() {
    let Some(path) = std::env::var_os("CG_PROFILE_LOCK_FIXTURE_ROOT") else {
        return;
    };
    let root = PathBuf::from(path);
    let _lock = mutation_lock(&root).unwrap();
    fs::write(root.join("fixture-ready"), b"ready").unwrap();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[test]
fn operating_system_releases_the_profile_lock_when_its_owner_process_exits() {
    let fixture = Fixture::new();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "profile_store::tests::lock_process_fixture",
            "--nocapture",
        ])
        .env("CG_PROFILE_LOCK_FIXTURE_ROOT", fixture.root())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !fixture.root().join("fixture-ready").exists() && std::time::Instant::now() < until {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let ready = fixture.root().join("fixture-ready").exists();
    let contested = if ready {
        Some(create(&fixture.root(), request(ID, 0)).err())
    } else {
        None
    };
    // Terminate the fixture before any assertion so a failed expectation cannot
    // leave the lock process running or make fixture cleanup traverse live data.
    let _ = child.kill();
    child.wait().unwrap();
    assert!(ready, "synthetic lock owner did not become ready");
    assert_eq!(contested, Some(Some(CONFLICT)));
    create(&fixture.root(), request(ID, 0)).unwrap();
    assert_eq!(read(&fixture.root()).unwrap().revision, 1);
}

#[test]
fn bounded_jobs_hold_admission_until_completion_and_serialize_compare_and_publish() {
    let slots = Arc::new(StoreSlots::new());
    let first = slots.acquire().unwrap();
    let second = slots.acquire().unwrap();
    assert!(slots.acquire().is_none());
    let gate = slots.gate.lock().unwrap();
    assert!(slots.gate.try_lock().is_err());
    drop(gate);
    drop(first);
    drop(second);
    assert_eq!(slots.outstanding.load(Ordering::Acquire), 0);
    let fixture = Fixture::new();
    let mut workers = vec![];
    for id in [ID, OTHER_ID] {
        let slots = Arc::clone(&slots);
        let root = fixture.root();
        workers.push(std::thread::spawn(move || {
            let _guard = slots.acquire().unwrap();
            let _gate = slots.gate.lock().unwrap();
            create(&root, request(id, 0))
        }));
    }
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(CONFLICT)))
            .count(),
        1
    );
    assert_eq!(read(&fixture.root()).unwrap().revision, 1);
}

fn invoke(
    window: &WebviewWindow<MockRuntime>,
    url: &str,
    command: &str,
    body: InvokeBody,
) -> Result<InvokeResponseBody, Value> {
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
}
#[test]
fn borrowed_preflight_rejects_large_or_nested_payloads_before_deserialization() {
    let create = json!({"request":{"schema_version":"1.0","request_id":ID,"provider":"codex","name":"Personal","expected_revision":0}});
    let select = json!({"request":{"schema_version":"1.0","profile_id":ID,"expected_revision":1}});
    assert!(preflight(&json!({}), Shape::Status));
    assert!(preflight(&create, Shape::Create));
    assert!(preflight(&select, Shape::Select));
    assert!(!preflight(&create, Shape::Select));
    assert!(!preflight(&select, Shape::Create));
    let mut giant = create.clone();
    giant["request"]["name"] = json!("x".repeat(100_000));
    assert!(!preflight(&giant, Shape::Create));
    let mut nested = create.clone();
    nested["request"]["unknown"] = json!({"nested":{"private":"x".repeat(100_000)}});
    assert!(!preflight(&nested, Shape::Create));
    assert!(!preflight(&nested, Shape::Status));
    let mut scalar_nested = create.clone();
    scalar_nested["request"]["name"] = json!({"nested":"x".repeat(100_000)});
    assert!(!preflight(&scalar_nested, Shape::Create));
    for (field, invalid) in [
        ("schema_version", json!("2.0")),
        ("request_id", json!("NOT_UUID")),
        ("provider", json!("api")),
        ("expected_revision", json!(MAX_REVISION + 1)),
        ("expected_revision", json!(-1)),
        ("expected_revision", json!(1.5)),
    ] {
        let mut invalid_request = create.clone();
        invalid_request["request"][field] = invalid;
        assert!(!preflight(&invalid_request, Shape::Create));
    }
    let mut invalid_select = select;
    invalid_select["request"]["profile_id"] = json!("x".repeat(100_000));
    assert!(!preflight(&invalid_select, Shape::Select));
    assert!(!preflight(
        &json!({"request":{"unexpected":"x".repeat(100_000)}}),
        Shape::Create
    ));
}

#[test]
fn real_application_acl_and_wrappers_accept_only_local_main_exact_requests() {
    let fixture = Fixture::new();
    let mut context = crate::application_context();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(fixture.0.clone()),
    );
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            local_managed_profiles_status,
            local_managed_profile_create,
            local_managed_profile_select
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
    let create_body = json!({"request":{"schema_version":"1.0","request_id":ID,"provider":"codex","name":"Personal","expected_revision":0}});
    let select_body =
        json!({"request":{"schema_version":"1.0","profile_id":ID,"expected_revision":1}});
    let mut giant_name = create_body.clone();
    giant_name["request"]["name"] = json!("x".repeat(100_000));
    let mut unknown_nested = create_body.clone();
    unknown_nested["request"]["unknown"] = json!({"nested":{"private":"x".repeat(100_000)}});
    for malformed in [giant_name, unknown_nested] {
        assert_eq!(
            invoke(
                &main,
                local,
                "local_managed_profile_create",
                InvokeBody::Json(malformed)
            )
            .unwrap_err(),
            json!(DENIED)
        );
        assert!(!fixture.root().exists());
    }
    for (command, body) in [
        ("local_managed_profiles_status", json!({})),
        ("local_managed_profile_create", create_body.clone()),
        ("local_managed_profile_select", select_body.clone()),
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
            json!({"path":"PRIVATE_PATH"}),
            json!({"request":{},"extra":true}),
        ] {
            assert!(invoke(&main, local, command, InvokeBody::Json(hostile)).is_err());
        }
        assert!(invoke(&main, local, command, InvokeBody::Raw(vec![])).is_err());
    }
    let empty = invoke(
        &main,
        local,
        "local_managed_profiles_status",
        InvokeBody::Json(json!({})),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(empty["revision"], 0);
    assert!(!fixture.root().exists());
    let created = invoke(
        &main,
        local,
        "local_managed_profile_create",
        InvokeBody::Json(create_body.clone()),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(created["revision"], 1);
    assert_eq!(created["profiles"][0]["profile_id"], ID);
    let selected = invoke(
        &main,
        local,
        "local_managed_profile_select",
        InvokeBody::Json(select_body),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(selected["selected_profile_id"], ID);
    assert_eq!(selected["revision"], 2);
    let repeated = invoke(
        &main,
        local,
        "local_managed_profile_create",
        InvokeBody::Json(create_body.clone()),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(repeated["revision"], 2);
    let mut hostile = create_body;
    hostile["request"]["argv"] = json!(["PRIVATE_ARG"]);
    assert_eq!(
        invoke(
            &main,
            local,
            "local_managed_profile_create",
            InvokeBody::Json(hostile)
        )
        .unwrap_err(),
        json!(DENIED)
    );
    fs::write(fixture.root().join("profiles.json"), b"PRIVATE_MALFORMED").unwrap();
    let unavailable = invoke(
        &main,
        local,
        "local_managed_profiles_status",
        InvokeBody::Json(json!({})),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(
        unavailable,
        json!({"schema_version":"1.0","availability":"unavailable","revision":0,"profiles":[],"selected_profile_id":null})
    );
    assert!(!unavailable.to_string().contains("PRIVATE"));
    assert_eq!(
        fs::read(fixture.root().join("profiles.json")).unwrap(),
        b"PRIVATE_MALFORMED"
    );
}
