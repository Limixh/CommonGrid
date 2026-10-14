package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

type observedExpirer struct {
	repo      *Store
	completed chan error
}

func (s observedExpirer) ExpireDue(ctx context.Context, limit int) (int, error) {
	_, err := s.repo.ExpireDue(ctx, limit)
	s.completed <- err
	return 0, err
}

func TestPostgresExecutionExpiryReleasesOrphanWithoutResurrectingReplay(t *testing.T) {
	db, task := databaseFixture(t, 100000, 100000, 2)
	ctx := context.Background()
	user(t, db, "worker", 1)
	request := requestFor(task, "worker", "lost-reserve-response")
	request.LimitSec = 30
	orphan, err := db.Reserve(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	second := request
	second.RequestKey = "next-reservation"
	if _, err = db.Reserve(ctx, second); !errors.Is(err, ErrCapacity) {
		t.Fatal("orphan did not hold capacity", err)
	}
	ticks := make(chan time.Time)
	completed := make(chan error, 2)
	stop := startExpirySweeper(observedExpirer{db, completed}, ticks, func() {}, nil)
	defer stop()
	if err = <-completed; err != nil {
		t.Fatal(err)
	}
	// Advance only this test lease to the server's current clock. The production
	// sweeper retains its normal 30-second cadence; no sleep or model call.
	if _, err = db.pool.Exec(ctx, "UPDATE leases SET expires_at=clock_timestamp() WHERE id=$1", orphan.ID); err != nil {
		t.Fatal(err)
	}
	ticks <- time.Now()
	if err = <-completed; err != nil {
		t.Fatal(err)
	}
	expired, err := db.Lease(ctx, "worker", orphan.ID)
	if err != nil || expired.State != "expired" || expired.EndedAt == nil || expired.SpentMs != 0 {
		t.Fatal("orphan not settled", expired, err)
	}
	for _, account := range []string{"project:project", "node:root", "node:leaf"} {
		reserved, spent := counters(t, db, account)
		if reserved != 0 || spent != 0 {
			t.Fatal("orphan budget leaked", account, reserved, spent)
		}
	}
	replayed, err := db.Reserve(ctx, request)
	if err != nil || replayed.ID != orphan.ID || replayed.State != "expired" {
		t.Fatal("reserve replay resurrected orphan", replayed, err)
	}
	if _, err = db.Start(ctx, "worker", orphan.ID); !errors.Is(err, ErrClosed) {
		t.Fatal("expired replay started", err)
	}
	newLease, err := db.Reserve(ctx, second)
	if err != nil || newLease.ID == orphan.ID || newLease.State != "reserved" {
		t.Fatal("released slot unusable", newLease, err)
	}
	if _, err = db.End(ctx, "worker", newLease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
}
