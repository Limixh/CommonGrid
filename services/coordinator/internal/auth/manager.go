package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"commongrid/coordinator/internal/store"
)

var (
	ErrUnauthenticated = errors.New("authentication required")
	ErrForbidden       = errors.New("request forbidden")
	ErrUnavailable     = errors.New("authentication unavailable")
	ErrConfiguration   = errors.New("invalid authentication configuration")
)

const flowTTL = 10 * time.Minute
const sessionTTL = 24 * time.Hour

type Repository interface {
	SaveOAuthFlow(context.Context, store.OAuthFlow) error
	ConsumeOAuthFlow(context.Context, string, string, string) (store.OAuthFlow, error)
	LoginIdentity(context.Context, store.ExternalIdentity, string, string, string, time.Duration) (store.AuthSession, error)
	AuthSession(context.Context, string) (store.AuthSession, error)
	RevokeAuthSession(context.Context, string) error
}

type Config struct {
	PublicURL   string
	UIOrigin    string
	Development bool
	Providers   map[string]Provider
}

type ProviderInfo struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

type Manager struct {
	repo          Repository
	publicURL     string
	uiOrigin      string
	development   bool
	providers     map[string]Provider
	sessionCookie string
	browserCookie string
}

func origin(raw string, development bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" {
		return "", ErrConfiguration
	}
	if u.Scheme != "https" {
		if u.Scheme != "http" || !development {
			return "", ErrConfiguration
		}
		host := u.Hostname()
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return "", ErrConfiguration
		}
	}
	if u.Port() != "" {
		// Parse validates malformed ports, and numeric range is checked here.
		if _, err := net.LookupPort("tcp", u.Port()); err != nil {
			return "", ErrConfiguration
		}
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}

func NewManager(repo Repository, config Config) (*Manager, error) {
	if repo == nil {
		return nil, ErrConfiguration
	}
	publicURL, err := origin(config.PublicURL, config.Development)
	if err != nil {
		return nil, err
	}
	uiOrigin, err := origin(config.UIOrigin, config.Development)
	if err != nil {
		return nil, err
	}
	publicEndpoint, _ := url.Parse(publicURL)
	uiEndpoint, _ := url.Parse(uiOrigin)
	// Host-only cookies and the UI's relative /api proxy require the same
	// scheme and hostname. A local development proxy may use another port.
	if publicEndpoint.Scheme != uiEndpoint.Scheme || publicEndpoint.Hostname() != uiEndpoint.Hostname() ||
		(publicEndpoint.Port() != uiEndpoint.Port() && (!config.Development || !loopbackHostname(publicEndpoint.Hostname()))) {
		return nil, ErrConfiguration
	}
	providers := make(map[string]Provider, len(config.Providers))
	for name, provider := range config.Providers {
		if (name != "github" && name != "google") || provider == nil {
			return nil, ErrConfiguration
		}
		providers[name] = provider
	}
	m := &Manager{repo: repo, publicURL: publicURL, uiOrigin: uiOrigin, development: config.Development,
		providers: providers, sessionCookie: "__Host-cg_session", browserCookie: "__Host-cg_browser"}
	if config.Development {
		m.sessionCookie = "cg_session"
		m.browserCookie = "cg_browser"
	}
	return m, nil
}

