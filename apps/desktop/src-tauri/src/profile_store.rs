//! Reserved public profile configuration only. Profile IDs are not managed CLI
//! owners. No account, credential or Docker access exists in this module.
//! The root must be app-owned: path checks do not prevent hostile local swaps.
use crate::launcher_process::{regular, safe_ancestors};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, Runtime, Webview,
};

const MAX_BYTES: usize = 8192;
const MAX_PROFILES: usize = 16;
const MAX_REVISION: u32 = 1_000_000_000;
const DENIED: &str = "local_managed_profiles_denied";
const UNAVAILABLE: &str = "local_managed_profiles_unavailable";
const CONFLICT: &str = "local_managed_profiles_conflict";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Provider {
    Claude,
    Codex,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Profile {
    profile_id: String,
    provider: Provider,
    name: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Catalog {
    schema_version: String,
    revision: u32,
    profiles: Vec<Profile>,
    #[serde(deserialize_with = "nullable")]
    selected_profile_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Status {
    schema_version: &'static str,
    availability: &'static str,
    revision: u32,
    profiles: Vec<Profile>,
    selected_profile_id: Option<String>,
}
impl Catalog {
    fn empty() -> Self {
        Self {
            schema_version: "1.0".into(),
            revision: 0,
            profiles: vec![],
            selected_profile_id: None,
        }
    }
    fn valid(&self) -> bool {
        let mut identities = HashSet::new();
        self.schema_version == "1.0"
            && self.revision <= MAX_REVISION
            && self.profiles.len() <= MAX_PROFILES
            && self.profiles.iter().all(|profile| {
                uuid(&profile.profile_id)
                    && name(&profile.name)
                    && identities.insert(profile.profile_id.as_str())
            })
            && self.selected_profile_id.as_ref().is_none_or(|selected| {
                self.profiles
                    .iter()
                    .any(|profile| &profile.profile_id == selected)
            })
    }
    fn status(self) -> Status {
        Status {
            schema_version: "1.0",
            availability: "available",
            revision: self.revision,
            profiles: self.profiles,
            selected_profile_id: self.selected_profile_id,
        }
    }
}
impl Status {
    fn unavailable() -> Self {
        Self {
            availability: "unavailable",
            ..Catalog::empty().status()
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    schema_version: String,
    request_id: String,
    provider: Provider,
    name: String,
    expected_revision: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Select {
    schema_version: String,
    profile_id: String,
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

fn uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && b"89ab".contains(&bytes[19])
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
}
fn nullable<'de, D: serde::Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(input)
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.trim() == value
        && !value.starts_with('\u{feff}')
        && !value.ends_with('\u{feff}')
        && !value.chars().any(char::is_control)
}

struct StoreSlots {
    outstanding: AtomicUsize,
    gate: Mutex<()>,
}
impl StoreSlots {
    const fn new() -> Self {
        Self {
            outstanding: AtomicUsize::new(0),
            gate: Mutex::new(()),
        }
    }
    fn acquire(&self) -> Option<StoreGuard<'_>> {
        let mut count = self.outstanding.load(Ordering::Acquire);
        loop {
            if count >= 2 {
                return None;
            }
            match self.outstanding.compare_exchange_weak(
                count,
                count + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(StoreGuard(self)),
                Err(observed) => count = observed,
            }
        }
    }
}
struct StoreGuard<'a>(&'a StoreSlots);
impl Drop for StoreGuard<'_> {
    fn drop(&mut self) {
        self.0.outstanding.fetch_sub(1, Ordering::AcqRel);
    }
}
static STORE: StoreSlots = StoreSlots::new();
static TEMP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

// Multiple application instances share an advisory OS lock. The stable lock
// file is never deleted or replaced, and its handle releases on process exit.
fn mutation_lock(root: &Path) -> Result<fs::File, &'static str> {
    root_ready(root, true)?;
    let path = root.join(".profiles.lock");
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && regular(&path) => {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|_| UNAVAILABLE)?
        }
        _ => return Err(UNAVAILABLE),
    };
    if !safe_ancestors(root) || !regular(&path) {
        return Err(UNAVAILABLE);
    }
    file.try_lock().map_err(|_| CONFLICT)?;
    Ok(file)
}

