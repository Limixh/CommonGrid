//! Read-only mirror of the Node immutable journal contract. Checks are not native
//! confinement against hostile local path replacement: this store must be app-owned.
//! No suffix rollback detection, present worker quiescence, or recovery authority.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_OPERATIONS: usize = 1024;
const MAX_RECORDS: usize = 512;
const MAX_RECORD_BYTES: usize = 8192;
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Copy)]
enum Failure {
    Invalid,
    Overflow,
    Io,
    Missing,
}
impl Failure {
    fn reason(self) -> &'static str {
        match self {
            Self::Invalid => "operation_journal_invalid",
            Self::Overflow => "operation_journal_overflow",
            Self::Io => "operation_journal_io_failed",
            Self::Missing => "operation_journal_missing",
        }
    }
}
type Checked<T> = Result<T, Failure>;
fn ensure(condition: bool) -> Checked<()> {
    if condition {
        Ok(())
    } else {
        Err(Failure::Invalid)
    }
}
fn io<T>(result: std::io::Result<T>) -> Checked<T> {
    result.map_err(|_| Failure::Io)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Identity {
    owner: String,
    provider: String,
    operation: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Durability {
    ProcessCrash,
    FileAndDirectorySynced,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Action {
    LeaseAcquire,
    LeaseRelease,
    NamespaceCreate,
    NamespaceStart,
    NamespaceRemove,
    NamespaceExec,
    VolumeCreate,
    VolumeRemove,
    PublicInstall,
    PublicManifestPublish,
    PublicCheckpointPublish,
}
impl Action {
    fn namespace(self) -> bool {
        matches!(
            self,
            Self::NamespaceCreate
                | Self::NamespaceStart
                | Self::NamespaceRemove
                | Self::NamespaceExec
        )
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Role {
    Runtime,
    Init,
    Tools,
    Auth,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    intent_id: String,
    action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<Role>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource_id: Option<String>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Verified,
    RejectedBeforeDispatch,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    intent_id: String,
    outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lease_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    intent_id: String,
    resource_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    Begin,
    Intent { intent: Intent },
    Receipt { receipt: Receipt },
    Capture { capture: Capture },
    Complete,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u8,
    sequence: usize,
    previous_hash: String,
    identity: Identity,
    durability: Durability,
    event: Event,
    hash: String,
}
#[derive(Serialize)]
struct Body<'a> {
    schema: u8,
    sequence: usize,
    previous_hash: &'a str,
    identity: &'a Identity,
    durability: Durability,
    event: &'a Event,
}

fn uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        && bytes[14] == b'4'
        && b"89ab".contains(&bytes[19])
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_identity(value: &Identity) -> Checked<()> {
    let provider = value.provider.as_bytes();
    ensure(
        uuid(&value.owner)
            && uuid(&value.operation)
            && !provider.is_empty()
            && provider.len() <= 32
            && provider[0].is_ascii_lowercase()
            && provider
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-'),
    )
}
fn valid_intent(value: &Intent) -> Checked<()> {
    ensure(uuid(&value.intent_id) && value.resource_id.as_deref().map(hash).unwrap_or(true))?;
    let valid = match value.action {
        Action::LeaseAcquire
        | Action::LeaseRelease
        | Action::PublicManifestPublish
        | Action::PublicCheckpointPublish => value.role.is_none() && value.resource_id.is_none(),
        Action::NamespaceCreate => {
            matches!(value.role, Some(Role::Runtime | Role::Init)) && value.resource_id.is_none()
        }
        Action::NamespaceStart | Action::NamespaceRemove | Action::NamespaceExec => {
            matches!(value.role, Some(Role::Runtime | Role::Init)) && value.resource_id.is_some()
        }
        Action::VolumeCreate | Action::VolumeRemove => {
            matches!(value.role, Some(Role::Tools | Role::Auth)) && value.resource_id.is_none()
        }
        Action::PublicInstall => value.role == Some(Role::Tools) && value.resource_id.is_none(),
    };
    ensure(valid)
}
fn directory_name(identity: &Identity) -> String {
    format!("op-{}-{}", identity.owner, identity.operation)
}
fn valid_directory_name(name: &str) -> bool {
    name.len() == 76
        && name.is_ascii()
        && name.starts_with("op-")
        && name.as_bytes()[39] == b'-'
        && uuid(&name[3..39])
        && uuid(&name[40..76])
}

struct State {
    identity: Identity,
    durability: Durability,
    sequence: usize,
    hash: String,
    terminal: bool,
    lease: Option<String>,
    released: bool,
    intents: HashSet<String>,
    pending: HashMap<String, Intent>,
    captures: HashMap<String, Capture>,
    namespaces: HashSet<String>,
    active_namespaces: HashMap<String, Option<Role>>,
}
impl State {
    fn new(identity: Identity, durability: Durability) -> Self {
        Self {
            identity,
            durability,
            sequence: 0,
            hash: ZERO_HASH.to_owned(),
            terminal: false,
            lease: None,
            released: false,
            intents: HashSet::new(),
            pending: HashMap::new(),
            captures: HashMap::new(),
            namespaces: HashSet::new(),
            active_namespaces: HashMap::new(),
        }
    }
    /// Pending intents, a lease not yet released, or active namespaces remain.
    fn unresolved(&self) -> bool {
        !self.pending.is_empty()
            || (self.lease.is_some() && !self.released)
            || !self.active_namespaces.is_empty()
    }
    fn apply(&mut self, event: &Event) -> Checked<()> {
        ensure(!self.terminal)?;
        if matches!(event, Event::Begin) {
            return ensure(self.sequence == 0);
        }
        ensure(self.sequence > 0)?;
        match event {
            Event::Begin => unreachable!(),
            Event::Complete => {
                ensure(self.pending.is_empty() && self.lease.is_some() && self.released)?;
                self.terminal = true;
            }
            Event::Intent { intent } => {
                valid_intent(intent)?;
                ensure(
                    !self.intents.contains(&intent.intent_id)
                        && !self
                            .pending
                            .values()
                            .any(|i| i.action == Action::LeaseRelease),
                )?;
                if intent.action == Action::LeaseAcquire {
                    ensure(self.lease.is_none() && !self.released && self.pending.is_empty())?;
                } else {
                    ensure(self.lease.is_some() && !self.released)?;
                }
                if intent.action == Action::LeaseRelease {
                    ensure(self.pending.is_empty() && self.active_namespaces.is_empty())?;
                }
                if intent.action.namespace() && intent.action != Action::NamespaceCreate {
                    ensure(
                        intent
                            .resource_id
                            .as_ref()
                            .and_then(|id| self.active_namespaces.get(id))
                            == Some(&intent.role),
                    )?;
                }
                self.intents.insert(intent.intent_id.clone());
                self.pending
                    .insert(intent.intent_id.clone(), intent.clone());
            }
            Event::Capture { capture } => {
                ensure(uuid(&capture.intent_id) && hash(&capture.resource_id))?;
                let target = self
                    .pending
                    .get(&capture.intent_id)
                    .ok_or(Failure::Invalid)?;
                ensure(
                    matches!(
                        target.action,
                        Action::LeaseAcquire | Action::NamespaceCreate
                    ) && !self.captures.contains_key(&target.intent_id),
                )?;
                if target.action == Action::NamespaceCreate {
                    ensure(!self.namespaces.contains(&capture.resource_id))?;
                    self.namespaces.insert(capture.resource_id.clone());
                    self.active_namespaces
                        .insert(capture.resource_id.clone(), target.role);
                }
                self.captures
                    .insert(capture.intent_id.clone(), capture.clone());
            }
            Event::Receipt { receipt } => {
                ensure(
                    uuid(&receipt.intent_id)
                        && receipt.lease_id.as_deref().map(hash).unwrap_or(true)
                        && receipt.resource_id.as_deref().map(hash).unwrap_or(true),
                )?;
                let target = self
                    .pending
                    .get(&receipt.intent_id)
                    .ok_or(Failure::Invalid)?;
                let captured = self.captures.get(&target.intent_id);
                if receipt.outcome == Outcome::RejectedBeforeDispatch {
                    ensure(
                        captured.is_none()
                            && receipt.lease_id.is_none()
                            && receipt.resource_id.is_none(),
                    )?;
                } else if target.action == Action::LeaseAcquire {
                    ensure(
                        receipt.lease_id.is_some()
                            && receipt.resource_id.is_none()
                            && self.lease.is_none()
                            && captured
                                .map(|c| Some(&c.resource_id) == receipt.lease_id.as_ref())
                                .unwrap_or(true),
                    )?;
                    self.lease = receipt.lease_id.clone();
                } else if target.action == Action::LeaseRelease {
                    ensure(
                        receipt.lease_id == self.lease
                            && receipt.resource_id.is_none()
                            && self.pending.len() == 1
                            && self.active_namespaces.is_empty(),
                    )?;
                    self.released = true;
                } else {
                    ensure(receipt.lease_id.is_none())?;
                    if target.action == Action::NamespaceCreate {
                        let id = receipt.resource_id.as_ref().ok_or(Failure::Invalid)?;
                        ensure(
                            captured.map(|c| &c.resource_id == id).unwrap_or(true)
                                && (captured.is_some() || !self.namespaces.contains(id)),
                        )?;
                        self.namespaces.insert(id.clone());
                        self.active_namespaces.insert(id.clone(), target.role);
                    } else {
                        ensure(
                            receipt.resource_id.is_none()
                                || receipt.resource_id == target.resource_id,
                        )?;
                        if target.action == Action::NamespaceRemove {
                            self.active_namespaces
                                .remove(target.resource_id.as_ref().ok_or(Failure::Invalid)?);
                        }
                    }
                }
                self.pending.remove(&receipt.intent_id);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct RecoveryOperation {
    identity: Identity,
    last_sequence: usize,
    last_hash: String,
    status: &'static str,
    pending_count: usize,
    recorded_namespace_count: usize,
    durability: Durability,
}
#[derive(Debug, Serialize)]
pub(crate) struct RecoveryStatus {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    execution_enabled: bool,
    automatic_recovery: bool,
    worker_quiescence: &'static str,
    daemon_state: &'static str,
    operations: Vec<RecoveryOperation>,
}
impl RecoveryStatus {
    fn result(
        status: &'static str,
        reason: Option<&'static str>,
        operations: Vec<RecoveryOperation>,
    ) -> Self {
        Self {
            status,
            reason,
            execution_enabled: false,
            automatic_recovery: false,
            worker_quiescence: "unknown",
            daemon_state: "unknown",
            operations,
        }
    }
    pub(crate) fn io_failed() -> Self {
        Self::result("blocked", Some(Failure::Io.reason()), vec![])
    }
}

fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn regular_directory(path: &Path) -> Checked<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            Failure::Missing
        } else {
            Failure::Io
        }
    })?;
    ensure(metadata.is_dir() && !reparse(&metadata))
}
fn ancestors(path: &Path) -> Checked<()> {
    for ancestor in path.ancestors() {
        regular_directory(ancestor)?;
    }
    Ok(())
}
fn bounded_entries(path: &Path, maximum: usize) -> Checked<Vec<String>> {
    let mut names = vec![];
    for entry in io(fs::read_dir(path))? {
        if names.len() >= maximum {
            return Err(Failure::Overflow);
        }
        names.push(
            io(entry)?
                .file_name()
                .into_string()
                .map_err(|_| Failure::Invalid)?,
        );
    }
    names.sort();
    Ok(names)
}
fn regular_file(metadata: &Metadata) -> Checked<()> {
    ensure(
        metadata.is_file()
            && !reparse(metadata)
            && metadata.len() > 0
            && metadata.len() <= MAX_RECORD_BYTES as u64,
    )
}
fn read_bytes(path: &Path) -> Checked<Vec<u8>> {
    regular_file(&io(fs::symlink_metadata(path))?)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    } // FILE_FLAG_OPEN_REPARSE_POINT
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file: File = io(options.open(path))?;
    regular_file(&io(file.metadata())?)?;
    let mut bytes = Vec::with_capacity(MAX_RECORD_BYTES + 1);
    io(file
        .take((MAX_RECORD_BYTES + 1) as u64)
        .read_to_end(&mut bytes))?;
    ensure(!bytes.is_empty() && bytes.len() <= MAX_RECORD_BYTES)?;
    Ok(bytes)
}
fn read_state(directory: &Path, expected_name: &str) -> Checked<State> {
    regular_directory(directory)?;
    let names = bounded_entries(directory, MAX_RECORDS)?;
    ensure(!names.is_empty())?;
    let mut state: Option<State> = None;
    for (index, name) in names.iter().enumerate() {
        ensure(name == &format!("{:06}.json", index + 1))?;
        let bytes = read_bytes(&directory.join(name))?;
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| Failure::Invalid)?;
        valid_identity(&record.identity)?;
        ensure(
            directory_name(&record.identity) == expected_name
                && record.schema == 1
                && record.sequence == index + 1
                && hash(&record.previous_hash)
                && hash(&record.hash),
        )?;
        let body = Body {
            schema: 1,
            sequence: record.sequence,
            previous_hash: &record.previous_hash,
            identity: &record.identity,
            durability: record.durability,
            event: &record.event,
        };
        let serialized = serde_json::to_vec(&body).map_err(|_| Failure::Invalid)?;
        ensure(format!("{:x}", Sha256::digest(&serialized)) == record.hash)?;
        let mut canonical = serde_json::to_vec(&record).map_err(|_| Failure::Invalid)?;
        canonical.push(b'\n');
        ensure(bytes == canonical)?;
        let current =
            state.get_or_insert_with(|| State::new(record.identity.clone(), record.durability));
        ensure(
            current.identity == record.identity
                && current.durability == record.durability
                && current.hash == record.previous_hash,
        )?;
        current.apply(&record.event)?;
        current.sequence = record.sequence;
        current.hash = record.hash;
    }
    state.ok_or(Failure::Invalid)
}
fn read_catalog(root: &Path) -> Checked<Vec<RecoveryOperation>> {
    ensure(
        root.is_absolute()
            && !root.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            }),
    )?;
    ancestors(root)?;
    let names = bounded_entries(root, MAX_OPERATIONS)?;
    let mut operations = Vec::with_capacity(names.len());
    for name in names {
        ensure(valid_directory_name(&name))?;
        let state = read_state(&root.join(&name), &name).map_err(|error| {
            if matches!(error, Failure::Missing) {
                Failure::Io
            } else {
                error
            }
        })?;
        operations.push(RecoveryOperation {
            identity: state.identity,
            last_sequence: state.sequence,
            last_hash: state.hash,
            status: if state.terminal {
                "recorded_complete"
            } else {
                "needs_review"
            },
            pending_count: state.pending.len(),
            recorded_namespace_count: state.namespaces.len(),
            durability: state.durability,
        });
    }
    Ok(operations)
}
/// No paths, receipts, lease IDs, capture IDs, or raw filesystem errors leave this reader.
pub(crate) fn read_operation_status(root: PathBuf) -> RecoveryStatus {
    match read_catalog(&root) {
        Ok(operations) => RecoveryStatus::result("available", None, operations),
        Err(Failure::Missing) => {
            RecoveryStatus::result("unavailable", Some(Failure::Missing.reason()), vec![])
        }
        Err(error) => RecoveryStatus::result("blocked", Some(error.reason()), vec![]),
    }
}

