package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"commongrid/coordinator/internal/store"
)

type mockRepo struct {
	flows        map[string]store.OAuthFlow
	sessions     map[string]store.AuthSession
	logins       int
	lastPrevious string
	sessionError error
}

func newMockRepo() *mockRepo {
	return &mockRepo{flows: map[string]store.OAuthFlow{}, sessions: map[string]store.AuthSession{}}
}
func (m *mockRepo) SaveOAuthFlow(_ context.Context, flow store.OAuthFlow) error {
	for key, old := range m.flows {
		if old.Provider == flow.Provider && old.BrowserHash == flow.BrowserHash {
			delete(m.flows, key)
		}
	}
	m.flows[flow.StateHash] = flow
	return nil
}
func (m *mockRepo) ConsumeOAuthFlow(_ context.Context, provider, state, browser string) (store.OAuthFlow, error) {
	flow, ok := m.flows[state]
	if !ok || flow.Provider != provider || flow.BrowserHash != browser || !flow.ExpiresAt.After(time.Now()) {
		return store.OAuthFlow{}, store.ErrNotFound
	}
	delete(m.flows, state)
	return flow, nil
}
func (m *mockRepo) LoginIdentity(_ context.Context, id store.ExternalIdentity, hash, csrf, previous string, ttl time.Duration) (store.AuthSession, error) {
	m.logins++
	m.lastPrevious = previous
	delete(m.sessions, previous)
	session := store.AuthSession{UserID: "user-1", DisplayName: id.DisplayName, Provider: id.Provider, CSRFToken: csrf, ExpiresAt: time.Now().Add(ttl)}
	m.sessions[hash] = session
	return session, nil
}
func (m *mockRepo) AuthSession(_ context.Context, hash string) (store.AuthSession, error) {
	if m.sessionError != nil {
		return store.AuthSession{}, m.sessionError
	}
	session, ok := m.sessions[hash]
	if !ok {
		return store.AuthSession{}, store.ErrNotFound
	}
	return session, nil
}
func (m *mockRepo) RevokeAuthSession(_ context.Context, hash string) error {
	delete(m.sessions, hash)
	return nil
}

type mockProvider struct {
	name       string
	exchanges  int
	fail       bool
	onExchange func(context.Context, string, string, string, string)
}

func (m *mockProvider) AuthorizationURL(state, verifier, nonce, redirect string) string {
	query := url.Values{"state": {state}, "redirect_uri": {redirect}}
	return "https://provider.example/authorize?" + query.Encode()
}
func (m *mockProvider) Exchange(ctx context.Context, code, verifier, nonce, redirect string) (store.ExternalIdentity, error) {
	m.exchanges++
	if m.onExchange != nil {
		m.onExchange(ctx, code, verifier, nonce, redirect)
	}
	if m.fail {
		return store.ExternalIdentity{}, errors.New("secret access token must not leak")
	}
	return store.ExternalIdentity{Provider: m.name, Subject: "42", DisplayName: "Example"}, nil
}

type authFixture struct {
	manager *Manager
	repo    *mockRepo
	github  *mockProvider
	google  *mockProvider
	mux     *http.ServeMux
}

