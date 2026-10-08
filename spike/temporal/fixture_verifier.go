package attempt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
)

// FixtureVerifier uses a local marker to demonstrate retry after an effect.
// This is not a production ledger: PostgreSQL transaction/unique constraints
// and job reconciliation are required for real verification and point awards.
type FixtureVerifier struct {
	Dir string
	mu  sync.Mutex
}

func (v *FixtureVerifier) Verify(ctx context.Context, request VerificationRequest) (Verification, error) {
	if !identifier.MatchString(request.LeaseID) || !identifier.MatchString(request.ArtifactID) || !digest.MatchString(request.ContractHash) || !digest.MatchString(request.IdempotencyKey) {
		return Verification{}, temporal.NewNonRetryableApplicationError("invalid fixture request", "invalid_input", nil)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := os.MkdirAll(v.Dir, 0700); err != nil {
		return Verification{}, err
	}
	marker := filepath.Join(v.Dir, request.IdempotencyKey+".json")
	existing, err := os.ReadFile(marker)
	if err == nil {
		var recorded VerificationRequest
		if json.Unmarshal(existing, &recorded) != nil || recorded != request {
			return Verification{}, temporal.NewNonRetryableApplicationError("fixture ledger mismatch", "ledger_mismatch", nil)
		}
		return Verification{FixtureOnly: true, Reused: true, ActivityAttempt: activity.GetInfo(ctx).Attempt}, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Verification{}, err
	}
	data, err := json.Marshal(request)
	if err != nil {
		return Verification{}, err
	}
	file, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return Verification{}, err
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return Verification{}, err
	}
	// Deliberate transport failure AFTER the fixture effect was recorded.
	// The next attempt must reuse the same key and must not create a second marker.
	return Verification{}, fmt.Errorf("injected failure after fixture effect")
}
