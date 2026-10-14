use super::*;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const ID: &str = "11111111-1111-4111-8111-111111111111";
const OWNER: &str = "33333333-3333-4333-8333-333333333333";
const OTHER: &str = "44444444-4444-4444-8444-444444444444";
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "cg-profile-binding-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&directory).unwrap();
        Self(directory)
    }
    fn root(&self) -> PathBuf {
        self.0.join("managed-profile-sessions")
    }
    fn file(&self) -> PathBuf {
        self.root().join(format!("{ID}.json"))
    }
    fn write_raw(&self, bytes: impl AsRef<[u8]>) {
        fs::create_dir_all(self.root()).unwrap();
        fs::write(self.file(), bytes).unwrap();
    }
    fn write(&self, value: Value) {
        self.write_raw(value.to_string());
    }
    fn read(&self) -> Binding {
        read(&self.0, ID, Provider::Codex)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn binding() -> Value {
    json!({
        "schema_version": "1.0",
        "profile_id": ID,
        "provider": "codex",
        "owner": OWNER,
        "state": "ready"
    })
}

#[test]
fn ready_binding_returns_owner() {
    let fixture = Fixture::new();
    fixture.write_raw(format!("{}\n", binding()));
    assert_eq!(fixture.read(), Binding::Ready(OWNER.into()));
}

#[test]
fn reserved_binding_needs_review() {
    let fixture = Fixture::new();
    let mut value = binding();
    value["state"] = json!("reserved");
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Reserved);
}

#[test]
fn claude_provider_matches_only_claude() {
    let fixture = Fixture::new();
    let mut value = binding();
    value["provider"] = json!("claude");
    fixture.write(value);
    assert_eq!(
        read(&fixture.0, ID, Provider::Claude),
        Binding::Ready(OWNER.into())
    );
    assert_eq!(fixture.read(), Binding::Invalid);
}

#[test]
fn missing_file_and_directory_are_absent() {
    let fixture = Fixture::new();
    assert_eq!(fixture.read(), Binding::Absent);
    fs::create_dir(fixture.root()).unwrap();
    assert_eq!(fixture.read(), Binding::Absent);
}

#[test]
fn mismatches_are_invalid() {
    let fixture = Fixture::new();
    let mut value = binding();
    value["provider"] = json!("claude");
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);

    let mut value = binding();
    value["profile_id"] = json!(OTHER);
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);

    let mut value = binding();
    value["owner"] = json!(ID);
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);
}

#[test]
fn key_set_and_schema_are_strict() {
    let fixture = Fixture::new();
    let mut value = binding();
    value["extra"] = json!("x");
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);

    let mut value = binding();
    value.as_object_mut().unwrap().remove("state");
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);

    let mut value = binding();
    value["schema_version"] = json!("2.0");
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);

    let mut value = binding();
    value["state"] = json!("pending");
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);

    let mut value = binding();
    value["owner"] = json!(7);
    fixture.write(value);
    assert_eq!(fixture.read(), Binding::Invalid);
}

#[test]
fn non_object_and_malformed_json_are_invalid() {
    let fixture = Fixture::new();
    for text in ["", "{", "[]", "null", "\"x\"", "{\"a\":1}x"] {
        fixture.write_raw(text);
        assert_eq!(fixture.read(), Binding::Invalid, "{text}");
    }
    fixture.write_raw([0xff, 0xfe, b'{', b'}']);
    assert_eq!(fixture.read(), Binding::Invalid);
}

#[test]
fn non_uuid_values_are_invalid() {
    let fixture = Fixture::new();
    for owner in [
        "not-a-uuid",
        "33333333-3333-3333-8333-333333333333",
        "33333333-3333-4333-8333-33333333333G",
    ] {
        let mut value = binding();
        value["owner"] = json!(owner);
        fixture.write(value);
        assert_eq!(fixture.read(), Binding::Invalid, "{owner}");
    }
    fixture.write(binding());
    for profile_id in [
        "not-a-uuid",
        "",
        "../x",
        "11111111-1111-4111-8111-11111111111A",
    ] {
        assert_eq!(
            read(&fixture.0, profile_id, Provider::Codex),
            Binding::Invalid,
            "{profile_id}"
        );
    }
}

#[test]
fn oversize_file_is_invalid() {
    let fixture = Fixture::new();
    let mut text = binding().to_string();
    text.push_str(&" ".repeat(4096));
    fixture.write_raw(&text);
    assert_eq!(fixture.read(), Binding::Invalid);
    // Exactly 4096 bytes is still accepted.
    let mut text = binding().to_string();
    text.push_str(&" ".repeat(4096 - text.len()));
    assert_eq!(text.len(), 4096);
    fixture.write_raw(&text);
    assert_eq!(fixture.read(), Binding::Ready(OWNER.into()));
}

#[test]
fn directory_in_place_of_file_is_invalid() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.file()).unwrap();
    assert_eq!(fixture.read(), Binding::Invalid);
}

fn symlink_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link).is_ok();
    #[cfg(windows)]
    return std::os::windows::fs::symlink_file(target, link).is_ok();
    #[allow(unreachable_code)]
    false
}
fn symlink_dir(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link).is_ok();
    #[cfg(windows)]
    return std::os::windows::fs::symlink_dir(target, link).is_ok();
    #[allow(unreachable_code)]
    false
}

#[test]
fn symlinked_file_is_invalid() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root()).unwrap();
    let target = fixture.0.join("target.json");
    fs::write(&target, binding().to_string()).unwrap();
    if !symlink_file(&target, &fixture.file()) {
        eprintln!("symlink creation not permitted; skipping");
        return;
    }
    assert_eq!(fixture.read(), Binding::Invalid);
}

#[test]
fn symlinked_binding_directory_is_invalid() {
    let fixture = Fixture::new();
    let real = fixture.0.join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join(format!("{ID}.json")), binding().to_string()).unwrap();
    if !symlink_dir(&real, &fixture.root()) {
        eprintln!("symlink creation not permitted; skipping");
        return;
    }
    assert_eq!(fixture.read(), Binding::Invalid);
}

#[test]
fn relative_or_missing_store_is_invalid() {
    assert_eq!(
        read(Path::new("relative-store"), ID, Provider::Codex),
        Binding::Invalid
    );
    let fixture = Fixture::new();
    assert_eq!(
        read(&fixture.0.join("missing"), ID, Provider::Codex),
        Binding::Invalid
    );
}
