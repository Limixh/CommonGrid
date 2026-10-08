package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
)

var (
	ErrInvalid   = errors.New("invalid_request")
	ErrNotFound  = errors.New("not_found")
	ErrConflict  = errors.New("idempotency_conflict")
	ErrStale     = errors.New("stale_contract")
	ErrBudget    = errors.New("budget_exhausted")
	ErrCapacity  = errors.New("capacity_exhausted")
	ErrClosed    = errors.New("lease_or_task_closed")
	ErrClaimLost = errors.New("outbox_claim_lost")
	ErrInvariant = errors.New("storage_invariant_failed")
)

var validID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$`)
var validHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func newID(prefix string) string { return prefix + strings.ToLower(rand.Text()) }

type ReserveRequest struct {
	UserID       string
	TaskID       string
	TaskVersion  int64
	ContractHash string
	StrategyID   string
	RequestKey   string
	LimitSec     int64 // User's proposed local limit; server can only lower it.
}

func (r ReserveRequest) validate() error {
	if !validID.MatchString(r.UserID) || !validID.MatchString(r.TaskID) || !validID.MatchString(r.StrategyID) || !validID.MatchString(r.RequestKey) || !validHash.MatchString(r.ContractHash) || r.TaskVersion < 1 || r.LimitSec < 1 || r.LimitSec > 86400 {
		return ErrInvalid
	}
	return nil
}
func (r ReserveRequest) fingerprint() string {
	bytes, _ := json.Marshal(r)
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:])
}

type Lease struct {
	ID                string     `json:"id"`
	AttemptID         string     `json:"attempt_id"`
	UserID            string     `json:"user_id"`
	TaskID            string     `json:"task_id"`
	TaskVersion       int64      `json:"task_version"`
	ContractHash      string     `json:"contract_hash"`
	StrategyID        string     `json:"strategy_id"`
	State             string     `json:"state"`
	EffectiveLimitSec int64      `json:"effective_limit_sec"`
	ReservedMs        int64      `json:"reserved_ms"`
	SpentMs           int64      `json:"spent_ms"`
	OverrunMs         int64      `json:"overrun_ms"`
	CreatedAt         time.Time  `json:"created_at"`
	ExpiresAt         time.Time  `json:"expires_at"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	StopRequestedAt   *time.Time `json:"stop_requested_at,omitempty"`
	EndedAt           *time.Time `json:"ended_at,omitempty"`
}

func effectiveLimit(user, project, task int64) int64 { return min(user, project, task) }

// Reserve the full lease window (+20% delivery/stop allowance), conservatively.
// Only active time is settled; waiting is free. This measures scheduled capacity,
// not subscription tokens, model computation or money.
func worstCaseMs(seconds int64) int64 { return seconds * 1200 }
func settlement(lease Lease, now time.Time) (spent, overrun int64) {
	if lease.StartedAt == nil {
		return 0, 0
	}
	end := now
	if end.After(lease.ExpiresAt) {
		end = lease.ExpiresAt
	}
	spent = max(0, min(end.Sub(*lease.StartedAt).Milliseconds(), lease.ReservedMs))
	overrun = max(0, spent-lease.EffectiveLimitSec*1000)
	return spent, overrun
}