func fixture(t *testing.T, development bool) authFixture {
	t.Helper()
	repo := newMockRepo()
	github := &mockProvider{name: "github"}
	google := &mockProvider{name: "google"}
	configuredOrigin := "https://grid.example"
	if development {
		configuredOrigin = "http://127.0.0.1:3000"
	}
	manager, err := NewManager(repo, Config{PublicURL: configuredOrigin, UIOrigin: configuredOrigin, Development: development, Providers: map[string]Provider{"github": github, "google": google}})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	manager.Mount(mux)
	return authFixture{manager, repo, github, google, mux}
}
func (f authFixture) request(method, path string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	return w
}
func started(t *testing.T, f authFixture, name string, cookies ...*http.Cookie) (string, *http.Cookie) {
	t.Helper()
	w := f.request("GET", "/api/v1/auth/"+name+"/start", cookies...)
	if w.Code != http.StatusFound {
		t.Fatalf("start %d %s", w.Code, w.Body.String())
	}
	u, err := url.Parse(w.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("state"), w.Result().Cookies()[0]
}
func callback(t *testing.T, f authFixture, name, state string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	return f.request("GET", "/api/v1/auth/"+name+"/callback?state="+state+"&code=test-code", cookies...)
}

func TestFlowBrowserProviderReplayAndLatestStart(t *testing.T) {
	f := fixture(t, false)
	state, browser := started(t, f, "github")
	if _, ok := f.repo.flows[state]; ok {
		t.Fatal("raw state stored")
	}
	flow := f.repo.flows[hashToken(state)]
	if !validToken(flow.Verifier) || !validToken(flow.Nonce) || flow.BrowserHash != hashToken(browser.Value) {
		t.Fatal("incorrect flow binding")
	}
	f.github.onExchange = func(ctx context.Context, code, verifier, nonce, redirect string) {
		if len(f.repo.flows) != 0 {
			t.Fatal("flow must be consumed before provider exchange")
		}
		if verifier != flow.Verifier || nonce != flow.Nonce || redirect != "https://grid.example/api/v1/auth/github/callback" {
			t.Fatal("exchange binding lost")
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 20*time.Second {
			t.Fatal("unbounded callback")
		}
	}
	if got := callback(t, f, "github", state); got.Code != 400 {
		t.Fatal("missing browser accepted")
	}
	wrong, _ := randomToken()
	if got := callback(t, f, "github", state, &http.Cookie{Name: browser.Name, Value: wrong}); got.Code != 400 {
		t.Fatal("wrong browser accepted")
	}
	if got := callback(t, f, "google", state, browser); got.Code != 400 {
		t.Fatal("provider mixup accepted")
	}
	if len(f.repo.flows) != 1 || f.github.exchanges != 0 || f.google.exchanges != 0 {
		t.Fatal("invalid callbacks consumed/exchanged flow")
	}
	got := callback(t, f, "github", state, browser)
	if got.Code != 303 || got.Header().Get("Location") != "https://grid.example/" {
		t.Fatalf("callback %d %s", got.Code, got.Body.String())
	}
	if got := callback(t, f, "github", state, browser); got.Code != 400 || f.github.exchanges != 1 {
		t.Fatal("flow replay accepted")
	}
	f.github.onExchange = nil
	old, browser := started(t, f, "github", browser)
	latest, _ := started(t, f, "github", browser)
	if got := callback(t, f, "github", old, browser); got.Code != 400 {
		t.Fatal("superseded flow accepted")
	}
	if got := callback(t, f, "github", latest, browser); got.Code != 303 {
		t.Fatal("latest flow rejected")
	}
}

func TestSessionRotationCookieAndLogoutCSRF(t *testing.T) {
	f := fixture(t, false)
	state, browser := started(t, f, "github")
	if browser.Name != "__Host-cg_browser" || !browser.HttpOnly || !browser.Secure || browser.Path != "/" || browser.Domain != "" || browser.SameSite != http.SameSiteLaxMode {
		t.Fatal("browser cookie unsafe")
	}
	w := callback(t, f, "github", state, browser)
	sessionCookie := w.Result().Cookies()[0]
	if sessionCookie.Name != "__Host-cg_session" || !sessionCookie.HttpOnly || !sessionCookie.Secure || sessionCookie.MaxAge != 86400 || !validToken(sessionCookie.Value) {
		t.Fatal("session cookie unsafe")
	}
	read := f.request("GET", "/api/v1/auth/session", sessionCookie)
	var body struct {
		Authenticated bool   `json:"authenticated"`
		CSRF          string `json:"csrf_token"`
		User          struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(read.Body.Bytes(), &body); err != nil || !body.Authenticated || !validToken(body.CSRF) || body.User.ID != "user-1" {
		t.Fatal("session response invalid")
	}
	if strings.Contains(read.Body.String(), sessionCookie.Value) || read.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("raw session exposed or cacheable")
	}
	state, browser = started(t, f, "google", browser)
	w = callback(t, f, "google", state, browser, sessionCookie)
	newCookie := w.Result().Cookies()[0]
	if newCookie.Value == sessionCookie.Value || f.repo.lastPrevious != hashToken(sessionCookie.Value) {
		t.Fatal("session not rotated")
	}
	if _, err := f.manager.Authenticate(withCookies(httptest.NewRequest("GET", "/", nil), sessionCookie)); err == nil {
		t.Fatal("old session live")
	}
	session, _ := f.manager.Authenticate(withCookies(httptest.NewRequest("GET", "/", nil), newCookie))
	for _, tc := range []struct {
		name, origin, csrf string
		duplicate          bool
	}{
		{"missing origin", "", session.CSRFToken, false}, {"wrong origin", "https://evil.example", session.CSRFToken, false},
		{"missing csrf", "https://grid.example", "", false}, {"wrong csrf", "https://grid.example", body.CSRF, false},
		{"duplicate csrf", "https://grid.example", session.CSRFToken, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := withCookies(httptest.NewRequest("POST", "/api/v1/auth/logout", nil), newCookie)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if tc.csrf != "" {
				r.Header.Set("X-CSRF-Token", tc.csrf)
			}
			if tc.duplicate {
				r.Header.Add("X-CSRF-Token", tc.csrf)
			}
			w := httptest.NewRecorder()
			f.mux.ServeHTTP(w, r)
			if w.Code != 403 || len(f.repo.sessions) != 1 {
				t.Fatalf("CSRF accepted: %d", w.Code)
			}
		})
	}
	r := withCookies(httptest.NewRequest("POST", "/api/v1/auth/logout", nil), newCookie)
	r.Header.Set("Origin", "https://grid.example")
	r.Header.Set("X-CSRF-Token", session.CSRFToken)
	w = httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	if w.Code != 204 || len(f.repo.sessions) != 0 || len(w.Result().Cookies()) != 2 {
		t.Fatal("logout did not revoke/clear")
	}
	for _, cookie := range w.Result().Cookies() {
		if cookie.MaxAge != -1 || cookie.Value != "" {
			t.Fatal("cookie not cleared")
		}
	}
}

func withCookies(r *http.Request, cookies ...*http.Cookie) *http.Request {
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	return r
}

func TestOAuthErrorsConsumeAndSanitize(t *testing.T) {
	for _, kind := range []string{"cancelled", "missing_code", "provider_failure", "expired", "wrong_identity"} {
		t.Run(kind, func(t *testing.T) {
			f := fixture(t, true)
			state, browser := started(t, f, "github")
			if browser.Name != "cg_browser" || browser.Secure {
				t.Fatal("development cookie flags")
			}
			path := "/api/v1/auth/github/callback?state=" + state + "&code=x"
			switch kind {
			case "cancelled":
				path = "/api/v1/auth/github/callback?state=" + state + "&error=secret_provider_error&error_description=secret"
			case "missing_code":
				path = "/api/v1/auth/github/callback?state=" + state
			case "provider_failure":
				f.github.fail = true
			case "expired":
				flow := f.repo.flows[hashToken(state)]
				flow.ExpiresAt = time.Now().Add(-time.Second)
				f.repo.flows[hashToken(state)] = flow
			case "wrong_identity":
				f.github.name = "google"
			}
			w := f.request("GET", path, browser)
			if w.Code < 400 || f.repo.logins != 0 || strings.Contains(w.Body.String(), "secret") || len(w.Result().Cookies()) != 0 {
				t.Fatalf("unsafe failed callback %d %s", w.Code, w.Body.String())
			}
			if kind != "expired" && len(f.repo.flows) != 0 {
				t.Fatal("failed callback remains replayable")
			}
		})
	}
}

func TestAmbiguousCredentialsAndRedirectsRejected(t *testing.T) {
	f := fixture(t, false)
	for _, tc := range []struct{ path, cookie, authorization string }{
		{"/api/v1/auth/github/start?next=https://evil.example", "", ""},
		{"/api/v1/auth/github/start?state=a&state=b", "", ""},
		{"/api/v1/auth/session?access_token=secret", "", ""},
		{"/api/v1/auth/session", "a=x;a=y", ""},
		{"/api/v1/auth/session", "bad-cookie", ""},
		{"/api/v1/auth/session", "", "Bearer secret"},
	} {
		r := httptest.NewRequest("GET", tc.path, nil)
		if tc.cookie != "" {
			r.Header.Set("Cookie", tc.cookie)
		}
		if tc.authorization != "" {
			r.Header.Set("Authorization", tc.authorization)
		}
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("accepted ambiguous request %s: %d", tc.path, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/api/v1/auth/github/start", nil)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("cross origin login start accepted")
	}
	if w := f.request("GET", "/api/v1/auth/nope/start"); w.Code != 404 {
		t.Fatal("unknown provider accepted")
	}
}

func TestConfigurationAndBoundary(t *testing.T) {
	for _, raw := range []string{"http://example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com?x=1", "https://example.com#x", "https://example.com?", "https://example.com/%2f", "javascript:alert(1)"} {
		if _, err := NewManager(newMockRepo(), Config{PublicURL: raw, UIOrigin: "https://grid.example"}); err == nil {
			t.Fatalf("unsafe configuration %s", raw)
		}
	}
	for _, raw := range []string{"http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"} {
		manager, err := NewManager(newMockRepo(), Config{PublicURL: raw, UIOrigin: raw, Development: true})
		if err != nil {
			t.Fatalf("loopback rejected %s: %v", raw, err)
		}
		if manager.ValidateBoundary(raw, raw, true) != nil || manager.ValidateBoundary(raw, "http://localhost:9999", true) == nil {
			t.Fatal("boundary configuration mismatch")
		}
	}
	if _, err := NewManager(newMockRepo(), Config{PublicURL: "http://example.com", UIOrigin: "http://example.com", Development: true}); err == nil {
		t.Fatal("nonloopback development accepted")
	}
	f := fixture(t, false)
	if len(f.manager.Providers()) != 2 || !f.manager.Providers()[0].Enabled {
		t.Fatal("providers response invalid")
	}
}

func TestDatabaseOutageIsUnavailableAndExpiredSessionIsUnauthenticated(t *testing.T) {
	f := fixture(t, false)
	state, browser := started(t, f, "github")
	loggedIn := callback(t, f, "github", state, browser)
	cookie := loggedIn.Result().Cookies()[0]
	f.repo.sessionError = errors.New("database secret-host unavailable")
	request := withCookies(httptest.NewRequest("GET", "/api/v1/auth/session", nil), cookie)
	if _, err := f.manager.Authenticate(request); !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("outage error %v", err)
	}
	for _, method := range []string{"GET", "POST"} {
		path := "/api/v1/auth/session"
		if method == "POST" {
			path = "/api/v1/auth/logout"
		}
		w := f.request(method, path, cookie)
		if w.Code != 503 || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("outage disguised as signout %d %s", w.Code, w.Body.String())
		}
	}
	f.repo.sessionError = nil
	session := f.repo.sessions[hashToken(cookie.Value)]
	session.ExpiresAt = time.Now().Add(-time.Second)
	f.repo.sessions[hashToken(cookie.Value)] = session
	if _, err := f.manager.Authenticate(request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired session %v", err)
	}
}

