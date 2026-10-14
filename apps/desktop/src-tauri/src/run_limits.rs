//! Native-owned local run limits (ADR 0024): a per-attempt cap and a rolling
//! 24 hour wall-time budget, persisted next to the managed profiles. The
//! webview can only display and edit the two caps; the supervisor reserves a
//! run's time here before any worker is spawned and fails closed whenever the
//! ledger cannot be consulted. Wall time only: no token or subscription usage.
//!
//! The ledger is shared by one application instance behind a process-local
//! mutex. A second concurrent instance is not coordinated: its stale-open
//! folding is conservative (it counts the whole reservation) but last writer
//! wins on the file. The root must be app-owned, as for `profile_store`.
//!
//! Every function except the command wrappers is pure with respect to time:
//! the caller injects `now_ms` (Unix milliseconds).
use crate::{
    launcher::uuid,
    launcher_process::{regular, safe_ancestors},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, MutexGuard,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, Runtime, Webview,
};

pub(crate) const EXHAUSTED: &str = "local_budget_exhausted";
pub(crate) const UNAVAILABLE: &str = "local_budget_unavailable";
const DENIED: &str = "local_run_limits_denied";
const FILE: &str = "run-limits.json";
const WINDOW_MS: u64 = 86_400_000;
const MIN_RUN_MS: u64 = 60_000;
const MIN_RUN_SEC: u64 = 60;
const MAX_DAILY_SEC: u64 = 86_400;
const TASK_CEILING_SEC: u64 = 1200;
const MAX_USAGE_SEC: u64 = 172_800;
const DEFAULT_ATTEMPT_SEC: u64 = 1800;
const DEFAULT_DAILY_SEC: u64 = 7200;
const MAX_BYTES: usize = 32 * 1024;
const MAX_ENTRIES: usize = 256;
// Largest integer a JSON number carries exactly (and the TS side accepts).
const MAX_TIME_MS: u64 = 9_007_199_254_740_991;
// A merged entry saturates here; far above any daily cap, so it still means
// "exhausted" while keeping the sums comfortably inside u64.
const MAX_USED_MS: u64 = 10_000_000_000;

static LEDGER: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

