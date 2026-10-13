package httpapi

import (
	"commongrid/coordinator/internal/catalog"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutes(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	api := New(c)
	cases := []struct {
		method, path, host, origin string
		status                     int
	}{
		{"GET", "/health", "127.0.0.1:8787", "", 200},
		{"GET", "/api/v1/projects", "127.0.0.1:8787", "", 200},
		{"GET", "/api/v1/tasks", "127.0.0.1:8787", "", 200},
		{"GET", "/api/v1/tasks/software-bounds", "127.0.0.1:8787", "", 200},
		{"GET", "/api/v1/tasks/unknown", "127.0.0.1:8787", "", 404},
		{"POST", "/api/v1/tasks/software-bounds/leases", "127.0.0.1:8787", "", 409},
		{"GET", "/api/v1/tasks", "evil.example", "", 403},
		{"POST", "/api/v1/tasks/software-bounds/leases", "127.0.0.1:8787", "https://evil.example", 403},
		{"GET", "/api/v1/tasks", "127.0.0.1:8787", "http://127.0.0.1:1420", 200},
		{"DELETE", "/api/v1/tasks/software-bounds", "127.0.0.1:8787", "", 405},
	}
	for _, scenario := range cases {
		t.Run(scenario.method+scenario.path+scenario.host+scenario.origin, func(t *testing.T) {
			r := httptest.NewRequest(scenario.method, scenario.path, nil)
			r.Host = scenario.host
			if scenario.origin != "" {
				r.Header.Set("Origin", scenario.origin)
			}
			w := httptest.NewRecorder()
			api.ServeHTTP(w, r)
			if w.Code != scenario.status {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
			var data map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestTaskFilteringAndExecutionGate(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	api := New(c)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/tasks?project_id=runtime-lab", nil)
	r.Host = "127.0.0.1:8787"
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	var data struct {
		Items     []json.RawMessage `json:"items"`
		Execution bool              `json:"execution_enabled"`
		Source    string            `json:"source"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Items) != 2 || data.Execution || data.Source != "fixture" {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}

func TestFixtureAuthMetadataDoesNotCreateIdentity(t *testing.T) {
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	api := New(c)
	for _, path := range []string{"/api/v1/auth/providers", "/api/v1/auth/session"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Host = "127.0.0.1:8787"
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		if path == "/api/v1/auth/session" {
			var session struct {
				Authenticated bool `json:"authenticated"`
				Execution     bool `json:"execution_enabled"`
				User          any  `json:"user"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &session); err != nil {
				t.Fatal(err)
			}
			if session.Authenticated || session.Execution || session.User != nil {
				t.Fatal(session)
			}
		} else {
			var providers struct {
				Configured bool `json:"configured"`
				Providers  []struct {
					ID      string `json:"id"`
					Enabled bool   `json:"enabled"`
				} `json:"providers"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &providers); err != nil {
				t.Fatal(err)
			}
			if providers.Configured || len(providers.Providers) != 2 {
				t.Fatal(providers)
			}
			for _, provider := range providers.Providers {
				if provider.Enabled {
					t.Fatal(provider)
				}
			}
		}
	}
	for _, path := range []string{"/api/v1/auth/dev-login", "/api/v1/auth/github/start", "/api/v1/me/leases"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Host = "127.0.0.1:8787"
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
}