func TestHEADDoesNotCreateOrConsumeLoginFlows(t *testing.T) {
	f := fixture(t, false)
	w := f.request("HEAD", "/api/v1/auth/github/start")
	if w.Code != 405 || len(f.repo.flows) != 0 {
		t.Fatal("HEAD created OAuth flow")
	}
	state, browser := started(t, f, "github")
	w = f.request("HEAD", "/api/v1/auth/github/callback?state="+state+"&code=x", browser)
	if w.Code != 405 || len(f.repo.flows) != 1 || f.github.exchanges != 0 {
		t.Fatal("HEAD consumed OAuth flow")
	}
}

func TestPublicAndUIOriginsUseCompatibleHostOnlyCookies(t *testing.T) {
	for _, tc := range []struct {
		name, public, ui   string
		development, valid bool
	}{
		{"production same origin", "https://grid.example", "https://grid.example/", false, true},
		{"normalized host", "https://GRID.example", "https://grid.EXAMPLE", false, true},
		{"production subdomain mismatch", "https://api.grid.example", "https://grid.example", false, false},
		{"production port mismatch", "https://grid.example:8443", "https://grid.example", false, false},
		{"development proxy ports", "http://127.0.0.1:7070", "http://127.0.0.1:3000", true, true},
		{"development localhost ports", "http://localhost:7070", "http://localhost:3000", true, true},
		{"development hostname mismatch", "http://127.0.0.1:7070", "http://localhost:3000", true, false},
		{"development scheme mismatch", "https://127.0.0.1:7070", "http://127.0.0.1:3000", true, false},
		{"development nonloopback port mismatch", "https://grid.example:8443", "https://grid.example", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewManager(newMockRepo(), Config{PublicURL: tc.public, UIOrigin: tc.ui, Development: tc.development})
			if (err == nil) != tc.valid {
				t.Fatalf("origin policy result: %v", err)
			}
		})
	}
}

