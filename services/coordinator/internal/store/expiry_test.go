package store

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type expiryFixture struct {
	calls    chan int
	release  chan struct{}
	failed   bool
	canceled chan struct{}
}

func (s *expiryFixture) ExpireDue(ctx context.Context, limit int) (int, error) {
	s.calls <- limit
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > expirySweepTimeout {
		panic("unbounded expiry")
	}
	if s.failed {
		return 0, errors.New("fixture_unavailable")
	}
	select {
	case <-s.release:
		return 0, nil
	case <-ctx.Done():
		close(s.canceled)
		return 0, ctx.Err()
	}
}

func TestExpirySweeperOwnsClockCancellationAndRetriesOnTick(t *testing.T) {
	ticks := make(chan time.Time)
	repo := &expiryFixture{calls: make(chan int, 4), failed: true}
	var stopped, failed atomic.Int32
	stop := startExpirySweeper(repo, ticks, func() { stopped.Add(1) }, func() { failed.Add(1) })
	defer stop()
	select {
	case limit := <-repo.calls:
		if limit != 100 {
			t.Fatal(limit)
		}
	case <-time.After(time.Second):
		t.Fatal("missing startup sweep")
	}
	// No database retry without a supplied clock tick.
	select {
	case <-repo.calls:
		t.Fatal("expiry loop hammered database")
	default:
	}
	ticks <- time.Now()
	select {
	case <-repo.calls:
	case <-time.After(time.Second):
		t.Fatal("missing scheduled retry")
	}
	stop()
	stop()
	if stopped.Load() != 1 || failed.Load() != 2 {
		t.Fatal("clock/retry lifecycle", stopped.Load(), failed.Load())
	}

	ticks2 := make(chan time.Time)
	blocking := &expiryFixture{calls: make(chan int, 1), release: make(chan struct{}), canceled: make(chan struct{})}
	stop2 := startExpirySweeper(blocking, ticks2, func() {}, nil)
	<-blocking.calls
	stop2()
	select {
	case <-blocking.canceled:
	default:
		t.Fatal("shutdown did not cancel in-flight sweep")
	}
}
