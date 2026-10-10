use super::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "commongrid-native-journal-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn status(&self) -> Value {
        serde_json::to_value(read_operation_status(self.0.clone())).unwrap()
    }
    fn write(&self, relative: &str, contents: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const OPERATION: &str = "22222222-2222-4222-8222-222222222222";
fn operation() -> String {
    format!("op-{OWNER}-{OPERATION}")
}
fn blocked(root: &Temporary, reason: &str) {
    assert_eq!(
        root.status(),
        json!({"status":"blocked","reason":reason,"execution_enabled":false,"automatic_recovery":false,"worker_quiescence":"unknown","daemon_state":"unknown","operations":[]})
    );
}

#[test]
fn matches_shared_typescript_generated_contract_fixtures() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../../../packages/agent-adapters/test/fixtures/operation-journal-contract.json"
    ))
    .unwrap();
    let cases = manifest["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let directory = Temporary::new();
        for (relative, contents) in case["files"].as_object().unwrap() {
            let path = Path::new(relative);
            assert!(
                !path.is_absolute()
                    && path
                        .components()
                        .all(|component| matches!(component, std::path::Component::Normal(_)))
            );
            directory.write(&format!("journal/{relative}"), contents.as_str().unwrap());
        }
        assert_eq!(
            serde_json::to_value(read_operation_status(directory.0.join("journal"))).unwrap(),
            case["expected"],
            "fixture {}",
            case["name"]
        );
    }
}

#[test]
fn absent_empty_and_non_directory_roots_are_distinct() {
    let root = Temporary::new();
    assert_eq!(root.status()["status"], "available");
    let missing = serde_json::to_value(read_operation_status(root.0.join("missing"))).unwrap();
    assert_eq!(missing["status"], "unavailable");
    assert_eq!(missing["reason"], "operation_journal_missing");
    root.write("file", "synthetic");
    let file_root = serde_json::to_value(read_operation_status(root.0.join("file"))).unwrap();
    assert_eq!(file_root["reason"], "operation_journal_invalid");
    assert_eq!(
        serde_json::to_value(read_operation_status(PathBuf::from("relative"))).unwrap()["reason"],
        "operation_journal_invalid"
    );
}

#[test]
fn filesystem_bounds_and_unexpected_entries_fail_closed() {
    let empty_operation = Temporary::new();
    fs::create_dir(empty_operation.0.join(operation())).unwrap();
    blocked(&empty_operation, "operation_journal_invalid");
    let overflow = Temporary::new();
    for i in 0..=MAX_OPERATIONS {
        overflow.write(&format!("entry-{i}"), "synthetic");
    }
    blocked(&overflow, "operation_journal_overflow");
    let records = Temporary::new();
    for i in 1..=MAX_RECORDS + 1 {
        records.write(&format!("{}/{i:06}.json", operation()), "synthetic");
    }
    blocked(&records, "operation_journal_overflow");
    let oversized = Temporary::new();
    oversized.write(
        &format!("{}/000001.json", operation()),
        &"x".repeat(MAX_RECORD_BYTES + 1),
    );
    blocked(&oversized, "operation_journal_invalid");
    let unexpected = Temporary::new();
    unexpected.write("private-secret-name", "private secret contents");
    blocked(&unexpected, "operation_journal_invalid");
    let record_directory = Temporary::new();
    fs::create_dir_all(record_directory.0.join(operation()).join("000001.json")).unwrap();
    blocked(&record_directory, "operation_journal_invalid");
    let gap = Temporary::new();
    gap.write(&format!("{}/000002.json", operation()), "synthetic");
    blocked(&gap, "operation_journal_invalid");
}

#[cfg(unix)]
#[test]
fn symlink_roots_ancestors_operations_and_records_are_rejected() {
    use std::os::unix::fs::symlink;
    let target = Temporary::new();
    let root = Temporary::new();
    symlink(&target.0, root.0.join("linked")).unwrap();
    for path in [
        root.0.join("linked"),
        root.0.join("linked").join("existing"),
    ] {
        fs::create_dir_all(target.0.join("existing")).unwrap();
        assert_eq!(
            serde_json::to_value(read_operation_status(path)).unwrap()["reason"],
            "operation_journal_invalid"
        );
    }
    fs::remove_file(root.0.join("linked")).unwrap();
    symlink(&target.0, root.0.join(operation())).unwrap();
    blocked(&root, "operation_journal_invalid");
    fs::remove_file(root.0.join(operation())).unwrap();
    fs::create_dir(root.0.join(operation())).unwrap();
    target.write("record", "synthetic");
    symlink(
        target.0.join("record"),
        root.0.join(operation()).join("000001.json"),
    )
    .unwrap();
    blocked(&root, "operation_journal_invalid");
}

#[cfg(windows)]
#[test]
fn windows_junction_roots_ancestors_operations_and_records_are_rejected() {
    // Directory junctions do not require Windows symlink privileges. Only the
    // fixture junction is removed; its independently owned target stays intact.
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd.exe")
            .arg("/d")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(status.status.success());
    }
    let target = Temporary::new();
    let root = Temporary::new();
    target.write("existing/marker", "synthetic");
    let linked = root.0.join("linked");
    junction(&linked, &target.0);
    for path in [linked.clone(), linked.join("existing")] {
        assert_eq!(
            serde_json::to_value(read_operation_status(path)).unwrap()["reason"],
            "operation_journal_invalid"
        );
    }
    fs::remove_dir(&linked).unwrap();
    let op = root.0.join(operation());
    junction(&op, &target.0);
    blocked(&root, "operation_journal_invalid");
    fs::remove_dir(&op).unwrap();
    fs::create_dir(&op).unwrap();
    let record = op.join("000001.json");
    junction(&record, &target.0);
    blocked(&root, "operation_journal_invalid");
    fs::remove_dir(&record).unwrap();
    assert!(target.0.join("existing/marker").is_file());
}

#[test]
fn identifier_validation_is_ascii_and_v4_only() {
    assert!(uuid(OWNER));
    assert!(!uuid("11111111-1111-1111-8111-111111111111"));
    assert!(!uuid("11111111-1111-4111-C111-111111111111"));
    assert!(valid_directory_name(&operation()));
    assert!(!valid_directory_name(&"é".repeat(38)));
}
