package store

import (
	"context"
	"sync"
	"time"
)

const expirySweepInterval = 30 * time.Second
const expirySweepTimeout = 5 * time.Second
const expirySweepBatch = 100

type leaseExpirer interface {
	ExpireDue(context.Context, int) (int, error)
}

// StartExpirySweeper settles due reservations without launching any worker.
// The coordinator owns the returned stop function and must call it before
// closing the database. Errors retry on the next bounded, server-owned tick.
func (s *Store) StartExpirySweeper(onError func()) func() {
	ticker := time.NewTicker(expirySweepInterval)
	return startExpirySweeper(s, ticker.C, ticker.Stop, onError)
}

// A supplied clock channel makes lifecycle and expiry behavior testable without
// speeding up the production timer or polling the database in a tight loop.
func startExpirySweeper(repo leaseExpirer, ticks <-chan time.Time, stopClock func(), onError func()) func() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer stopClock()
		sweep := func() {
			bounded, cancelSweep := context.WithTimeout(ctx, expirySweepTimeout)
			defer cancelSweep()
			if _, err := repo.ExpireDue(bounded, expirySweepBatch); err != nil && ctx.Err() == nil && onError != nil {
				onError()
			}
		}
		sweep()
		for {
			select {
			case <-ctx.Done():
				return
			case _, open := <-ticks:
				if !open {
					return
				}
				if ctx.Err() != nil {
					return
				}
				sweep()
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(cancel); <-done }
}