/// Whether a runtime owner has an unresolved durable operation (ADR 0025).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OwnerHold {
    Clear,
    Review,
}

/// Upper bound on root directory entries examined by the owner-scoped scan.
const OWNER_SCAN_ENTRY_CAP: usize = 4096;

/// Native durable start gate (ADR 0025): `Review` when `owner` has an unresolved
/// durable operation journal under `root`, otherwise `Clear`.
///
/// Only `op-{owner}-*` directories are read (fully, via `read_state`: hash chain and
/// canonical bytes); other owners' entries are never opened. A missing root is
/// `Clear`. Everything unreadable or unexpected fails closed to `Review`: invalid
/// owner, root/ancestor symlinks, non-directory or reparse entries with the prefix,
/// malformed names, any validation failure, a different provider, or more than the
/// entry cap. A valid terminal journal is `Clear`; a valid non-terminal one is
/// `Review` only while `State::unresolved` (pending intents, a held lease, or active
/// namespaces). Begin-only, rejected-before-dispatch without a lease, and a released
/// lease before `Complete` stay `Clear` so a refusal cannot perpetuate itself.
pub(crate) fn owner_hold(root: &Path, owner: &str, provider: &str) -> OwnerHold {
    owner_hold_bounded(root, owner, provider, OWNER_SCAN_ENTRY_CAP)
}