// Check each existing ancestor even when the profile directory is absent.
// Reads never create a directory. Writes create one component at a time.
fn root_ready(root: &Path, create: bool) -> Result<bool, &'static str> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(UNAVAILABLE);
    }
    let mut ancestors = root.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    let mut missing = false;
    for ancestor in ancestors {
        match fs::symlink_metadata(ancestor) {
            Ok(_) if safe_ancestors(ancestor) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create {
                    fs::create_dir(ancestor).map_err(|_| UNAVAILABLE)?;
                    if !safe_ancestors(ancestor) {
                        return Err(UNAVAILABLE);
                    }
                } else {
                    missing = true;
                }
            }
            _ => return Err(UNAVAILABLE),
        }
    }
    Ok(!missing)
}
fn read(root: &Path) -> Result<Catalog, &'static str> {
    if !root_ready(root, false)? {
        return Ok(Catalog::empty());
    }
    let path = root.join("profiles.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Catalog::empty()),
        Ok(metadata) if metadata.len() <= MAX_BYTES as u64 && regular(&path) => {}
        _ => return Err(UNAVAILABLE),
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .map_err(|_| UNAVAILABLE)?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() > MAX_BYTES {
        return Err(UNAVAILABLE);
    }
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    if !catalog.valid() {
        return Err(UNAVAILABLE);
    }
    Ok(catalog)
}
// Resolve only the saved, selected profile. Native callers never supply a
// provider, runtime owner, path or authentication material.
pub(crate) fn selected_provider(root: &Path, profile_id: &str) -> Result<Provider, &'static str> {
    if !uuid(profile_id) {
        return Err(DENIED);
    }
    let _gate = STORE.gate.lock().map_err(|_| UNAVAILABLE)?;
    let catalog = read(root)?;
    if catalog.selected_profile_id.as_deref() != Some(profile_id) {
        return Err(CONFLICT);
    }
    catalog
        .profiles
        .iter()
        .find(|profile| profile.profile_id == profile_id)
        .map(|profile| profile.provider)
        .ok_or(CONFLICT)
}
fn publish(root: &Path, catalog: &Catalog) -> Result<(), &'static str> {
    publish_with(root, catalog, || Ok(()))
}
fn publish_with(
    root: &Path,
    catalog: &Catalog,
    before_commit: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    if !catalog.valid() {
        return Err(UNAVAILABLE);
    }
    let mut bytes = serde_json::to_vec(catalog).map_err(|_| UNAVAILABLE)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(UNAVAILABLE);
    }
    root_ready(root, true)?;
    let target = root.join("profiles.json");
    match fs::symlink_metadata(&target) {
        Ok(_) if regular(&target) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(UNAVAILABLE),
    }
    let suffix = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| UNAVAILABLE)?
        .as_nanos();
    let temporary = root.join(format!(
        ".profiles-{}-{stamp}-{suffix}.tmp",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| UNAVAILABLE)?;
    let result = (|| {
        file.write_all(&bytes).map_err(|_| UNAVAILABLE)?;
        file.sync_all().map_err(|_| UNAVAILABLE)?;
        drop(file);
        before_commit()?;
        if !safe_ancestors(root) || !regular(&temporary) {
            return Err(UNAVAILABLE);
        }
        match fs::symlink_metadata(&target) {
            Ok(_) if regular(&target) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(UNAVAILABLE),
        }
        // No fallible operation follows the commit: a reported publication
        // failure therefore leaves the previous catalog in place.
        fs::rename(&temporary, &target).map_err(|_| UNAVAILABLE)?;
        // File contents are synced. Directory sync is best-effort where the
        // platform supports it; no power-loss durability is claimed.
        #[cfg(unix)]
        if let Ok(directory) = fs::File::open(root) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn create(root: &Path, request: Create) -> Result<Status, &'static str> {
    if request.schema_version != "1.0"
        || !uuid(&request.request_id)
        || !name(&request.name)
        || request.expected_revision > MAX_REVISION
    {
        return Err(DENIED);
    }
    let _lock = mutation_lock(root)?;
    let mut catalog = read(root)?;
    if let Some(existing) = catalog
        .profiles
        .iter()
        .find(|profile| profile.profile_id == request.request_id)
    {
        return if existing.provider == request.provider && existing.name == request.name {
            Ok(catalog.status())
        } else {
            Err(CONFLICT)
        };
    }
    if catalog.revision != request.expected_revision
        || catalog.revision >= MAX_REVISION
        || catalog.profiles.len() >= MAX_PROFILES
    {
        return Err(CONFLICT);
    }
    catalog.profiles.push(Profile {
        profile_id: request.request_id,
        provider: request.provider,
        name: request.name,
    });
    catalog.revision += 1;
    publish(root, &catalog)?;
    Ok(catalog.status())
}
fn select(root: &Path, request: Select) -> Result<Status, &'static str> {
    if request.schema_version != "1.0"
        || !uuid(&request.profile_id)
        || request.expected_revision > MAX_REVISION
    {
        return Err(DENIED);
    }
    let _lock = mutation_lock(root)?;
    let mut catalog = read(root)?;
    if catalog.revision != request.expected_revision
        || !catalog
            .profiles
            .iter()
            .any(|profile| profile.profile_id == request.profile_id)
    {
        return Err(CONFLICT);
    }
    if catalog.selected_profile_id.as_ref() == Some(&request.profile_id) {
        return Ok(catalog.status());
    }
    if catalog.revision >= MAX_REVISION {
        return Err(CONFLICT);
    }
    catalog.selected_profile_id = Some(request.profile_id);
    catalog.revision += 1;
    publish(root, &catalog)?;
    Ok(catalog.status())
}
#[derive(Clone, Copy)]
enum Shape {
    Status,
    Create,
    Select,
}
fn exact_object<'a>(
    value: &'a serde_json::Value,
    fields: &[&str],
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    let object = value.as_object()?;
    (object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)))
        .then_some(object)
}
// Inspect borrowed scalar values before cloning. Unexpected nested payloads or
// giant strings cannot expand a recursive clone or enter the filesystem queue.
fn preflight(value: &serde_json::Value, shape: Shape) -> bool {
    if matches!(shape, Shape::Status) {
        return exact_object(value, &[]).is_some();
    }
    let Some(wrapper) = exact_object(value, &["request"]) else {
        return false;
    };
    let fields: &[&str] = match shape {
        Shape::Create => &[
            "schema_version",
            "request_id",
            "provider",
            "name",
            "expected_revision",
        ],
        Shape::Select => &["schema_version", "profile_id", "expected_revision"],
        Shape::Status => return false,
    };
    let Some(request) = exact_object(&wrapper["request"], fields) else {
        return false;
    };
    if request["schema_version"].as_str() != Some("1.0")
        || !request["expected_revision"]
            .as_u64()
            .is_some_and(|revision| revision <= u64::from(MAX_REVISION))
    {
        return false;
    }
    match shape {
        Shape::Create => {
            request["request_id"].as_str().is_some_and(uuid)
                && matches!(request["provider"].as_str(), Some("claude" | "codex"))
                && request["name"].as_str().is_some_and(name)
        }
        Shape::Select => request["profile_id"].as_str().is_some_and(uuid),
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
enum Operation {
    Status,
    Create(Create),
    Select(Select),
}
async fn execute<R: Runtime>(
    app: AppHandle<R>,
    operation: Operation,
) -> Result<Status, &'static str> {
    let is_status = matches!(&operation, Operation::Status);
    let Some(guard) = STORE.acquire() else {
        return if is_status {
            Ok(Status::unavailable())
        } else {
            Err(UNAVAILABLE)
        };
    };
    let Ok(directory) = app.path().app_local_data_dir() else {
        return if is_status {
            Ok(Status::unavailable())
        } else {
            Err(UNAVAILABLE)
        };
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let Ok(_gate) = STORE.gate.lock() else {
            return if is_status {
                Ok(Status::unavailable())
            } else {
                Err(UNAVAILABLE)
            };
        };
        let root = directory.join("managed-profiles");
        match operation {
            Operation::Status => Ok(read(&root)
                .map(Catalog::status)
                .unwrap_or_else(|_| Status::unavailable())),
            Operation::Create(request) => create(&root, request),
            Operation::Select(request) => select(&root, request),
        }
    })
    .await
    .unwrap_or_else(|_| {
        if is_status {
            Ok(Status::unavailable())
        } else {
            Err(UNAVAILABLE)
        }
    })
}
// Application manifest + local main capability enforce the origin; wrappers
// additionally reject other windows and all caller-selected paths/extra fields.
#[tauri::command]
pub(crate) async fn local_managed_profiles_status<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
) -> Result<Status, &'static str> {
    let _: Empty = decode(&webview, request, Shape::Status)?;
    execute(app, Operation::Status).await
}
#[tauri::command]
pub(crate) async fn local_managed_profile_create<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Create> = decode(&webview, request, Shape::Create)?;
    execute(app, Operation::Create(value.request)).await
}
#[tauri::command]
pub(crate) async fn local_managed_profile_select<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Select> = decode(&webview, request, Shape::Select)?;
    execute(app, Operation::Select(value.request)).await
}

#[cfg(test)]
mod tests;
