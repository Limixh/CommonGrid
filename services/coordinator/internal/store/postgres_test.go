package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"commongrid/coordinator/internal/catalog"
	"commongrid/coordinator/internal/contract"
	"github.com/jackc/pgx/v5"
)

func databaseFixture(t *testing.T, projectBudget, rootBudget int64, cap int64) (*Store, contract.TaskContract) {
	t.Helper()
	dsn := os.Getenv("CG_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("CG_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("CG_TEST_DATABASE_URL required")
		}
		t.Skip("PostgreSQL integration: run npm run test:db")
	}
	ctx := context.Background()
	schema := newID("cg_test_")
	db, err := Open(ctx, dsn, schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !strings.HasPrefix(schema, "cg_test_") {
			t.Fatal("refusing non-test schema cleanup")
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := db.pool.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		db.Close()
	})
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err = db.CreateUser(ctx, "owner", 1); err != nil {
		t.Fatal(err)
	}
	if err = db.CreateProject(ctx, "project", "owner", projectBudget, 30); err != nil {
		t.Fatal(err)
	}
	if err = db.CreateNode(ctx, "root", "project", nil, rootBudget); err != nil {
		t.Fatal(err)
	}
	parent := "root"
	if err = db.CreateNode(ctx, "leaf", "project", &parent, projectBudget); err != nil {
		t.Fatal(err)
	}
	fixtures, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	task := fixtures.Tasks[0]
	task.Id = "task"
	task.ProjectId = "project"
	task.NodeId = "leaf"
	task.DependsOn = []string{}
	task.Parallelism = contract.Parallelism{Mode: "independent", Initial: 1, Cap: cap}
	publishTestTask(t, db, &task)
	return db, task
}
func publishTestTask(t *testing.T, db *Store, task *contract.TaskContract) {
	t.Helper()
	raw, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := contract.ComputeHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	task.ContractHash = hash
	raw, err = json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Publish(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
}
func requestFor(task contract.TaskContract, user, key string) ReserveRequest {
	return ReserveRequest{UserID: user, TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, StrategyID: task.Strategies[0].Id, RequestKey: key, LimitSec: 1}
}
func user(t *testing.T, db *Store, id string, capacity int) {
	t.Helper()
	if err := db.CreateUser(context.Background(), id, capacity); err != nil {
		t.Fatal(err)
	}
}
func counters(t *testing.T, db *Store, account string) (int64, int64) {
	t.Helper()
	var reserved, spent int64
	if err := db.pool.QueryRow(context.Background(), "SELECT reserved_ms,spent_ms FROM budget_accounts WHERE id=$1", account).Scan(&reserved, &spent); err != nil {
		t.Fatal(err)
	}
	return reserved, spent
}
func countRows(t *testing.T, db *Store, table string) int {
	t.Helper()
	if table != "leases" && table != "outbox" && table != "schema_migrations" {
		t.Fatal("invalid test table")
	}
	var n int
	if err := db.pool.QueryRow(context.Background(), "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPostgresMigrationsAndImmutability(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	if countRows(t, db, "schema_migrations") != len(entries) {
		t.Fatal("migration re-applied")
	}
	if err = db.CheckMigrations(ctx); err != nil {
		t.Fatal("read-only migration readiness", err)
	}
	if _, err := db.pool.Exec(ctx, "UPDATE task_versions SET contract=contract || '{\"prompt\":\"changed\"}'::jsonb WHERE task_id=$1", task.Id); err == nil {
		t.Fatal("immutable contract changed")
	}
	if _, err := db.pool.Exec(ctx, "UPDATE nodes SET parent_id=NULL WHERE id='leaf'"); err == nil {
		t.Fatal("budget ancestry changed")
	}
	if _, err := db.pool.Exec(ctx, "UPDATE schema_migrations SET sha256='different'"); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err == nil {
		t.Fatal("edited migration history accepted")
	}
	if err = db.CheckMigrations(ctx); !errors.Is(err, ErrInvariant) {
		t.Fatal("startup readiness accepted edited history", err)
	}
}

func TestPostgresConcurrentReservationsCannotOverspend(t *testing.T) {
	db, task := databaseFixture(t, 6000, 6000, 50)
	ctx := context.Background()
	for i := range 40 {
		user(t, db, fmt.Sprintf("user-%d", i), 1)
	}
	var wg sync.WaitGroup
	result := make(chan error, 40)
	for i := range 40 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := db.Reserve(ctx, requestFor(task, fmt.Sprintf("user-%d", i), "request"))
			result <- err
		}(i)
	}
	wg.Wait()
	close(result)
	success := 0
	for err := range result {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrBudget) {
			t.Fatal(err)
		}
	}
	if success != 5 || countRows(t, db, "leases") != 5 || countRows(t, db, "outbox") != 5 {
		t.Fatalf("expected 5 atomic reservations, got %d", success)
	}
	for _, account := range []string{"project:project", "node:root", "node:leaf"} {
		reserved, spent := counters(t, db, account)
		if reserved != 6000 || spent != 0 {
			t.Fatalf("account %s: %d/%d", account, reserved, spent)
		}
	}
}