fn owner_hold_bounded(root: &Path, owner: &str, provider: &str, cap: usize) -> OwnerHold {
    match scan_owner(root, owner, provider, cap) {
        Ok(hold) => hold,
        Err(Failure::Missing) => OwnerHold::Clear,
        Err(_) => OwnerHold::Review,
    }
}

fn scan_owner(root: &Path, owner: &str, provider: &str, cap: usize) -> Checked<OwnerHold> {
    ensure(uuid(owner))?;
    ensure(
        root.is_absolute()
            && !root.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            }),
    )?;
    ancestors(root)?;
    let prefix = format!("op-{owner}-");
    let mut examined = 0usize;
    let mut matched = vec![];
    for entry in io(fs::read_dir(root))? {
        if examined >= cap {
            return Err(Failure::Overflow);
        }
        examined += 1;
        let name = io(entry)?.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(&prefix) {
            continue;
        }
        if matched.len() >= MAX_OPERATIONS {
            return Err(Failure::Overflow);
        }
        matched.push(name.into_owned());
    }
    for name in matched {
        ensure(valid_directory_name(&name))?;
        let directory = root.join(&name);
        let metadata = io(fs::symlink_metadata(&directory))?;
        ensure(metadata.is_dir() && !reparse(&metadata))?;
        let state = read_state(&directory, &name).map_err(|error| {
            if matches!(error, Failure::Missing) {
                Failure::Io
            } else {
                error
            }
        })?;
        ensure(state.identity.owner == owner && state.identity.provider == provider)?;
        if !state.terminal && state.unresolved() {
            return Ok(OwnerHold::Review);
        }
    }
    Ok(OwnerHold::Clear)
}

#[cfg(test)]
mod tests;