fn lock() -> MutexGuard<'static, ()> {
    LEDGER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Entry {
    end_ms: u64,
    used_ms: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Open {
    request_id: String,
    started_ms: u64,
    reserved_ms: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Ledger {
    schema_version: String,
    attempt_sec: u64,
    daily_sec: u64,
    entries: Vec<Entry>,
    open: Option<Open>,
}

fn limits_valid(attempt_sec: u64, daily_sec: u64) -> bool {
    (MIN_RUN_SEC..=MAX_DAILY_SEC).contains(&attempt_sec)
        && (MIN_RUN_SEC..=MAX_DAILY_SEC).contains(&daily_sec)
        && attempt_sec <= daily_sec
}
fn in_window(end_ms: u64, now_ms: u64) -> bool {
    end_ms.saturating_add(WINDOW_MS) > now_ms
}
fn ceil_sec(ms: u64) -> u64 {
    ms.div_ceil(1000)
}

impl Ledger {
    fn defaults() -> Self {
        Self {
            schema_version: "1.0".into(),
            attempt_sec: DEFAULT_ATTEMPT_SEC,
            daily_sec: DEFAULT_DAILY_SEC,
            entries: vec![],
            open: None,
        }
    }
    fn valid(&self) -> bool {
        self.schema_version == "1.0"
            && limits_valid(self.attempt_sec, self.daily_sec)
            && self.entries.len() <= MAX_ENTRIES
            && self
                .entries
                .iter()
                .all(|entry| entry.end_ms <= MAX_TIME_MS && entry.used_ms <= MAX_USED_MS)
            && self.open.as_ref().is_none_or(|open| {
                uuid(&open.request_id)
                    && open.started_ms <= MAX_TIME_MS
                    && open.reserved_ms <= WINDOW_MS
            })
    }
    // A crashed run leaves its reservation open: count all of it, ending at
    // the moment the reservation would have run out.
    fn fold_open(&mut self) {
        if let Some(open) = self.open.take() {
            self.entries.push(Entry {
                end_ms: open
                    .started_ms
                    .saturating_add(open.reserved_ms)
                    .min(MAX_TIME_MS),
                used_ms: open.reserved_ms,
            });
        }
    }
    // Drop what left the window, order by end, and bound the entry count by
    // merging the two oldest into one that ends (so expires) later: the merge
    // can only over-count, never forget usage.
    fn prune(&mut self, now_ms: u64) {
        self.entries.retain(|entry| in_window(entry.end_ms, now_ms));
        self.entries.sort_by_key(|entry| entry.end_ms);
        while self.entries.len() > MAX_ENTRIES {
            let oldest = self.entries.remove(0);
            self.entries[0].used_ms = oldest
                .used_ms
                .saturating_add(self.entries[0].used_ms)
                .min(MAX_USED_MS);
        }
    }
    fn used_ms(&self, now_ms: u64) -> u64 {
        self.entries
            .iter()
            .filter(|entry| in_window(entry.end_ms, now_ms))
            .map(|entry| entry.used_ms)
            .sum()
    }
}

/// The time a started run holds. Settled exactly once when the run ends.
#[derive(Debug)]
pub(crate) struct Reservation {
    store: PathBuf,
    request_id: String,
    started_ms: u64,
    reserved_ms: u64,
    started: Instant,
}
impl Reservation {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }
}

// Check each existing ancestor; reads never create a directory, writes create
// one component at a time (same discipline as the profile registry).
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
// Missing store or file is the default ledger. Anything else that is not a
// small, regular, valid file is unavailable: callers fail closed.
fn read(store: &Path) -> Result<Ledger, &'static str> {
    if !root_ready(store, false)? {
        return Ok(Ledger::defaults());
    }
    let path = store.join(FILE);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Ledger::defaults()),
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
    let ledger: Ledger = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    if !ledger.valid() {
        return Err(UNAVAILABLE);
    }
    Ok(ledger)
}
fn publish(store: &Path, ledger: &Ledger) -> Result<(), &'static str> {
    publish_with(store, ledger, || Ok(()))
}
// Temp file + sync + rename. No fallible operation follows the commit, so a
// reported failure leaves the previous ledger in place.
fn publish_with(
    store: &Path,
    ledger: &Ledger,
    before_commit: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    if !ledger.valid() {
        return Err(UNAVAILABLE);
    }
    let mut bytes = serde_json::to_vec(ledger).map_err(|_| UNAVAILABLE)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(UNAVAILABLE);
    }
    root_ready(store, true)?;
    let target = store.join(FILE);
    match fs::symlink_metadata(&target) {
        Ok(_) if regular(&target) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(UNAVAILABLE),
    }
    let suffix = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| UNAVAILABLE)?
        .as_nanos();
    let temporary = store.join(format!(
        ".run-limits-{}-{stamp}-{suffix}.tmp",
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
        if !safe_ancestors(store) || !regular(&temporary) {
            return Err(UNAVAILABLE);
        }
        match fs::symlink_metadata(&target) {
            Ok(_) if regular(&target) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(UNAVAILABLE),
        }
        fs::rename(&temporary, &target).map_err(|_| UNAVAILABLE)?;
        #[cfg(unix)]
        if let Ok(directory) = fs::File::open(store) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Wall clock in Unix milliseconds; the only place real time enters.
pub(crate) fn now_ms() -> Option<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    u64::try_from(millis).ok().filter(|now| *now <= MAX_TIME_MS)
}

/// Hold time for one run before any worker exists. `ceiling` is the run's own
/// cap (task ceiling already narrowed by a lease). A budget that cannot grant
/// a whole minute is exhausted; a short ceiling alone is not (a nearly expired
/// lease is not a spent budget). Returns the time the run may use and the
/// reservation to settle.
pub(crate) fn reserve(
    store: &Path,
    now_ms: u64,
    request_id: &str,
    ceiling: Duration,
) -> Result<(Duration, Reservation), &'static str> {
    if !uuid(request_id) || now_ms > MAX_TIME_MS {
        return Err(UNAVAILABLE);
    }
    let _gate = lock();
    let mut ledger = read(store)?;
    ledger.fold_open();
    ledger.prune(now_ms);
    let remaining_ms = (ledger.daily_sec * 1000).saturating_sub(ledger.used_ms(now_ms));
    let budget_ms = (ledger.attempt_sec * 1000).min(remaining_ms);
    if budget_ms < MIN_RUN_MS {
        return Err(EXHAUSTED);
    }
    let ceiling_ms = u64::try_from(ceiling.as_millis()).unwrap_or(u64::MAX);
    let reserved_ms = ceiling_ms.min(budget_ms);
    ledger.open = Some(Open {
        request_id: request_id.into(),
        started_ms: now_ms,
        reserved_ms,
    });
    publish(store, &ledger)?;
    Ok((
        Duration::from_millis(reserved_ms),
        Reservation {
            store: store.to_path_buf(),
            request_id: request_id.into(),
            started_ms: now_ms,
            reserved_ms,
            started: Instant::now(),
        },
    ))
}

