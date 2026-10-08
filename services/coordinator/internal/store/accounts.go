package store

import (
	"context"
	"regexp"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

var opaqueToken = regexp.MustCompile(`^[a-zA-Z0-9_-]{43}$`)
var pkceVerifier = regexp.MustCompile(`^[a-zA-Z0-9._~-]{43,128}$`)
var externalSubject = regexp.MustCompile(`^[!-~]{1,255}$`)

type ExternalIdentity struct {
	Provider    string
	Subject     string
	DisplayName string
}

func validProvider(provider string) bool { return provider == "github" || provider == "google" }

func (i ExternalIdentity) validate() error {
	if !validProvider(i.Provider) || !externalSubject.MatchString(i.Subject) || len(i.DisplayName) > 320 || !utf8.ValidString(i.DisplayName) {
		return ErrInvalid
	}
	for _, r := range i.DisplayName {
		if unicode.IsControl(r) {
			return ErrInvalid
		}
	}
	return nil
}

// Verifier/nonce are temporary CommonGrid login data, not AI credentials.
// Hashes bind the one-time OAuth state to its initiating browser and provider.
type OAuthFlow struct {
	Provider    string    `json:"-"`
	StateHash   string    `json:"-"`
	BrowserHash string    `json:"-"`
	Verifier    string    `json:"-"`
	Nonce       string    `json:"-"`
	ExpiresAt   time.Time `json:"-"`
}

func (s *Store) SaveOAuthFlow(ctx context.Context, flow OAuthFlow) error {
	if !validProvider(flow.Provider) || !validHash.MatchString(flow.StateHash) || !validHash.MatchString(flow.BrowserHash) || !pkceVerifier.MatchString(flow.Verifier) || !opaqueToken.MatchString(flow.Nonce) {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Bound anonymous pending state globally. Expiry cleanup and replacement
	// share a transaction so concurrent starts cannot oversubscribe the limit.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(714832005)"); err != nil {
		return err
	}
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return err
	}
	if !flow.ExpiresAt.After(now) {
		return ErrInvalid
	}
	if flow.ExpiresAt.After(now.Add(10 * time.Minute)) {
		flow.ExpiresAt = now.Add(10 * time.Minute)
	}
	if _, err = tx.Exec(ctx, "DELETE FROM oauth_flows WHERE expires_at<=$1 OR (browser_hash=$2 AND provider=$3)", now, flow.BrowserHash, flow.Provider); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM oauth_flows").Scan(&count); err != nil {
		return err
	}
	if count >= 10000 {
		return ErrCapacity
	}
	if _, err = tx.Exec(ctx, `INSERT INTO oauth_flows(state_hash,browser_hash,provider,verifier,nonce,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, flow.StateHash, flow.BrowserHash, flow.Provider, flow.Verifier, flow.Nonce, now, flow.ExpiresAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ConsumeOAuthFlow(ctx context.Context, provider, stateHash, browserHash string) (OAuthFlow, error) {
	if !validProvider(provider) || !validHash.MatchString(stateHash) || !validHash.MatchString(browserHash) {
		return OAuthFlow{}, ErrInvalid
	}
	var flow OAuthFlow
	err := s.pool.QueryRow(ctx, `DELETE FROM oauth_flows WHERE provider=$1 AND state_hash=$2 AND browser_hash=$3 AND expires_at>clock_timestamp()
        RETURNING provider,state_hash,browser_hash,verifier,nonce,expires_at`, provider, stateHash, browserHash).Scan(&flow.Provider, &flow.StateHash, &flow.BrowserHash, &flow.Verifier, &flow.Nonce, &flow.ExpiresAt)
	if err == pgx.ErrNoRows {
		err = ErrNotFound
	}
	return flow, err
}

type AuthSession struct {
	UserID      string    `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Provider    string    `json:"provider"`
	CSRFToken   string    `json:"-"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// Called only after the server verifies a provider identity. Subjects never
// merge by email/name, and the user's capacity is not raised by another login.
func (s *Store) LoginIdentity(ctx context.Context, identity ExternalIdentity, sessionHash, csrfToken, previousSessionHash string, ttl time.Duration) (AuthSession, error) {
	if err := identity.validate(); err != nil {
		return AuthSession{}, err
	}
	if !validHash.MatchString(sessionHash) || !opaqueToken.MatchString(csrfToken) || (previousSessionHash != "" && !validHash.MatchString(previousSessionHash)) || ttl < time.Second || ttl > 24*time.Hour || previousSessionHash == sessionHash {
		return AuthSession{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AuthSession{}, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,714832006))", identity.Provider+"|"+identity.Subject); err != nil {
		return AuthSession{}, err
	}
	var userID string
	err = tx.QueryRow(ctx, "SELECT user_id FROM external_identities WHERE provider=$1 AND subject=$2 FOR UPDATE", identity.Provider, identity.Subject).Scan(&userID)
	if err == pgx.ErrNoRows {
		userID = newID("user-")
		if _, err = tx.Exec(ctx, "INSERT INTO users(id,max_concurrent) VALUES($1,1)", userID); err != nil {
			return AuthSession{}, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO external_identities(provider,subject,user_id,display_name) VALUES($1,$2,$3,$4)", identity.Provider, identity.Subject, userID, identity.DisplayName); err != nil {
			return AuthSession{}, err
		}
	} else if err != nil {
		return AuthSession{}, err
	} else if _, err = tx.Exec(ctx, "UPDATE external_identities SET display_name=$3 WHERE provider=$1 AND subject=$2", identity.Provider, identity.Subject, identity.DisplayName); err != nil {
		return AuthSession{}, err
	}
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return AuthSession{}, err
	}
	if previousSessionHash != "" {
		if _, err = tx.Exec(ctx, "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE token_hash=$1", previousSessionHash, now); err != nil {
			return AuthSession{}, err
		}
	}
	session := AuthSession{UserID: userID, DisplayName: identity.DisplayName, Provider: identity.Provider, CSRFToken: csrfToken, ExpiresAt: now.Add(ttl)}
	if _, err = tx.Exec(ctx, `INSERT INTO auth_sessions(token_hash,user_id,provider,csrf_token,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`, sessionHash, session.UserID, session.Provider, session.CSRFToken, now, session.ExpiresAt); err != nil {
		return AuthSession{}, err
	}
	return session, tx.Commit(ctx)
}

func (s *Store) AuthSession(ctx context.Context, sessionHash string) (AuthSession, error) {
	if !validHash.MatchString(sessionHash) {
		return AuthSession{}, ErrInvalid
	}
	var session AuthSession
	err := s.pool.QueryRow(ctx, `SELECT a.user_id,i.display_name,a.provider,a.csrf_token,a.expires_at FROM auth_sessions a
        JOIN external_identities i ON (i.user_id,i.provider)=(a.user_id,a.provider)
        WHERE a.token_hash=$1 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()`, sessionHash).Scan(&session.UserID, &session.DisplayName, &session.Provider, &session.CSRFToken, &session.ExpiresAt)
	if err == pgx.ErrNoRows {
		err = ErrNotFound
	}
	return session, err
}

func (s *Store) RevokeAuthSession(ctx context.Context, sessionHash string) error {
	if !validHash.MatchString(sessionHash) {
		return ErrInvalid
	}
	_, err := s.pool.Exec(ctx, "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE token_hash=$1", sessionHash)
	return err
}

func listBounds(limit int, after string) error {
	if limit < 1 || limit > 100 || (after != "" && !validID.MatchString(after)) {
		return ErrInvalid
	}
	return nil
}