func TestAuthenticateSeparatesInvalidCredentialsFromMissingSession(t *testing.T) {
	f := fixture(t, false)
	for _, tc := range []struct{ name, path, cookie, authorization string }{
		{"malformed session", "/api/v1/projects", "__Host-cg_session=bad", ""},
		{"duplicate session", "/api/v1/projects", "__Host-cg_session=a; __Host-cg_session=b", ""},
		{"duplicate query", "/api/v1/projects?limit=1&limit=2", "", ""},
		{"authorization header", "/api/v1/projects", "", "Bearer bad"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", tc.path, nil)
			if tc.cookie != "" {
				r.Header.Set("Cookie", tc.cookie)
			}
			if tc.authorization != "" {
				r.Header.Set("Authorization", tc.authorization)
			}
			if _, err := f.manager.Authenticate(r); !errors.Is(err, ErrForbidden) {
				t.Fatalf("invalid credentials lost distinction: %v", err)
			}
		})
	}
	if _, err := f.manager.Authenticate(httptest.NewRequest("GET", "/api/v1/projects", nil)); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("missing cookie result %v", err)
	}
	for _, path := range []string{"/api/v1/auth/session", "/api/v1/auth/logout"} {
		method := "GET"
		if strings.HasSuffix(path, "logout") {
			method = "POST"
		}
		w := f.request(method, path, &http.Cookie{Name: f.manager.sessionCookie, Value: "malformed"})
		if w.Code != 403 || !strings.Contains(w.Body.String(), "invalid_credentials") {
			t.Fatalf("malformed session masked %s: %d %s", path, w.Code, w.Body.String())
		}
	}
}
