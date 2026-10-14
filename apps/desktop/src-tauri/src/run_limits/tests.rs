use super::*;
use serde_json::{json, Value};
use tauri::{
    ipc::{CallbackFn, InvokeResponseBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindowBuilder,
};

const ID: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "33333333-3333-4333-8333-333333333333";
const NOW: u64 = 1_800_000_000_000;
const HOUR: u64 = 3_600_000;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "cg-run-limits-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&directory).unwrap();
        Self(directory)
    }
    fn file(&self) -> PathBuf {
        self.0.join(FILE)
    }
    fn write(&self, value: Value) {
        fs::write(self.file(), value.to_string()).unwrap();
    }
    fn ledger(&self) -> Value {
        serde_json::from_slice(&fs::read(self.file()).unwrap()).unwrap()
    }
    fn names(&self) -> Vec<String> {
        let mut names = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn ledger(attempt: u64, daily: u64, entries: Value, open: Value) -> Value {
    json!({"schema_version":"1.0","attempt_sec":attempt,"daily_sec":daily,"entries":entries,"open":open})
}
fn value(status: &Status) -> Value {
    serde_json::to_value(status).unwrap()
}
fn secs(seconds: u64) -> Duration {
    Duration::from_secs(seconds)
}

#[test]
fn missing_ledger_means_defaults_and_reading_creates_nothing() {
    let fixture = Fixture::new();
    assert_eq!(
        value(&status(&fixture.0, NOW)),
        json!({"schema_version":"1.0","availability":"available","limits":{"attempt_sec":1800,"daily_sec":7200,"concurrency":1},"usage":{"used_sec":0,"open_sec":0,"remaining_sec":7200,"window_seconds":86400},"effective":{"max_sec":1200,"startable":true,"reason":null},"paid_mode":"disabled"})
    );
    assert!(fixture.names().is_empty());
    // A store that does not exist yet is defaults too, and stays absent.
    let absent = fixture.0.join("absent");
    assert!(status(&absent, NOW).effective.startable);
    assert!(!absent.exists());
    let (allowed, _held) = reserve(&fixture.0, NOW, ID, secs(1200)).unwrap();
    assert_eq!(allowed, secs(1200));
    assert_eq!(
        fixture.ledger(),
        ledger(
            1800,
            7200,
            json!([]),
            json!({"request_id":ID,"started_ms":NOW,"reserved_ms":1_200_000})
        )
    );
    assert_eq!(fixture.names(), vec![FILE.to_string()]);
}

#[test]
fn only_entries_inside_the_rolling_window_count() {
    let fixture = Fixture::new();
    fixture.write(ledger(
        1800,
        7200,
        json!([
            {"end_ms": NOW - WINDOW_MS, "used_ms": 7_000_000},
            {"end_ms": NOW - WINDOW_MS + 1, "used_ms": 6_000_000},
        ]),
        Value::Null,
    ));
    // The first entry ended exactly 24 h ago and is gone; the second counts.
    let seen = status(&fixture.0, NOW);
    assert_eq!(seen.usage.used_sec, 6000);
    assert_eq!(seen.usage.remaining_sec, 1200);
    assert_eq!(seen.effective.max_sec, 1200);
    let (allowed, held) = reserve(&fixture.0, NOW, ID, secs(1200)).unwrap();
    assert_eq!(allowed, secs(1200));
    // Writing drops the expired entry.
    assert_eq!(fixture.ledger()["entries"].as_array().unwrap().len(), 1);
    drop(held);
    // One millisecond later the second one has left the window as well.
    fixture.write(ledger(
        1800,
        7200,
        json!([{"end_ms": NOW - WINDOW_MS + 1, "used_ms": 6_000_000}]),
        Value::Null,
    ));
    assert_eq!(status(&fixture.0, NOW).usage.used_sec, 6000);
    assert_eq!(status(&fixture.0, NOW + 1).usage.used_sec, 0);
}

#[test]
fn reserve_then_settle_records_elapsed_whole_seconds() {
    let fixture = Fixture::new();
    let (allowed, held) = reserve(&fixture.0, NOW, ID, secs(1200)).unwrap();
    assert_eq!(allowed, secs(1200));
    let during = status(&fixture.0, NOW + 1000);
    assert_eq!(
        (
            during.usage.used_sec,
            during.usage.open_sec,
            during.usage.remaining_sec
        ),
        (0, 1200, 6000)
    );
    settle(held, NOW + 95_200);
    assert_eq!(
        fixture.ledger(),
        ledger(
            1800,
            7200,
            json!([{"end_ms": NOW + 95_200, "used_ms": 96_000}]),
            Value::Null
        )
    );
    // Instant settlement still costs one second.
    let (_, held) = reserve(&fixture.0, NOW + 100_000, OTHER, secs(1200)).unwrap();
    settle(held, NOW + 100_000);
    assert_eq!(fixture.ledger()["entries"][1]["used_ms"], 1000);
    // Never more than was reserved, even when settled long after.
    let (allowed, held) = reserve(&fixture.0, NOW + 200_000, ID, secs(90)).unwrap();
    assert_eq!(allowed, secs(90));
    settle(held, NOW + 200_000 + 10 * HOUR);
    assert_eq!(fixture.ledger()["entries"][2]["used_ms"], 90_000);
    assert!(fixture.ledger()["open"].is_null());
    // A clock set back cannot produce a negative or zero cost.
    let (_, held) = reserve(&fixture.0, NOW + 300_000, OTHER, secs(1200)).unwrap();
    settle(held, NOW);
    assert_eq!(fixture.ledger()["entries"][2]["used_ms"], 1000);
    // Only the reservation's own request clears the open slot.
    let (_, first) = reserve(&fixture.0, NOW + 400_000, ID, secs(1200)).unwrap();
    let (_, second) = reserve(&fixture.0, NOW + 500_000, OTHER, secs(1200)).unwrap();
    settle(first, NOW + 410_000);
    assert_eq!(fixture.ledger()["open"]["request_id"], OTHER);
    settle(second, NOW + 520_000);
    assert!(fixture.ledger()["open"].is_null());
}

#[test]
fn a_stale_open_reservation_is_folded_in_at_its_reserved_time() {
    let fixture = Fixture::new();
    fixture.write(ledger(
        1800,
        7200,
        json!([]),
        json!({"request_id":ID,"started_ms":NOW,"reserved_ms":1_800_000}),
    ));
    let (allowed, _held) = reserve(&fixture.0, NOW + HOUR, OTHER, secs(1200)).unwrap();
    assert_eq!(allowed, secs(1200));
    let written = fixture.ledger();
    assert_eq!(
        written["entries"],
        json!([{"end_ms": NOW + 1_800_000, "used_ms": 1_800_000}])
    );
    assert_eq!(written["open"]["request_id"], OTHER);
    // The folded time leaves the window 24 h after the reservation ran out.
    assert_eq!(status(&fixture.0, NOW + 1_800_000).usage.used_sec, 1800);
    assert_eq!(
        status(&fixture.0, NOW + 1_800_000 + WINDOW_MS - 1)
            .usage
            .used_sec,
        1800
    );
    fixture.write(ledger(
        1800,
        7200,
        json!([]),
        json!({"request_id":ID,"started_ms":NOW,"reserved_ms":1_800_000}),
    ));
    assert_eq!(
        status(&fixture.0, NOW + 1_800_000 + WINDOW_MS)
            .usage
            .open_sec,
        0
    );
}

#[test]
fn the_entry_cap_merges_the_oldest_entries_without_forgetting_usage() {
    let fixture = Fixture::new();
    let entries = (0..256)
        .map(|index| json!({"end_ms": NOW - 10_000_000 + index * 1000, "used_ms": 2000}))
        .collect::<Vec<_>>();
    fixture.write(ledger(1800, 86_400, json!(entries), Value::Null));
    let (_, held) = reserve(&fixture.0, NOW, ID, secs(120)).unwrap();
    settle(held, NOW + 61_000);
    let written = fixture.ledger();
    let list = written["entries"].as_array().unwrap();
    assert_eq!(list.len(), 256);
    // The two oldest became one that ends at the later of them.
    assert_eq!(
        list[0],
        json!({"end_ms": NOW - 10_000_000 + 1000, "used_ms": 4000})
    );
    let total: u64 = list.iter().map(|e| e["used_ms"].as_u64().unwrap()).sum();
    assert_eq!(total, 256 * 2000 + 61_000);
    let sizes = fs::metadata(fixture.file()).unwrap().len();
    assert!(sizes < MAX_BYTES as u64);
    assert_eq!(status(&fixture.0, NOW + 61_000).usage.used_sec, 573);
}

#[test]
fn unreadable_ledgers_fail_closed() {
    let fixture = Fixture::new();
    let bad = [
        "".to_string(),
        "not json".to_string(),
        ledger(1800, 7200, json!([]), Value::Null)
            .to_string()
            .replace("1.0", "2.0"),
        json!({"schema_version":"1.0","attempt_sec":1800,"daily_sec":7200,"entries":[],"open":null,"extra":1}).to_string(),
        ledger(59, 7200, json!([]), Value::Null).to_string(),
        ledger(1800, 1799, json!([]), Value::Null).to_string(),
        ledger(1800, 86_401, json!([]), Value::Null).to_string(),
        ledger(1800, 7200, json!([{"end_ms":1,"used_ms":1,"x":1}]), Value::Null).to_string(),
        ledger(1800, 7200, json!([{"end_ms":-1,"used_ms":1}]), Value::Null).to_string(),
        ledger(1800, 7200, json!([{"end_ms":1.5,"used_ms":1}]), Value::Null).to_string(),
        ledger(
            1800,
            7200,
            json!([]),
            json!({"request_id":"nope","started_ms":NOW,"reserved_ms":1000}),
        )
        .to_string(),
        ledger(
            1800,
            7200,
            json!(vec![json!({"end_ms":NOW,"used_ms":1}); 257]),
            Value::Null,
        )
        .to_string(),
        format!("{}{}", " ".repeat(MAX_BYTES), ledger(1800, 7200, json!([]), Value::Null)),
    ];
    for (index, text) in bad.iter().enumerate() {
        fs::write(fixture.file(), text).unwrap();
        assert_eq!(status(&fixture.0, NOW), Status::fail_closed(), "{index}");
        assert_eq!(
            reserve(&fixture.0, NOW, ID, secs(1200)).unwrap_err(),
            UNAVAILABLE,
            "{index}"
        );
        assert_eq!(&fs::read_to_string(fixture.file()).unwrap(), text);
    }
    // A directory in place of the file is irregular.
    fs::remove_file(fixture.file()).unwrap();
    fs::create_dir(fixture.file()).unwrap();
    assert_eq!(status(&fixture.0, NOW), Status::fail_closed());
    assert_eq!(
        reserve(&fixture.0, NOW, ID, secs(1200)).unwrap_err(),
        UNAVAILABLE
    );
    assert!(save(&fixture.0, 600, 3600, NOW).is_err());
    fs::remove_dir(fixture.file()).unwrap();
    #[cfg(unix)]
    {
        let target = fixture.0.join("elsewhere.json");
        fs::write(
            &target,
            ledger(1800, 7200, json!([]), Value::Null).to_string(),
        )
        .unwrap();
        std::os::unix::fs::symlink(&target, fixture.file()).unwrap();
        assert_eq!(status(&fixture.0, NOW), Status::fail_closed());
        assert!(reserve(&fixture.0, NOW, ID, secs(1200)).is_err());
        assert!(save(&fixture.0, 600, 3600, NOW).is_err());
    }
    // Invalid identity or time never reaches the file.
    fs::remove_dir_all(&fixture.0).unwrap();
    fs::create_dir(&fixture.0).unwrap();
    assert!(reserve(&fixture.0, NOW, "not-a-uuid", secs(1200)).is_err());
    assert!(reserve(&fixture.0, MAX_TIME_MS + 1, ID, secs(1200)).is_err());
    assert!(fixture.names().is_empty());
}

#[test]
fn a_budget_below_one_minute_is_exhausted_but_a_short_ceiling_is_not() {
    let fixture = Fixture::new();
    fixture.write(ledger(
        1800,
        7200,
        json!([{"end_ms": NOW, "used_ms": 7_140_001}]),
        Value::Null,
    ));
    let before = fs::read(fixture.file()).unwrap();
    assert_eq!(
        reserve(&fixture.0, NOW, ID, secs(1200)).unwrap_err(),
        EXHAUSTED
    );
    // Exhaustion changes nothing on disk.
    assert_eq!(fs::read(fixture.file()).unwrap(), before);
    let seen = status(&fixture.0, NOW);
    assert_eq!(
        (
            seen.effective.max_sec,
            seen.effective.startable,
            seen.effective.reason
        ),
        (59, false, Some(EXHAUSTED))
    );
    // Exactly one minute left is granted, and the ceiling still narrows it.
    fixture.write(ledger(
        1800,
        7200,
        json!([{"end_ms": NOW, "used_ms": 7_140_000}]),
        Value::Null,
    ));
    assert_eq!(
        reserve(&fixture.0, NOW, ID, secs(1200)).unwrap().0,
        secs(60)
    );
    fixture.write(ledger(1800, 7200, json!([]), Value::Null));
    assert_eq!(reserve(&fixture.0, NOW, ID, secs(30)).unwrap().0, secs(30));
    assert_eq!(
        reserve(&fixture.0, NOW, ID, Duration::ZERO).unwrap().0,
        secs(0)
    );
    // The attempt cap narrows the ceiling.
    fixture.write(ledger(60, 7200, json!([]), Value::Null));
    assert_eq!(
        reserve(&fixture.0, NOW, ID, secs(1200)).unwrap().0,
        secs(60)
    );
    assert_eq!(fixture.ledger()["open"]["reserved_ms"], 60_000);
}

#[test]
fn save_validates_keeps_usage_and_repairs_a_corrupt_file() {
    let fixture = Fixture::new();
    for (attempt, daily) in [(59, 7200), (60, 59), (7201, 7200), (600, 86_401), (0, 0)] {
        assert!(save(&fixture.0, attempt, daily, NOW).is_err());
    }
    assert!(fixture.names().is_empty());
    let saved = save(&fixture.0, 600, 3600, NOW).unwrap();
    assert_eq!(saved.limits.attempt_sec, 600);
    assert_eq!(saved.limits.daily_sec, 3600);
    assert_eq!(saved.effective.max_sec, 600);
    assert_eq!(fixture.ledger(), ledger(600, 3600, json!([]), Value::Null));
    assert!(save(&fixture.0, 60, 60, NOW).is_ok());
    assert!(save(&fixture.0, 86_400, 86_400, NOW).is_ok());
    // Usage and an open reservation survive; expired entries are dropped.
    fixture.write(ledger(
        1800,
        7200,
        json!([
            {"end_ms": NOW - WINDOW_MS, "used_ms": 5000},
            {"end_ms": NOW - 1000, "used_ms": 61_000},
        ]),
        json!({"request_id":ID,"started_ms":NOW,"reserved_ms":120_000}),
    ));
    let saved = save(&fixture.0, 900, 1800, NOW).unwrap();
    assert_eq!(
        (
            saved.usage.used_sec,
            saved.usage.open_sec,
            saved.usage.remaining_sec
        ),
        (61, 120, 1619)
    );
    assert_eq!(
        fixture.ledger(),
        ledger(
            900,
            1800,
            json!([{"end_ms": NOW - 1000, "used_ms": 61_000}]),
            json!({"request_id":ID,"started_ms":NOW,"reserved_ms":120_000})
        )
    );
    // A corrupt file is replaced: saving is the explicit repair.
    fs::write(fixture.file(), "{corrupt").unwrap();
    assert_eq!(status(&fixture.0, NOW), Status::fail_closed());
    let repaired = save(&fixture.0, 300, 900, NOW).unwrap();
    assert_eq!(repaired.limits.attempt_sec, 300);
    assert_eq!(fixture.ledger(), ledger(300, 900, json!([]), Value::Null));
    assert_eq!(status(&fixture.0, NOW), repaired);
}

#[test]
fn a_failed_publish_leaves_the_previous_ledger_and_no_temporary_file() {
    let fixture = Fixture::new();
    fixture.write(ledger(1800, 7200, json!([]), Value::Null));
    let before = fs::read(fixture.file()).unwrap();
    let mut next = Ledger::defaults();
    next.attempt_sec = 600;
    assert!(publish_with(&fixture.0, &next, || Err(UNAVAILABLE)).is_err());
    assert_eq!(fs::read(fixture.file()).unwrap(), before);
    assert_eq!(fixture.names(), vec![FILE.to_string()]);
    publish(&fixture.0, &next).unwrap();
    assert_eq!(read(&fixture.0).unwrap().attempt_sec, 600);
    // An invalid ledger is never published.
    next.attempt_sec = 1;
    assert!(publish(&fixture.0, &next).is_err());
    assert_eq!(read(&fixture.0).unwrap().attempt_sec, 600);
    assert_eq!(fixture.names(), vec![FILE.to_string()]);
}

#[test]
fn status_json_shapes_match_the_browser_contract() {
    let fixture = Fixture::new();
    // Normal, with usage and an open reservation.
    fixture.write(ledger(
        1800,
        7200,
        json!([{"end_ms": NOW - 1000, "used_ms": 1_800_500}]),
        json!({"request_id":ID,"started_ms":NOW,"reserved_ms":1_200_000}),
    ));
    assert_eq!(
        value(&status(&fixture.0, NOW)),
        json!({"schema_version":"1.0","availability":"available","limits":{"attempt_sec":1800,"daily_sec":7200,"concurrency":1},"usage":{"used_sec":1801,"open_sec":1200,"remaining_sec":4199,"window_seconds":86400},"effective":{"max_sec":1200,"startable":true,"reason":null},"paid_mode":"disabled"})
    );
    // Remaining time narrows max_sec below the task ceiling.
    fixture.write(ledger(
        1800,
        7200,
        json!([{"end_ms": NOW - 1000, "used_ms": 6_600_000}]),
        Value::Null,
    ));
    assert_eq!(
        value(&status(&fixture.0, NOW)),
        json!({"schema_version":"1.0","availability":"available","limits":{"attempt_sec":1800,"daily_sec":7200,"concurrency":1},"usage":{"used_sec":6600,"open_sec":0,"remaining_sec":600,"window_seconds":86400},"effective":{"max_sec":600,"startable":true,"reason":null},"paid_mode":"disabled"})
    );
    // Exhausted: under a minute left, remaining never negative.
    fixture.write(ledger(
        1800,
        7200,
        json!([{"end_ms": NOW - 1000, "used_ms": 7_150_000}]),
        json!({"request_id":ID,"started_ms":NOW,"reserved_ms":86_400_000}),
    ));
    assert_eq!(
        value(&status(&fixture.0, NOW)),
        json!({"schema_version":"1.0","availability":"available","limits":{"attempt_sec":1800,"daily_sec":7200,"concurrency":1},"usage":{"used_sec":7150,"open_sec":86400,"remaining_sec":0,"window_seconds":86400},"effective":{"max_sec":0,"startable":false,"reason":"local_budget_exhausted"},"paid_mode":"disabled"})
    );
    // Usage seconds are clamped to the contract's 0..=172800.
    fixture.write(ledger(
        60,
        60,
        json!(vec![json!({"end_ms": NOW, "used_ms": MAX_USED_MS}); 256]),
        Value::Null,
    ));
    let clamped = value(&status(&fixture.0, NOW));
    assert_eq!(clamped["usage"]["used_sec"], 172_800);
    assert_eq!(clamped["usage"]["remaining_sec"], 0);
    // Fail closed: exactly the fixed shape.
    fs::write(fixture.file(), "garbage").unwrap();
    assert_eq!(
        value(&status(&fixture.0, NOW)),
        json!({"schema_version":"1.0","availability":"available","limits":{"attempt_sec":1800,"daily_sec":7200,"concurrency":1},"usage":{"used_sec":0,"open_sec":0,"remaining_sec":0,"window_seconds":86400},"effective":{"max_sec":0,"startable":false,"reason":"local_budget_unavailable"},"paid_mode":"disabled"})
    );
    assert!(serde_json::to_vec(&Status::fail_closed()).unwrap().len() <= 1024);
    // The save reply echoes the saved caps.
    let saved = save(&fixture.0, 900, 2700, NOW).unwrap();
    assert_eq!(
        value(&saved),
        json!({"schema_version":"1.0","availability":"available","limits":{"attempt_sec":900,"daily_sec":2700,"concurrency":1},"usage":{"used_sec":0,"open_sec":0,"remaining_sec":2700,"window_seconds":86400},"effective":{"max_sec":900,"startable":true,"reason":null},"paid_mode":"disabled"})
    );
}

#[test]
fn preflight_accepts_only_exact_integer_requests() {
    let good = json!({"request":{"schema_version":"1.0","attempt_sec":1800,"daily_sec":7200}});
    assert!(preflight(&good, Shape::Save));
    assert!(preflight(&json!({}), Shape::Status));
    assert!(!preflight(&json!({"a":1}), Shape::Status));
    assert!(!preflight(&json!(null), Shape::Status));
    let request = |patch: Value| {
        let mut body = good.clone();
        for (key, item) in patch.as_object().unwrap() {
            if item.is_null() {
                body["request"].as_object_mut().unwrap().remove(key);
            } else {
                body["request"][key] = item.clone();
            }
        }
        body
    };
    for patch in [
        json!({"schema_version":"2.0"}),
        json!({"schema_version":null}),
        json!({"attempt_sec":null}),
        json!({"daily_sec":null}),
        json!({"attempt_sec":59}),
        json!({"attempt_sec":7201}),
        json!({"daily_sec":86_401}),
        json!({"attempt_sec":"1800"}),
        json!({"attempt_sec":1800.5}),
        json!({"attempt_sec":-60}),
        json!({"model":"opus"}),
        json!({"path":"PRIVATE"}),
    ] {
        assert!(!preflight(&request(patch.clone()), Shape::Save), "{patch}");
    }
    assert!(!preflight(&json!({"request":good,"extra":1}), Shape::Save));
    assert!(!preflight(&good["request"], Shape::Save));
}

#[test]
fn main_only_acl_and_wrappers_serve_the_commands() {
    let mut context = crate::application_context();
    let fixture = Fixture::new();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(fixture.0.clone()),
    );
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            local_run_limits_status,
            local_run_limits_save
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
    let status_body = json!({});
    let save_body = json!({"request":{"schema_version":"1.0","attempt_sec":600,"daily_sec":3600}});
    let seen = invoke(
        &main,
        local,
        "local_run_limits_status",
        InvokeBody::Json(status_body.clone()),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(seen["effective"]["max_sec"], 1200);
    assert_eq!(seen["limits"]["attempt_sec"], 1800);
    // Reading creates nothing.
    assert!(fixture.names().is_empty());
    let saved = invoke(
        &main,
        local,
        "local_run_limits_save",
        InvokeBody::Json(save_body.clone()),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(
        saved["limits"],
        json!({"attempt_sec":600,"daily_sec":3600,"concurrency":1})
    );
    assert_eq!(saved["effective"]["max_sec"], 600);
    assert_eq!(fixture.ledger()["attempt_sec"], 600);
    for (command, body) in [
        ("local_run_limits_status", status_body),
        ("local_run_limits_save", save_body),
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
    for request in [
        json!({"schema_version":"1.0","attempt_sec":59,"daily_sec":3600}),
        json!({"schema_version":"1.0","attempt_sec":3601,"daily_sec":3600}),
        json!({"schema_version":"1.0","attempt_sec":600,"daily_sec":3600,"path":"x"}),
        json!({"schema_version":"1.0","attempt_sec":600.0,"daily_sec":3600.5}),
    ] {
        assert_eq!(
            invoke(
                &main,
                local,
                "local_run_limits_save",
                InvokeBody::Json(json!({"request":request}))
            )
            .unwrap_err(),
            json!(DENIED)
        );
    }
    assert_eq!(fixture.ledger()["attempt_sec"], 600);
}
