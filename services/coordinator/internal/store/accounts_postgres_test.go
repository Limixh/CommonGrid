package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func authIdentity(provider, subject string) ExternalIdentity {
	return ExternalIdentity{Provider: provider, Subject: subject, DisplayName: "Same public name"}
}

func TestPostgresIdentityStableSubjectAndNoNameLinking(t *testing.T) {
	db, _ := databaseFixture(t, 1000000, 1000000, 2)
	ctx := context.Background()
	identity := authIdentity("github", "123")
	first, err := db.LoginIdentity(ctx, identity, strings.Repeat("a", 64), strings.Repeat("A", 43), "", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.pool.Exec(ctx, "UPDATE users SET max_concurrent=4 WHERE id=$1", first.UserID); err != nil {
		t.Fatal(err)
	}
	identity.DisplayName = "Changed display name"
	second, err := db.LoginIdentity(ctx, identity, strings.Repeat("b", 64), strings.Repeat("B", 43), "", time.Hour)
	if err != nil || first.UserID != second.UserID {
		t.Fatal("stable subject changed user", err)
	}
	var capacity int
	if err = db.pool.QueryRow(ctx, "SELECT max_concurrent FROM users WHERE id=$1", first.UserID).Scan(&capacity); err != nil || capacity != 4 {
		t.Fatal("login rewrote capacity", capacity, err)
	}
	otherProvider, err := db.LoginIdentity(ctx, authIdentity("google", "123"), strings.Repeat("c", 64), strings.Repeat("C", 43), "", time.Hour)
	if err != nil || otherProvider.UserID == first.UserID {
		t.Fatal("provider collision linked users", err)
	}
	otherSubject, err := db.LoginIdentity(ctx, authIdentity("github", "456"), strings.Repeat("d", 64), strings.Repeat("D", 43), "", time.Hour)
	if err != nil || otherSubject.UserID == first.UserID {
		t.Fatal("name collision linked users", err)
	}
	if _, err = db.pool.Exec(ctx, "UPDATE external_identities SET user_id='owner' WHERE provider='github' AND subject='123'"); err == nil {
		t.Fatal("identity can be rebound")
	}
}

func TestPostgresIdentityConcurrentFirstLoginCreatesOneUser(t *testing.T) {
	db, _ := databaseFixture(t, 1000000, 1000000, 2)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make(chan AuthSession, 8)
	errorsCh := make(chan error, 8)
	for index := range 8 {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			session, err := db.LoginIdentity(ctx, authIdentity("github", "concurrent"), fmt.Sprintf("%064x", index+100), strings.Repeat("S", 43), "", time.Hour)
			results <- session
			errorsCh <- err
		}(index)
	}
	wg.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	var userID string
	for session := range results {
		if userID == "" {
			userID = session.UserID
		}
		if session.UserID != userID {
			t.Fatal("racing login created duplicate account")
		}
	}
}

func TestPostgresAuthSessionRotationExpiryAndRollback(t *testing.T) {
	db, _ := databaseFixture(t, 1000000, 1000000, 2)
	ctx := context.Background()
	identity := authIdentity("github", "session-user")
	oldHash, newHash := strings.Repeat("a", 64), strings.Repeat("b", 64)
	if _, err := db.LoginIdentity(ctx, identity, oldHash, strings.Repeat("A", 43), "", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := db.LoginIdentity(ctx, identity, newHash, strings.Repeat("B", 43), oldHash, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := db.AuthSession(ctx, oldHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("old session survived successful rotation", err)
	}
	session, err := db.AuthSession(ctx, newHash)
	if err != nil || session.CSRFToken != strings.Repeat("B", 43) {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(session)
	if strings.Contains(string(encoded), session.CSRFToken) || strings.Contains(string(encoded), newHash) {
		t.Fatal("session credential serialized")
	}
	// Duplicate new token aborts the transaction, including previous revocation.
	if _, err = db.LoginIdentity(ctx, identity, oldHash, strings.Repeat("C", 43), newHash, time.Hour); err == nil {
		t.Fatal("duplicate token accepted")
	}
	if _, err = db.AuthSession(ctx, newHash); err != nil {
		t.Fatal("failed login revoked valid session", err)
	}
	if _, err = db.pool.Exec(ctx, `UPDATE auth_sessions SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=$1`, newHash); err != nil {
		t.Fatal(err)
	}
	if _, err = db.AuthSession(ctx, newHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired session authenticated", err)
	}
	if err = db.RevokeAuthSession(ctx, newHash); err != nil {
		t.Fatal(err)
	}
	if err = db.RevokeAuthSession(ctx, newHash); err != nil {
		t.Fatal("logout is not idempotent", err)
	}
}

func TestPostgresOAuthFlowBrowserProviderFenceAndSingleUse(t *testing.T) {
	db, _ := databaseFixture(t, 1000000, 1000000, 2)
	ctx := context.Background()
	flow := OAuthFlow{Provider: "github", StateHash: strings.Repeat("a", 64), BrowserHash: strings.Repeat("b", 64), Verifier: strings.Repeat("V", 43), Nonce: strings.Repeat("N", 43), ExpiresAt: time.Now().Add(10 * time.Minute)}
	if err := db.SaveOAuthFlow(ctx, flow); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ConsumeOAuthFlow(ctx, "google", flow.StateHash, flow.BrowserHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("provider mixup consumed flow", err)
	}
	if _, err := db.ConsumeOAuthFlow(ctx, flow.Provider, flow.StateHash, strings.Repeat("c", 64)); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign browser consumed flow", err)
	}
	var wg sync.WaitGroup
	errorsCh := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := db.ConsumeOAuthFlow(ctx, flow.Provider, flow.StateHash, flow.BrowserHash)
			errorsCh <- err
		}()
	}
	wg.Wait()
	close(errorsCh)
	success := 0
	for err := range errorsCh {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal("flow replay won", success)
	}
}

func TestPostgresOAuthFlowReplacementAndExpiry(t *testing.T) {
	db, _ := databaseFixture(t, 1000000, 1000000, 2)
	ctx := context.Background()
	flow := OAuthFlow{Provider: "google", StateHash: strings.Repeat("a", 64), BrowserHash: strings.Repeat("b", 64), Verifier: strings.Repeat("V", 43), Nonce: strings.Repeat("N", 43), ExpiresAt: time.Now().Add(time.Hour)}
	if err := db.SaveOAuthFlow(ctx, flow); err != nil {
		t.Fatal(err)
	}
	first := flow
	flow.StateHash = strings.Repeat("c", 64)
	if err := db.SaveOAuthFlow(ctx, flow); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ConsumeOAuthFlow(ctx, first.Provider, first.StateHash, first.BrowserHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("superseded state consumed", err)
	}
	var duration float64
	if err := db.pool.QueryRow(ctx, "SELECT extract(epoch FROM expires_at-created_at) FROM oauth_flows WHERE state_hash=$1", flow.StateHash).Scan(&duration); err != nil || duration > 600 {
		t.Fatal("flow deadline widened", duration, err)
	}
	if _, err := db.pool.Exec(ctx, "UPDATE oauth_flows SET created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '15 minutes' WHERE state_hash=$1", flow.StateHash); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ConsumeOAuthFlow(ctx, flow.Provider, flow.StateHash, flow.BrowserHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired flow consumed", err)
	}
}
