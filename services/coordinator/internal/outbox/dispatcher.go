package outbox

import (
	"context"
	"time"

	"commongrid/coordinator/internal/store"
)

type Queue interface {
	Claim(context.Context, int, time.Duration) ([]store.Event, error)
	Ack(context.Context, store.Event) error
	Nack(context.Context, store.Event, time.Duration) error
}

// Sink must tolerate retry after delivery succeeded but its ACK was lost.
// Event.ID is the deduplication key. Delivery never authorizes CLI execution.
type Sink interface {
	Send(context.Context, store.Event) error
}

type Dispatcher struct {
	Queue    Queue
	Sink     Sink
	ClaimTTL time.Duration
}
type Stats struct {
	Claimed   int
	Delivered int
	Retried   int
}

func (d Dispatcher) Once(ctx context.Context, limit int) (Stats, error) {
	var stats Stats
	if d.Queue == nil || d.Sink == nil || d.ClaimTTL < time.Second || d.ClaimTTL > 5*time.Minute {
		return stats, store.ErrInvalid
	}
	events, err := d.Queue.Claim(ctx, limit, d.ClaimTTL)
	if err != nil {
		return stats, err
	}
	stats.Claimed = len(events)
	for _, event := range events {
		// Each send is bounded by its claim; do not deliver a batch item after
		// its fence expired while earlier items were being processed.
		deadline := event.ClaimUntil.Add(-100 * time.Millisecond)
		if !time.Now().Before(deadline) {
			return stats, store.ErrClaimLost
		}
		sendCtx, cancel := context.WithDeadline(ctx, deadline)
		err = d.Sink.Send(sendCtx, event)
		cancel()
		if err != nil {
			delay := time.Second * time.Duration(min(event.Attempts, 60))
			if err = d.Queue.Nack(ctx, event, delay); err != nil {
				return stats, err
			}
			stats.Retried++
			continue
		}
		if err = d.Queue.Ack(ctx, event); err != nil {
			return stats, err
		}
		stats.Delivered++
	}
	return stats, nil
}