func loopbackHostname(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// ValidateBoundary ensures the HTTP perimeter and auth cookies use one origin policy.
func (m *Manager) ValidateBoundary(publicURL, uiOrigin string, development bool) error {
	p, err := origin(publicURL, development)
	if err != nil {
		return err
	}
	u, err := origin(uiOrigin, development)
	if err != nil || p != m.publicURL || u != m.uiOrigin || development != m.development {
		return ErrConfiguration
	}
	return nil
}

func (m *Manager) Providers() []ProviderInfo {
	return []ProviderInfo{{ID: "github", Enabled: m.providers["github"] != nil}, {ID: "google", Enabled: m.providers["google"] != nil}}
}

func randomToken() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func validToken(raw string) bool {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	return err == nil && len(raw) == 43 && len(decoded) == 32
}

// validateRequest rejects ambiguous credentials before any database operation.
func validateRequest(r *http.Request) error {
	if len(r.Header.Values("Authorization")) != 0 || len(r.Header.Values("Cookie")) > 1 {
		return ErrForbidden
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return ErrForbidden
	}
	for key, values := range query {
		if len(values) != 1 {
			return ErrForbidden
		}
		switch strings.ToLower(key) {
		case "access_token", "id_token", "session", "session_token", "csrf_token", "token":
			return ErrForbidden
		}
	}
	names := make(map[string]bool)
	for _, line := range r.Header.Values("Cookie") {
		for _, part := range strings.Split(line, ";") {
			name, _, ok := strings.Cut(strings.TrimSpace(part), "=")
			if !ok || name == "" || names[name] {
				return ErrForbidden
			}
			names[name] = true
		}
	}
	return nil
}

func (m *Manager) cookie(r *http.Request, name string) (string, error) {
	if err := validateRequest(r); err != nil {
		return "", err
	}
	cookie, err := r.Cookie(name)
	if err == http.ErrNoCookie {
		return "", nil
	}
	if err != nil || !validToken(cookie.Value) {
		return "", ErrForbidden
	}
	return cookie.Value, nil
}

func (m *Manager) Authenticate(r *http.Request) (store.AuthSession, error) {
	raw, err := m.cookie(r, m.sessionCookie)
	if err != nil {
		return store.AuthSession{}, ErrForbidden
	}
	if raw == "" {
		return store.AuthSession{}, ErrUnauthenticated
	}
	session, err := m.repo.AuthSession(r.Context(), hashToken(raw))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return store.AuthSession{}, ErrUnavailable
	}
	if err != nil || session.UserID == "" || !session.ExpiresAt.After(time.Now()) {
		return store.AuthSession{}, ErrUnauthenticated
	}
	return session, nil
}

func (m *Manager) CheckCSRF(r *http.Request, session store.AuthSession) error {
	if validateRequest(r) != nil || len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != m.uiOrigin || len(r.Header.Values("X-CSRF-Token")) != 1 {
		return ErrForbidden
	}
	token := r.Header.Get("X-CSRF-Token")
	if !validToken(token) || !validToken(session.CSRFToken) || subtle.ConstantTimeCompare([]byte(token), []byte(session.CSRFToken)) != 1 {
		return ErrForbidden
	}
	return nil
}

func (m *Manager) setCookie(w http.ResponseWriter, name, value string, ttl time.Duration) {
	maxAge := int(ttl / time.Second)
	expires := time.Now().Add(ttl)
	if ttl < 0 {
		maxAge = -1
		expires = time.Unix(1, 0)
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true,
		Secure: strings.HasPrefix(m.publicURL, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: maxAge, Expires: expires})
}

func privateHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func authError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": strings.ReplaceAll(code, "_", " ")}})
}

func (m *Manager) Mount(mux *http.ServeMux) {
	wrap := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			privateHeaders(w)
			// Go's GET patterns also match HEAD; login callbacks must never
			// exchange a code or create an account for a HEAD request.
			if r.Method != http.MethodGet && r.Method != http.MethodPost {
				authError(w, 405, "method_not_allowed")
				return
			}
			if validateRequest(r) != nil {
				authError(w, 400, "invalid_request")
				return
			}
			handler(w, r)
		}
	}
	mux.HandleFunc("GET /api/v1/auth/providers", wrap(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			authError(w, 400, "invalid_request")
			return
		}
		writeJSON(w, 200, map[string]any{"providers": m.Providers()})
	}))
	mux.HandleFunc("GET /api/v1/auth/session", wrap(m.session))
	mux.HandleFunc("GET /api/v1/auth/{provider}/start", wrap(m.start))
	mux.HandleFunc("GET /api/v1/auth/{provider}/callback", wrap(m.callback))
	mux.HandleFunc("POST /api/v1/auth/logout", wrap(m.logout))
}

func (m *Manager) session(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		authError(w, 400, "invalid_request")
		return
	}
	session, err := m.Authenticate(r)
	if errors.Is(err, ErrForbidden) {
		authError(w, 403, "invalid_credentials")
		return
	}
	if errors.Is(err, ErrUnavailable) {
		authError(w, 503, "authentication_unavailable")
		return
	}
	if err != nil {
		writeJSON(w, 200, map[string]bool{"authenticated": false})
		return
	}
	writeJSON(w, 200, map[string]any{"authenticated": true, "user": map[string]string{"id": session.UserID, "display_name": session.DisplayName, "provider": session.Provider}, "csrf_token": session.CSRFToken, "expires_at": session.ExpiresAt})
}

