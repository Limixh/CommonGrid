package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestManagedSchemaGuard(t *testing.T) {
	for _, schema := range []string{"public", "pg_catalog", "pg_temp", "information_schema", "bad;drop", "BadSchema"} {
		if _, err := Open(context.Background(), "", schema); !errors.Is(err, ErrInvalid) {
			t.Fatalf("schema %q reached connection or DDL: %v", schema, err)
		}
	}
}

func TestCapacityAccounting(t *testing.T) {
	start := time.Unix(100, 0)
	lease := Lease{EffectiveLimitSec: 10, ReservedMs: 12000, CreatedAt: start, ExpiresAt: start.Add(12 * time.Second)}
	if spent, _ := settlement(lease, start.Add(time.Hour)); spent != 0 {
		t.Fatal("unstarted waiting lease was charged")
	}
	lease.StartedAt = &start
	for _, test := range []struct {
		elapsed        time.Duration
		spent, overrun int64
	}{
		{-time.Second, 0, 0}, {1250 * time.Millisecond, 1250, 0}, {11 * time.Second, 11000, 1000}, {time.Hour, 12000, 2000},
	} {
		spent, overrun := settlement(lease, start.Add(test.elapsed))
		if spent != test.spent || overrun != test.overrun {
			t.Fatalf("elapsed %v: got %d/%d", test.elapsed, spent, overrun)
		}
	}
	if effectiveLimit(30, 20, 10) != 10 || effectiveLimit(5, 20, 10) != 5 || effectiveLimit(30, 3, 10) != 3 {
		t.Fatal("user/project/task minimum not respected")
	}
	if worstCaseMs(86400) != 103680000 {
		t.Fatal("reservation window overflow or unit mismatch")
	}
}

func TestRequestIdentity(t *testing.T) {
	r := ReserveRequest{UserID: "u", TaskID: "t", TaskVersion: 1, ContractHash: strings.Repeat("a", 64), StrategyID: "s", RequestKey: "k", LimitSec: 10}
	if err := r.validate(); err != nil {
		t.Fatal(err)
	}
	modified := r
	modified.LimitSec = 11
	if r.fingerprint() == modified.fingerprint() {
		t.Fatal("idempotency key can be reused with a different limit")
	}
	modified = r
	modified.ContractHash = strings.Repeat("b", 64)
	if r.fingerprint() == modified.fingerprint() {
		t.Fatal("idempotency identity omits the contract")
	}
	for _, invalid := range []ReserveRequest{{}, func() ReserveRequest { x := r; x.LimitSec = 0; return x }(), func() ReserveRequest { x := r; x.LimitSec = 86401; return x }(), func() ReserveRequest { x := r; x.ContractHash = "bad"; return x }()} {
		if invalid.validate() == nil {
			t.Fatal("invalid reservation accepted")
		}
	}
}