func TestPostgresAncestorBudgetRollsBackAllScopes(t *testing.T) {
	db, task := databaseFixture(t, 100000, 1200, 50)
	ctx := context.Background()
	user(t, db, "u1", 1)
	user(t, db, "u2", 1)
	if _, err := db.Reserve(ctx, requestFor(task, "u1", "r1")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Reserve(ctx, requestFor(task, "u2", "r2")); !errors.Is(err, ErrBudget) {
		t.Fatal(err)
	}
	for _, account := range []string{"project:project", "node:root", "node:leaf"} {
		reserved, _ := counters(t, db, account)
		if reserved != 1200 {
			t.Fatal("partial reservation survived rollback", account, reserved)
		}
	}
}

func TestPostgresIdempotentReservationAndStaleContract(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	user(t, db, "u", 1)
	request := requestFor(task, "u", "same-key")
	var wg sync.WaitGroup
	results := make(chan Lease, 16)
	failures := make(chan error, 16)
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lease, err := db.Reserve(ctx, request)
			if err != nil {
				failures <- err
			} else {
				results <- lease
			}
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	id := ""
	for lease := range results {
		if id != "" && lease.ID != id {
			t.Fatal("retry created another lease")
		}
		id = lease.ID
	}
	if countRows(t, db, "leases") != 1 || countRows(t, db, "outbox") != 1 {
		t.Fatal("duplicate side effects")
	}
	changed := request
	changed.LimitSec = 2
	if _, err := db.Reserve(ctx, changed); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	changed = request
	changed.RequestKey = "stale"
	changed.ContractHash = strings.Repeat("f", 64)
	if _, err := db.Reserve(ctx, changed); !errors.Is(err, ErrStale) {
		t.Fatal(err)
	}
}

func TestPostgresTaskAndGlobalUserCapacity(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 1)
	ctx := context.Background()
	user(t, db, "u1", 1)
	user(t, db, "u2", 1)
	lease, err := db.Reserve(ctx, requestFor(task, "u1", "r1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Reserve(ctx, requestFor(task, "u2", "r2")); !errors.Is(err, ErrCapacity) {
		t.Fatal(err)
	}
	other := task
	other.Id = "other-task"
	publishTestTask(t, db, &other)
	if _, err = db.Reserve(ctx, requestFor(other, "u1", "r3")); !errors.Is(err, ErrCapacity) {
		t.Fatal("account concurrent limit bypassed", err)
	}
	if _, err = db.End(ctx, "u1", lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Reserve(ctx, requestFor(other, "u1", "r3")); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresStopKeepsReservationAndSettlementIsIdempotent(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	user(t, db, "u", 1)
	request := requestFor(task, "u", "r")
	request.LimitSec = 10
	lease, err := db.Reserve(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Start(ctx, "wrong-owner", lease.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("another user mutated lease", err)
	}
	lease, err = db.Start(ctx, "u", lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if _, err = db.RequestStop(ctx, "u", lease.ID); err != nil {
		t.Fatal(err)
	}
	reserved, spent := counters(t, db, "project:project")
	if reserved != 12000 || spent != 0 {
		t.Fatal("stop request released or charged reservation early")
	}
	ended, err := db.End(ctx, "u", lease.ID, "stopped")
	if err != nil {
		t.Fatal(err)
	}
	if ended.SpentMs <= 0 || ended.SpentMs > 12000 {
		t.Fatal("invalid server time accounting")
	}
	if _, err = db.End(ctx, "u", lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	reserved, spent = counters(t, db, "project:project")
	if reserved != 0 || spent != ended.SpentMs {
		t.Fatal("double settlement")
	}
	if countRows(t, db, "outbox") != 4 {
		t.Fatal("lifecycle event duplicated or missing")
	}
}

func TestPostgresExpiryAndLateCompletion(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	user(t, db, "waiting", 1)
	user(t, db, "active", 1)
	waiting, err := db.Reserve(ctx, requestFor(task, "waiting", "r"))
	if err != nil {
		t.Fatal(err)
	}
	active, err := db.Reserve(ctx, requestFor(task, "active", "r"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Start(ctx, "active", active.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(active.ExpiresAt) + 30*time.Millisecond)
	if _, err = db.End(ctx, "active", active.ID, "completed"); !errors.Is(err, ErrClosed) {
		t.Fatal("late completion accepted", err)
	}
	n, err := db.ExpireDue(ctx, 10)
	if err != nil || n != 2 {
		t.Fatal(n, err)
	}
	waiting, err = db.Lease(ctx, "waiting", waiting.ID)
	if err != nil || waiting.SpentMs != 0 || waiting.State != "expired" {
		t.Fatal("waiting time charged", waiting, err)
	}
	active, err = db.Lease(ctx, "active", active.ID)
	if err != nil || active.SpentMs <= 0 || active.SpentMs > active.ReservedMs {
		t.Fatal(active, err)
	}
	reserved, spent := counters(t, db, "project:project")
	if reserved != 0 || spent != active.SpentMs {
		t.Fatal("expiry settlement mismatch")
	}
}

func TestPostgresVersionUpdateRequiresEndedLeases(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	user(t, db, "u", 1)
	lease, err := db.Reserve(ctx, requestFor(task, "u", "r"))
	if err != nil {
		t.Fatal(err)
	}
	newTask := task
	newTask.TaskVersion++
	raw, _ := json.Marshal(newTask)
	newTask.ContractHash, _ = contract.ComputeHash(raw)
	raw, _ = json.Marshal(newTask)
	if err = db.Publish(ctx, raw); !errors.Is(err, ErrCapacity) {
		t.Fatal("contract changed underneath live lease", err)
	}
	if _, err = db.End(ctx, "u", lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	if err = db.Publish(ctx, raw); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Reserve(ctx, requestFor(task, "u", "old-contract")); !errors.Is(err, ErrStale) {
		t.Fatal(err)
	}
	if _, err = db.Reserve(ctx, requestFor(newTask, "u", "new-contract")); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresOutboxInsertFailureRollsBackLeaseAndBudget(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	user(t, db, "u", 1)
	if _, err := db.pool.Exec(ctx, `CREATE FUNCTION injected_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$;
        CREATE TRIGGER inject_failure BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION injected_outbox_failure()`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Reserve(ctx, requestFor(task, "u", "r")); err == nil {
		t.Fatal("injected outbox failure did not abort transaction")
	}
	if countRows(t, db, "leases") != 0 || countRows(t, db, "outbox") != 0 {
		t.Fatal("partial domain transaction")
	}
	for _, account := range []string{"project:project", "node:root", "node:leaf"} {
		reserved, spent := counters(t, db, account)
		if reserved != 0 || spent != 0 {
			t.Fatal("budget debit survived failed outbox write")
		}
	}
}

func TestPostgresOutboxReplayFencingAndPerLeaseOrder(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	user(t, db, "u", 1)
	lease, err := db.Reserve(ctx, requestFor(task, "u", "r"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Start(ctx, "u", lease.ID); err != nil {
		t.Fatal(err)
	}
	events, err := db.Claim(ctx, 10, 50*time.Millisecond)
	if err != nil || len(events) != 1 {
		t.Fatal(events, err)
	}
	old := events[0]
	if events, err = db.Claim(ctx, 10, time.Second); err != nil || len(events) != 0 {
		t.Fatal("later event overtook undelivered reservation", events, err)
	}
	// Simulate delivery succeeding, then the worker dying before ACK.
	effects := map[string]bool{old.ID: true}
	time.Sleep(time.Until(old.ClaimUntil) + 30*time.Millisecond)
	events, err = db.Claim(ctx, 10, time.Second)
	if err != nil || len(events) != 1 {
		t.Fatal(events, err)
	}
	replayed := events[0]
	if replayed.ID != old.ID || replayed.Attempts != 2 {
		t.Fatal("replay changed event identity")
	}
	effects[replayed.ID] = true
	if len(effects) != 1 {
		t.Fatal("deduplication key did not survive delivery replay")
	}
	if err = db.Ack(ctx, old); !errors.Is(err, ErrClaimLost) {
		t.Fatal("expired worker ACK accepted", err)
	}
	if err = db.Ack(ctx, replayed); err != nil {
		t.Fatal(err)
	}
	events, err = db.Claim(ctx, 10, time.Second)
	if err != nil || len(events) != 1 || events[0].Kind != "lease.started" {
		t.Fatal("next ordered event unavailable", events, err)
	}
	if err = db.Nack(ctx, events[0], 0); err != nil {
		t.Fatal(err)
	}
	retry, err := db.Claim(ctx, 10, time.Second)
	if err != nil || len(retry) != 1 || retry[0].ID != events[0].ID {
		t.Fatal("NACK changed identity", retry, err)
	}
}

func TestPostgresConcurrentOutboxClaimsAreDistinct(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 50)
	ctx := context.Background()
	for i := range 12 {
		id := fmt.Sprintf("u-%d", i)
		user(t, db, id, 1)
		if _, err := db.Reserve(ctx, requestFor(task, id, "r")); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	results := make(chan Event, 12)
	failures := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			events, err := db.Claim(ctx, 1, 10*time.Second)
			if err != nil {
				failures <- err
			} else if len(events) != 1 {
				failures <- ErrInvariant
			} else {
				results <- events[0]
			}
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for event := range results {
		if seen[event.ID] {
			t.Fatal("concurrent workers claimed same event")
		}
		seen[event.ID] = true
	}
	if len(seen) != 12 {
		t.Fatal("claim lost an event")
	}
}