/// Replace the open reservation with what the run actually used: elapsed time
/// (the larger of the wall-clock and the monotonic measurement, so a clock set
/// back cannot hide usage) rounded up to whole seconds, at least one second and
/// at most the reservation. Best effort: it never panics and never fails the
/// run; if the ledger became unreadable the next reservation fails closed.
pub(crate) fn settle(reservation: Reservation, now_ms: u64) {
    let _gate = lock();
    let Ok(mut ledger) = read(&reservation.store) else {
        return;
    };
    let wall = now_ms.saturating_sub(reservation.started_ms);
    let monotonic = u64::try_from(reservation.started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let used_ms = (ceil_sec(wall.max(monotonic).min(reservation.reserved_ms)) * 1000)
        .max(1000)
        .min(reservation.reserved_ms);
    if ledger
        .open
        .as_ref()
        .is_some_and(|open| open.request_id == reservation.request_id)
    {
        ledger.open = None;
    }
    let end_ms = now_ms.max(reservation.started_ms).min(MAX_TIME_MS);
    ledger.entries.push(Entry { end_ms, used_ms });
    ledger.prune(end_ms);
    let _ = publish(&reservation.store, &ledger);
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct LimitsView {
    attempt_sec: u64,
    daily_sec: u64,
    concurrency: u8,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct Usage {
    used_sec: u64,
    open_sec: u64,
    remaining_sec: u64,
    window_seconds: u64,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct Effective {
    max_sec: u64,
    startable: bool,
    reason: Option<&'static str>,
}
/// Exactly the browser contract's RunLimitsStatus.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct Status {
    schema_version: &'static str,
    availability: &'static str,
    limits: LimitsView,
    usage: Usage,
    effective: Effective,
    paid_mode: &'static str,
}
impl Status {
    // Unreadable limits or ledger: defaults, zero usage and remaining, not
    // startable, reason local_budget_unavailable, availability "available"
    // (the native side is present; only its state cannot be consulted). Also
    // reported when the store directory itself cannot be resolved. Saving
    // valid limits repairs a corrupt (but replaceable) file.
    fn fail_closed() -> Self {
        Self {
            schema_version: "1.0",
            availability: "available",
            limits: LimitsView {
                attempt_sec: DEFAULT_ATTEMPT_SEC,
                daily_sec: DEFAULT_DAILY_SEC,
                concurrency: 1,
            },
            usage: Usage {
                used_sec: 0,
                open_sec: 0,
                remaining_sec: 0,
                window_seconds: 86_400,
            },
            effective: Effective {
                max_sec: 0,
                startable: false,
                reason: Some(UNAVAILABLE),
            },
            paid_mode: "disabled",
        }
    }
    // Used and open time are rounded up and the rest down, so the display is
    // never more permissive than the millisecond check in `reserve`.
    fn of(ledger: &Ledger, now_ms: u64) -> Self {
        let used_sec = ceil_sec(ledger.used_ms(now_ms)).min(MAX_USAGE_SEC);
        let open_sec = ledger
            .open
            .as_ref()
            .filter(|open| in_window(open.started_ms.saturating_add(open.reserved_ms), now_ms))
            .map_or(0, |open| ceil_sec(open.reserved_ms).min(MAX_USAGE_SEC));
        let remaining_sec = ledger
            .daily_sec
            .saturating_sub(used_sec)
            .saturating_sub(open_sec);
        let max_sec = TASK_CEILING_SEC.min(ledger.attempt_sec).min(remaining_sec);
        let startable = max_sec >= MIN_RUN_SEC;
        Self {
            schema_version: "1.0",
            availability: "available",
            limits: LimitsView {
                attempt_sec: ledger.attempt_sec,
                daily_sec: ledger.daily_sec,
                concurrency: 1,
            },
            usage: Usage {
                used_sec,
                open_sec,
                remaining_sec,
                window_seconds: 86_400,
            },
            effective: Effective {
                max_sec,
                startable,
                reason: (!startable).then_some(EXHAUSTED),
            },
            paid_mode: "disabled",
        }
    }
}

pub(crate) fn status(store: &Path, now_ms: u64) -> Status {
    let _gate = lock();
    read(store).map_or_else(
        |_| Status::fail_closed(),
        |ledger| Status::of(&ledger, now_ms),
    )
}

/// Validate and persist the two caps, keeping valid usage entries and any open
/// reservation. An unreadable or corrupt ledger file is replaced by one holding
/// only the new caps: saving is the explicit repair (a symlinked or irregular
/// target still fails). Replies with the resulting status.
pub(crate) fn save(
    store: &Path,
    attempt_sec: u64,
    daily_sec: u64,
    now_ms: u64,
) -> Result<Status, &'static str> {
    if !limits_valid(attempt_sec, daily_sec) || now_ms > MAX_TIME_MS {
        return Err(DENIED);
    }
    let _gate = lock();
    let mut ledger = read(store).unwrap_or_else(|_| Ledger::defaults());
    ledger.attempt_sec = attempt_sec;
    ledger.daily_sec = daily_sec;
    ledger.prune(now_ms);
    publish(store, &ledger).map_err(|_| DENIED)?;
    Ok(Status::of(&ledger, now_ms))
}

#[derive(Clone, Copy)]
enum Shape {
    Status,
    Save,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    schema_version: String,
    attempt_sec: u64,
    daily_sec: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wrapper<T> {
    request: T,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

fn exact_object<'a>(
    value: &'a serde_json::Value,
    fields: &[&str],
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    let object = value.as_object()?;
    (object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)))
        .then_some(object)
}
fn preflight(value: &serde_json::Value, shape: Shape) -> bool {
    if matches!(shape, Shape::Status) {
        return exact_object(value, &[]).is_some();
    }
    let Some(wrapper) = exact_object(value, &["request"]) else {
        return false;
    };
    let Some(request) = exact_object(
        &wrapper["request"],
        &["schema_version", "attempt_sec", "daily_sec"],
    ) else {
        return false;
    };
    request["schema_version"].as_str() == Some("1.0")
        && match (
            request["attempt_sec"].as_u64(),
            request["daily_sec"].as_u64(),
        ) {
            (Some(attempt), Some(daily)) => limits_valid(attempt, daily),
            _ => false,
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

#[tauri::command]
pub(crate) async fn local_run_limits_status<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
) -> Result<Status, &'static str> {
    let _: Empty = decode(&webview, request, Shape::Status)?;
    let (Ok(store), Some(now)) = (app.path().app_local_data_dir(), now_ms()) else {
        return Ok(Status::fail_closed());
    };
    Ok(
        tauri::async_runtime::spawn_blocking(move || status(&store, now))
            .await
            .unwrap_or_else(|_| Status::fail_closed()),
    )
}
#[tauri::command]
pub(crate) async fn local_run_limits_save<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: Request<'_>,
) -> Result<Status, &'static str> {
    let value: Wrapper<Save> = decode(&webview, request, Shape::Save)?;
    let request = value.request;
    if request.schema_version != "1.0" {
        return Err(DENIED);
    }
    let store = app.path().app_local_data_dir().map_err(|_| DENIED)?;
    let now = now_ms().ok_or(DENIED)?;
    tauri::async_runtime::spawn_blocking(move || {
        save(&store, request.attempt_sec, request.daily_sec, now)
    })
    .await
    .map_err(|_| DENIED)?
}

#[cfg(test)]
mod tests;
