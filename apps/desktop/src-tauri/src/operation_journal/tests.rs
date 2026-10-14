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

// ---- owner_hold (ADR 0025 native durable start gate) ----

const FIXTURE_OWNER: &str = "00000000-0000-4000-8000-000000000001";
const FIXTURE_PROVIDER: &str = "codex";
const OTHER_OWNER: &str = "11111111-1111-4111-8111-111111111111";
const FIXTURE_OPERATION_DIRECTORY: &str =
    "op-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002";

fn fixture_manifest() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../packages/agent-adapters/test/fixtures/operation-journal-contract.json"
    ))
    .unwrap()
}
fn fixture_files(manifest: &Value, name: &str) -> Vec<(String, String)> {
    let case = manifest["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("missing fixture {name}"));
    case["files"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, contents)| (path.clone(), contents.as_str().unwrap().to_owned()))
        .collect()
}
fn journal_with(files: &[(String, String)]) -> Temporary {
    let directory = Temporary::new();
    for (relative, contents) in files {
        directory.write(&format!("journal/{relative}"), contents);
    }
    directory
}
fn hold(directory: &Temporary) -> OwnerHold {
    owner_hold(
        &directory.0.join("journal"),
        FIXTURE_OWNER,
        FIXTURE_PROVIDER,
    )
}
/// Fixture records with sequence `1..=count` of a case (a valid hash-chain prefix).
fn prefix(manifest: &Value, name: &str, count: usize) -> Vec<(String, String)> {
    fixture_files(manifest, name)
        .into_iter()
        .filter(|(path, _)| {
            let file = path.rsplit('/').next().unwrap();
            file[..6].parse::<usize>().unwrap() <= count
        })
        .collect()
}

#[test]
fn owner_hold_follows_every_shared_contract_fixture() {
    // Owner-scoped verdicts. Cases whose catalog-level failure concerns an entry that
    // is not an `op-{owner}-*` directory are Clear here; every other blocked case, and
    // every non-terminal journal with pending work, a held lease or active namespaces,
    // is Review. A missing store is Review (the gate only asks for a ready binding).
    const REVIEW_MISSING: &[&str] = &["missing_store"];
    const CLEAR: &[&str] = &[
        "begin_process_crash",
        "begin_file_and_directory_synced",
        "lease_released_nonterminal",
        "all_actions_and_roles_complete_process_crash",
        "all_actions_and_roles_complete_file_and_directory_synced",
        "two_valid_operations_sorted",
        "unexpected_root_file",
        "noncanonical_operation_directory",
    ];
    const REVIEW_NEEDS_REVIEW: &[&str] = &[
        "lease_intent_pending_process_crash",
        "lease_intent_pending_file_and_directory_synced",
        "lease_capture_pending_process_crash",
        "lease_capture_pending_file_and_directory_synced",
        "lease_acquired_process_crash",
        "lease_acquired_file_and_directory_synced",
        "namespace_capture_pending_process_crash",
        "namespace_capture_pending_file_and_directory_synced",
        "namespace_exec_pending_process_crash",
        "namespace_exec_pending_file_and_directory_synced",
        "rejected_before_dispatch_retry_process_crash",
        "rejected_before_dispatch_retry_file_and_directory_synced",
        "lease_receipt_without_capture",
        "namespace_receipt_without_capture",
        "lease_release_pending",
    ];
    let manifest = fixture_manifest();
    let (mut clear, mut review_needs, mut blocked, mut missing) = (0, 0, 0, 0);
    for case in manifest["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let directory = journal_with(&fixture_files(&manifest, name));
        let expected = if CLEAR.contains(&name) {
            clear += 1;
            OwnerHold::Clear
        } else if REVIEW_MISSING.contains(&name) {
            assert_eq!(case["expected"]["status"], "unavailable", "{name}");
            missing += 1;
            OwnerHold::Review
        } else {
            if REVIEW_NEEDS_REVIEW.contains(&name) {
                assert_eq!(case["expected"]["status"], "available", "{name}");
                review_needs += 1;
            } else {
                assert_eq!(case["expected"]["status"], "blocked", "unclassified {name}");
                blocked += 1;
            }
            OwnerHold::Review
        };
        assert_eq!(hold(&directory), expected, "fixture {name}");
    }
    assert_eq!(clear, CLEAR.len());
    assert_eq!(review_needs, REVIEW_NEEDS_REVIEW.len());
    assert_eq!(missing, REVIEW_MISSING.len());
    assert!(blocked > 50);
}

