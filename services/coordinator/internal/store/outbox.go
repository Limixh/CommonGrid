package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

type Event struct {
	Sequence    int64           `json:"sequence"`
	ID          string          `json:"event_id"`
	AggregateID string          `json:"aggregate_id"`
	Kind        string          `json:"kind"`
	EntityID    *string         `json:"entity_id,omitempty"`
	Payload     json.RawMessage `json:"payload"`
	ClaimToken  string          `json:"-"`
	ClaimUntil  time.Time       `json:"-"`
	Attempts    int             `json:"attempts"`
}

func emit(ctx context.Context, tx pgx.Tx, kind string, lease Lease) error {
	payload, err := json.Marshal(struct {
		SchemaVersion string `json:"schema_version"`
		Lease         Lease  `json:"lease"`
	}{"1.0", lease})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO outbox(event_id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4::jsonb)", newID("event-"), lease.ID, kind, string(payload))
	return err
}

// At most one event per aggregate is in flight. A stalled aggregate does not
// block unrelated leases. Expired claims are replayed with the SAME event ID.
func (s *Store) Claim(ctx context.Context, limit int, ttl time.Duration) ([]Event, error) {
	if limit < 1 || limit > 100 || ttl < time.Millisecond || ttl > 5*time.Minute {
		return nil, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `WITH selected AS (
        SELECT o.sequence FROM outbox o WHERE o.delivered_at IS NULL
          AND o.available_at<=clock_timestamp() AND (o.claim_until IS NULL OR o.claim_until<=clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM outbox prior WHERE prior.aggregate_id=o.aggregate_id
              AND prior.sequence<o.sequence AND prior.delivered_at IS NULL)
        ORDER BY o.sequence LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE outbox o SET claim_token=$2,claim_until=clock_timestamp()+$3*interval '1 millisecond',attempts=o.attempts+1
      FROM selected s WHERE o.sequence=s.sequence
      RETURNING o.sequence,o.event_id,o.aggregate_id,o.kind,o.entity_id,o.payload,o.claim_token,o.claim_until,o.attempts`, limit, newID("claim-"), ttl.Milliseconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var event Event
		if err = rows.Scan(&event.Sequence, &event.ID, &event.AggregateID, &event.Kind, &event.EntityID, &event.Payload, &event.ClaimToken, &event.ClaimUntil, &event.Attempts); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) Ack(ctx context.Context, event Event) error {
	result, err := s.pool.Exec(ctx, `UPDATE outbox SET delivered_at=clock_timestamp(),claim_token=NULL,claim_until=NULL,last_error_code=NULL
        WHERE event_id=$1 AND claim_token=$2 AND claim_until>clock_timestamp() AND delivered_at IS NULL`, event.ID, event.ClaimToken)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrClaimLost
	}
	return nil
}

func (s *Store) Nack(ctx context.Context, event Event, delay time.Duration) error {
	if delay < 0 || delay > time.Hour {
		return ErrInvalid
	}
	result, err := s.pool.Exec(ctx, `UPDATE outbox SET claim_token=NULL,claim_until=NULL,available_at=clock_timestamp()+$3*interval '1 millisecond',last_error_code='delivery_failed'
        WHERE event_id=$1 AND claim_token=$2 AND claim_until>clock_timestamp() AND delivered_at IS NULL`, event.ID, event.ClaimToken, delay.Milliseconds())
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrClaimLost
	}
	return nil
}