func (m *Manager) start(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("provider")
	provider := m.providers[name]
	if provider == nil {
		authError(w, 404, "provider_unavailable")
		return
	}
	if r.URL.RawQuery != "" || len(r.Header.Values("Origin")) > 1 || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != m.uiOrigin) {
		authError(w, 400, "invalid_request")
		return
	}
	browser, err := m.cookie(r, m.browserCookie)
	if err != nil {
		authError(w, 400, "invalid_request")
		return
	}
	if browser == "" {
		browser, err = randomToken()
	}
	if err != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	state, err := randomToken()
	if err != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	verifier, err := randomToken()
	if err != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	nonce, err := randomToken()
	if err != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	flow := store.OAuthFlow{Provider: name, StateHash: hashToken(state), BrowserHash: hashToken(browser), Verifier: verifier, Nonce: nonce, ExpiresAt: time.Now().Add(flowTTL)}
	if m.repo.SaveOAuthFlow(r.Context(), flow) != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	m.setCookie(w, m.browserCookie, browser, flowTTL)
	http.Redirect(w, r, provider.AuthorizationURL(state, verifier, nonce, m.publicURL+"/api/v1/auth/"+name+"/callback"), http.StatusFound)
}

func (m *Manager) callback(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("provider")
	provider := m.providers[name]
	if provider == nil {
		authError(w, 404, "provider_unavailable")
		return
	}
	query := r.URL.Query()
	state := query.Get("state")
	browser, err := m.cookie(r, m.browserCookie)
	if err != nil || browser == "" || !validToken(state) {
		authError(w, 400, "invalid_oauth_flow")
		return
	}
	previous, err := m.cookie(r, m.sessionCookie)
	if err != nil {
		authError(w, 400, "invalid_request")
		return
	}
	flow, err := m.repo.ConsumeOAuthFlow(r.Context(), name, hashToken(state), hashToken(browser))
	if err != nil || flow.Provider != name || flow.StateHash != hashToken(state) || flow.BrowserHash != hashToken(browser) || !flow.ExpiresAt.After(time.Now()) {
		authError(w, 400, "invalid_oauth_flow")
		return
	}
	code := query.Get("code")
	if query.Get("error") != "" || code == "" || len(code) > 4096 {
		authError(w, 400, "oauth_failed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	identity, err := provider.Exchange(ctx, code, flow.Verifier, flow.Nonce, m.publicURL+"/api/v1/auth/"+name+"/callback")
	if err != nil || identity.Provider != name || !validSubject(identity.Subject) {
		authError(w, 502, "provider_unavailable")
		return
	}
	raw, err := randomToken()
	if err != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	csrf, err := randomToken()
	if err != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	previousHash := ""
	if previous != "" {
		previousHash = hashToken(previous)
	}
	if _, err = m.repo.LoginIdentity(ctx, identity, hashToken(raw), csrf, previousHash, sessionTTL); err != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	m.setCookie(w, m.sessionCookie, raw, sessionTTL)
	http.Redirect(w, r, m.uiOrigin+"/", http.StatusSeeOther)
}

func (m *Manager) logout(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		authError(w, 400, "invalid_request")
		return
	}
	session, err := m.Authenticate(r)
	if errors.Is(err, ErrForbidden) {
		authError(w, 403, "invalid_credentials")
		return
	}
	if errors.Is(err, ErrUnavailable) {
		authError(w, 503, "authentication_unavailable")
		return
	}
	if err != nil {
		authError(w, 401, "authentication_required")
		return
	}
	if m.CheckCSRF(r, session) != nil {
		authError(w, 403, "request_forbidden")
		return
	}
	raw, _ := m.cookie(r, m.sessionCookie)
	if m.repo.RevokeAuthSession(r.Context(), hashToken(raw)) != nil {
		authError(w, 503, "authentication_unavailable")
		return
	}
	m.setCookie(w, m.sessionCookie, "", -time.Second)
	m.setCookie(w, m.browserCookie, "", -time.Second)
	w.WriteHeader(http.StatusNoContent)
}
