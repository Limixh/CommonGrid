package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPostgresHeartbeatCannotRenewExpiryOrChangeAccounting(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 2)
	ctx := context.Background()
	user(t, db, "worker", 1)
	request := requestFor(task, "worker", "heartbeat-lease")
	request.LimitSec = 3
	lease, err := db.Reserve(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Heartbeat(ctx, "worker", lease.ID); !errors.Is(err, ErrClosed) {
		t.Fatal("reserved heartbeat accepted", err)
	}
	lease, err = db.Start(ctx, "worker", lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	reserved, spent := counters(t, db, "project:project")
	events := countRows(t, db, "outbox")
	heartbeat, err := db.Heartbeat(ctx, "worker", lease.ID)
	if err != nil || !heartbeat.ExpiresAt.Equal(lease.ExpiresAt) || heartbeat.ReservedMs != lease.ReservedMs || !heartbeat.StartedAt.Equal(*lease.StartedAt) {
		t.Fatal("heartbeat changed lease", heartbeat, err)
	}
	afterReserved, afterSpent := counters(t, db, "project:project")
	if afterReserved != reserved || afterSpent != spent || countRows(t, db, "outbox") != events {
		t.Fatal("heartbeat changed budget or emitted mutation")
	}
	if _, err = db.Heartbeat(ctx, "owner", lease.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("non-owner heartbeat accepted", err)
	}
	// The authoritative server lease lasts only 3.6 seconds in this fixture.
	// A start retry after expiry must not report an active execution capability.
	time.Sleep(max(0, time.Until(lease.ExpiresAt)) + 10*time.Millisecond)
	if _, err = db.Start(ctx, "worker", lease.ID); !errors.Is(err, ErrClosed) {
		t.Fatal("expired active start retry accepted", err)
	}
	if _, err = db.Heartbeat(ctx, "worker", lease.ID); !errors.Is(err, ErrClosed) {
		t.Fatal("heartbeat renewed expired lease", err)
	}
	if _, err = db.End(ctx, "worker", lease.ID, "expired"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Heartbeat(ctx, "worker", lease.ID); !errors.Is(err, ErrClosed) {
		t.Fatal("ended heartbeat accepted", err)
	}
	remaining, _ := counters(t, db, "project:project")
	if remaining != 0 {
		t.Fatal("expiry did not release reservation", remaining)
	}
}