#[test]
fn owner_hold_rejected_before_dispatch_without_lease_is_clear() {
    let manifest = fixture_manifest();
    let name = "rejected_before_dispatch_retry_process_crash";
    // begin, lease intent, rejected receipt: no lease and nothing pending.
    assert_eq!(
        hold(&journal_with(&prefix(&manifest, name, 3))),
        OwnerHold::Clear
    );
    // The retry then acquires the lease, which is unresolved again.
    assert_eq!(
        hold(&journal_with(&prefix(&manifest, name, 6))),
        OwnerHold::Review
    );
}

#[test]
fn owner_hold_distinguishes_unresolved_from_resolved_prefixes() {
    let manifest = fixture_manifest();
    for (count, expected) in [
        (1, OwnerHold::Clear),  // begin only
        (2, OwnerHold::Review), // lease acquire pending
        (4, OwnerHold::Review), // lease held
        (5, OwnerHold::Review), // release pending
        (6, OwnerHold::Clear),  // released before Complete (crash window)
    ] {
        let directory = journal_with(&prefix(&manifest, "lease_released_nonterminal", count));
        assert_eq!(hold(&directory), expected, "first {count} records");
    }
}

#[test]
fn owner_hold_missing_root_or_ancestor_is_review_and_empty_root_is_clear() {
    let root = Temporary::new();
    // The gate is asked only for ready bindings: removed journals fail closed.
    assert_eq!(
        owner_hold(&root.0.join("missing"), FIXTURE_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Review
    );
    assert_eq!(
        owner_hold(
            &root.0.join("missing").join("deeper"),
            FIXTURE_OWNER,
            FIXTURE_PROVIDER
        ),
        OwnerHold::Review
    );
    assert_eq!(
        owner_hold(&root.0, FIXTURE_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Clear
    );
    root.write("file", "synthetic");
    assert_eq!(
        owner_hold(&root.0.join("file"), FIXTURE_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Review
    );
    assert_eq!(
        owner_hold(Path::new("relative"), FIXTURE_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Review
    );
}

#[test]
fn owner_hold_invalid_owner_is_review() {
    let manifest = fixture_manifest();
    let directory = journal_with(&prefix(&manifest, "begin_process_crash", 1));
    let root = directory.0.join("journal");
    assert_eq!(
        owner_hold(&root, FIXTURE_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Clear
    );
    for owner in [
        "",
        "not-a-uuid",
        "00000000-0000-1000-8000-000000000001",
        "00000000-0000-4000-8000-00000000000A",
        "../00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001/",
    ] {
        assert_eq!(
            owner_hold(&root, owner, FIXTURE_PROVIDER),
            OwnerHold::Review,
            "owner {owner:?}"
        );
    }
    // An invalid owner is refused even when the root is missing.
    assert_eq!(
        owner_hold(&directory.0.join("missing"), "bad", FIXTURE_PROVIDER),
        OwnerHold::Review
    );
}

#[test]
fn owner_hold_ignores_other_owners_entries() {
    let manifest = fixture_manifest();
    let pending = journal_with(&prefix(&manifest, "lease_acquired_process_crash", 4));
    let root = pending.0.join("journal");
    assert_eq!(
        owner_hold(&root, FIXTURE_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Review
    );
    assert_eq!(
        owner_hold(&root, OTHER_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Clear
    );
    // Corrupt or unrelated entries of other owners are never opened.
    pending.write(
        &format!("journal/op-{OWNER}-{OPERATION}/000001.json"),
        "garbage",
    );
    pending.write("journal/unrelated-file", "synthetic");
    fs::create_dir(root.join("operation-directory-with-wrong-prefix")).unwrap();
    assert_eq!(
        owner_hold(
            &root,
            "33333333-3333-4333-8333-333333333333",
            FIXTURE_PROVIDER
        ),
        OwnerHold::Clear
    );
    // The same garbage under the requested owner fails closed.
    assert_eq!(
        owner_hold(&root, OWNER, FIXTURE_PROVIDER),
        OwnerHold::Review
    );
}

#[test]
fn owner_hold_renamed_or_mismatched_directories_are_review() {
    let manifest = fixture_manifest();
    let second = "00000000-0000-4000-8000-000000000009";
    let mut files = prefix(&manifest, "begin_process_crash", 1);
    files.extend(
        prefix(&manifest, "lease_acquired_process_crash", 4)
            .into_iter()
            .map(|(path, contents)| {
                (
                    path.replace("00000000-0000-4000-8000-000000000002", second),
                    contents,
                )
            }),
    );
    assert_eq!(hold(&journal_with(&files)), OwnerHold::Review);
    // Several resolved operations of the same owner stay Clear.
    assert_eq!(
        hold(&journal_with(&fixture_files(
            &manifest,
            "two_valid_operations_sorted"
        ))),
        OwnerHold::Clear
    );
}

#[test]
fn owner_hold_wrong_provider_is_review() {
    let manifest = fixture_manifest();
    for (name, count) in [
        ("begin_process_crash", 1),
        ("lease_released_nonterminal", 6),
        ("all_actions_and_roles_complete_process_crash", 39),
        ("lease_acquired_process_crash", 4),
    ] {
        let directory = journal_with(&prefix(&manifest, name, count));
        let root = directory.0.join("journal");
        assert_eq!(
            owner_hold(&root, FIXTURE_OWNER, FIXTURE_PROVIDER),
            if name == "lease_acquired_process_crash" {
                OwnerHold::Review
            } else {
                OwnerHold::Clear
            },
            "{name}"
        );
        for provider in ["claude", ""] {
            assert_eq!(
                owner_hold(&root, FIXTURE_OWNER, provider),
                OwnerHold::Review,
                "{name} as {provider:?}"
            );
        }
    }
}

#[test]
fn owner_hold_corrupt_hash_broken_and_non_canonical_journals_are_review() {
    let manifest = fixture_manifest();
    let good = prefix(&manifest, "begin_process_crash", 1);
    assert_eq!(hold(&journal_with(&good)), OwnerHold::Clear);
    let (path, contents) = good[0].clone();
    let variants: Vec<(&str, String)> = vec![
        ("truncated", contents[..contents.len() / 2].to_owned()),
        ("no newline", contents.trim_end().to_owned()),
        ("double newline", format!("{contents}\n")),
        ("crlf", contents.replace('\n', "\r\n")),
        ("empty", String::new()),
        (
            "spaced",
            contents.replace("\"sequence\":1", "\"sequence\": 1"),
        ),
        (
            "hash extended",
            contents.replacen("\"hash\":\"", "\"hash\":\"f", 1),
        ),
        (
            "hash changed",
            contents.replacen(
                "\"durability\":\"process_crash\"",
                "\"durability\":\"file_and_directory_synced\"",
                1,
            ),
        ),
    ];
    for (label, bad) in variants {
        assert_eq!(
            hold(&journal_with(&[(path.clone(), bad)])),
            OwnerHold::Review,
            "{label}"
        );
    }
    // Unexpected extra file inside the owner's journal directory.
    let mut extra = good;
    extra.push((
        format!("{FIXTURE_OPERATION_DIRECTORY}/.pending-synthetic"),
        "synthetic".to_owned(),
    ));
    assert_eq!(hold(&journal_with(&extra)), OwnerHold::Review);
    // An empty directory (crash before the first publish) is Clear; see
    // owner_hold_directory_without_a_published_record_is_clear.
}

#[test]
fn owner_hold_prefixed_non_directories_and_bad_names_are_review() {
    let file_instead = Temporary::new();
    file_instead.write(
        &format!("journal/{FIXTURE_OPERATION_DIRECTORY}"),
        "synthetic",
    );
    assert_eq!(hold(&file_instead), OwnerHold::Review);
    let bad_name = Temporary::new();
    bad_name.write(
        &format!("journal/op-{FIXTURE_OWNER}-not-an-operation/000001.json"),
        "x",
    );
    assert_eq!(hold(&bad_name), OwnerHold::Review);
    let extra_suffix = Temporary::new();
    extra_suffix.write(
        &format!("journal/{FIXTURE_OPERATION_DIRECTORY}x/000001.json"),
        "x",
    );
    assert_eq!(hold(&extra_suffix), OwnerHold::Review);
}

#[cfg(unix)]
#[test]
fn owner_hold_symlinked_operation_or_root_is_review() {
    use std::os::unix::fs::symlink;
    let manifest = fixture_manifest();
    // A fully valid, resolved journal behind a symlink must still fail closed.
    let target = journal_with(&prefix(
        &manifest,
        "all_actions_and_roles_complete_process_crash",
        39,
    ));
    assert_eq!(hold(&target), OwnerHold::Clear);
    let target_directory = target.0.join("journal").join(FIXTURE_OPERATION_DIRECTORY);
    let linked = Temporary::new();
    fs::create_dir(linked.0.join("journal")).unwrap();
    let link = linked.0.join("journal").join(FIXTURE_OPERATION_DIRECTORY);
    if symlink(&target_directory, &link).is_err() {
        return;
    }
    assert_eq!(hold(&linked), OwnerHold::Review);
    let root_link = Temporary::new();
    if symlink(target.0.join("journal"), root_link.0.join("journal")).is_err() {
        return;
    }
    assert_eq!(hold(&root_link), OwnerHold::Review);
}

#[cfg(windows)]
#[test]
fn owner_hold_junctioned_operation_or_root_is_review() {
    fn junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    let manifest = fixture_manifest();
    // A fully valid, resolved journal behind a junction must still fail closed.
    let target = journal_with(&prefix(
        &manifest,
        "all_actions_and_roles_complete_process_crash",
        39,
    ));
    assert_eq!(hold(&target), OwnerHold::Clear);
    let target_directory = target.0.join("journal").join(FIXTURE_OPERATION_DIRECTORY);
    let linked = Temporary::new();
    fs::create_dir(linked.0.join("journal")).unwrap();
    let link = linked.0.join("journal").join(FIXTURE_OPERATION_DIRECTORY);
    if !junction(&link, &target_directory) {
        return;
    }
    assert_eq!(hold(&linked), OwnerHold::Review);
    fs::remove_dir(&link).unwrap();
    let root_link = Temporary::new();
    let linked_root = root_link.0.join("journal");
    if !junction(&linked_root, &target.0.join("journal")) {
        return;
    }
    assert_eq!(hold(&root_link), OwnerHold::Review);
    fs::remove_dir(&linked_root).unwrap();
    assert!(target_directory.join("000001.json").is_file());
}

#[test]
fn owner_hold_total_entry_bound_fails_closed_and_foreign_entries_do_not_use_the_owner_cap() {
    let root = Temporary::new();
    for i in 0..4 {
        root.write(&format!("unrelated-{i}"), "synthetic");
    }
    // Exactly at the hard bound is fine; one more entry listed fails closed.
    assert_eq!(
        owner_hold_bounded(&root.0, FIXTURE_OWNER, FIXTURE_PROVIDER, 4, 1),
        OwnerHold::Clear
    );
    assert_eq!(
        owner_hold_bounded(&root.0, FIXTURE_OWNER, FIXTURE_PROVIDER, 3, 1),
        OwnerHold::Review
    );
    assert_eq!(OWNER_SCAN_ENTRY_CAP, 65536);
    assert_eq!(OWNER_MATCH_CAP, 4096);
    // Other owners' entries beyond both the catalog and the per-owner cap do not
    // block this owner, and do not make it Overflow.
    let many = Temporary::new();
    for i in 0..=OWNER_MATCH_CAP + MAX_OPERATIONS {
        many.write(&format!("op-{OTHER_OWNER}-entry-{i}"), "synthetic");
    }
    assert_eq!(
        owner_hold(&many.0, FIXTURE_OWNER, FIXTURE_PROVIDER),
        OwnerHold::Clear,
        "other owners' entries do not count toward the owner cap"
    );
}

fn empty_operation_directory(root: &Path, owner: &str, index: u8) {
    fs::create_dir(root.join(format!(
        "op-{owner}-00000000-0000-4000-8000-0000000000{index:02}"
    )))
    .unwrap();
}

#[test]
fn owner_hold_per_owner_match_cap_blocks_with_review() {
    let root = Temporary::new();
    for index in 0..3 {
        empty_operation_directory(&root.0, FIXTURE_OWNER, index);
    }
    // Other owners accumulate freely.
    for index in 0..10 {
        empty_operation_directory(&root.0, OTHER_OWNER, index);
    }
    assert_eq!(
        owner_hold_bounded(&root.0, FIXTURE_OWNER, FIXTURE_PROVIDER, 100, 3),
        OwnerHold::Clear
    );
    assert_eq!(
        owner_hold_bounded(&root.0, FIXTURE_OWNER, FIXTURE_PROVIDER, 100, 2),
        OwnerHold::Review
    );
    assert_eq!(
        owner_hold_bounded(&root.0, OTHER_OWNER, FIXTURE_PROVIDER, 100, 10),
        OwnerHold::Clear
    );
}

fn last_record(files: &[(String, String)]) -> &(String, String) {
    files
        .iter()
        .max_by_key(|(path, _)| path.rsplit('/').next().unwrap().to_owned())
        .unwrap()
}
const PENDING_NAME: &str = ".pending-5b9b8f43-6d1a-4c27-8f11-0123456789ab";

#[test]
fn owner_hold_directory_without_a_published_record_is_clear() {
    // Crash between mkdir and the first publish.
    let empty = Temporary::new();
    fs::create_dir_all(empty.0.join("journal").join(FIXTURE_OPERATION_DIRECTORY)).unwrap();
    assert_eq!(hold(&empty), OwnerHold::Clear);
    // Crash before link: only the temp file exists, whatever its bytes.
    for contents in ["", "partial", "{\"schema\":1}"] {
        let pending_only = Temporary::new();
        pending_only.write(
            &format!("journal/{FIXTURE_OPERATION_DIRECTORY}/{PENDING_NAME}"),
            contents,
        );
        assert_eq!(hold(&pending_only), OwnerHold::Clear, "{contents:?}");
    }
    // The read-only catalog still treats such a directory as invalid.
    let catalog = Temporary::new();
    fs::create_dir(catalog.0.join(operation())).unwrap();
    blocked(&catalog, "operation_journal_invalid");
}

#[test]
fn owner_hold_unexpected_entries_without_a_record_are_review() {
    for name in [
        "000001.json.tmp",
        ".pending-not-a-uuid",
        ".pending-",
        "stray",
        ".PENDING-5b9b8f43-6d1a-4c27-8f11-0123456789ab",
    ] {
        let directory = Temporary::new();
        directory.write(
            &format!("journal/{FIXTURE_OPERATION_DIRECTORY}/{name}"),
            "x",
        );
        assert_eq!(hold(&directory), OwnerHold::Review, "{name}");
    }
    // A `.pending-<uuid>` that is a directory is not a leftover temp file.
    let directory = Temporary::new();
    fs::create_dir_all(
        directory
            .0
            .join("journal")
            .join(FIXTURE_OPERATION_DIRECTORY)
            .join(PENDING_NAME),
    )
    .unwrap();
    assert_eq!(hold(&directory), OwnerHold::Review);
}

#[test]
fn owner_hold_pending_beside_records_must_equal_the_latest_record() {
    let manifest = fixture_manifest();
    for (case, count, resolved) in [
        ("lease_released_nonterminal", 6, OwnerHold::Clear),
        ("lease_acquired_process_crash", 4, OwnerHold::Review),
    ] {
        let files = prefix(&manifest, case, count);
        // Crash between link and unlink: the temp file duplicates the latest record.
        let mut duplicate = files.clone();
        let latest = last_record(&files).1.clone();
        duplicate.push((
            format!("{FIXTURE_OPERATION_DIRECTORY}/{PENDING_NAME}"),
            latest,
        ));
        assert_eq!(
            hold(&journal_with(&duplicate)),
            resolved,
            "{case} duplicate"
        );
        // Anything else beside published records fails closed: an earlier record,
        // a truncated copy, an empty file.
        for other in [
            files[0].1.clone(),
            last_record(&files).1[..40].to_owned(),
            String::new(),
        ] {
            let mut mismatched = files.clone();
            mismatched.push((
                format!("{FIXTURE_OPERATION_DIRECTORY}/{PENDING_NAME}"),
                other,
            ));
            assert_eq!(
                hold(&journal_with(&mismatched)),
                OwnerHold::Review,
                "{case}"
            );
        }
    }
    // The catalog panel reader is unchanged: leftover files make it blocked.
    let files = prefix(&manifest, "lease_released_nonterminal", 6);
    let mut with_pending = files.clone();
    with_pending.push((
        format!("{FIXTURE_OPERATION_DIRECTORY}/{PENDING_NAME}"),
        last_record(&files).1.clone(),
    ));
    let directory = journal_with(&with_pending);
    let status = serde_json::to_value(read_operation_status(directory.0.join("journal"))).unwrap();
    assert_eq!(status["status"], "blocked");
}
