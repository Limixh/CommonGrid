package httpapi

import (
	"commongrid/coordinator/internal/catalog"
	"encoding/json"
	"net/http"
	"strings"
)

func New(c *catalog.Catalog) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		write(w, 200, map[string]any{"status": "ok", "service": "coordinator", "mode": "development", "execution_enabled": false})
	})
	// Fixture browsing never supplies an authenticated identity or a development login.
	mux.HandleFunc("GET /api/v1/auth/providers", func(w http.ResponseWriter, r *http.Request) {
		write(w, 200, map[string]any{"configured": false, "providers": []map[string]any{{"id": "github", "enabled": false}, {"id": "google", "enabled": false}}})
	})
	mux.HandleFunc("GET /api/v1/auth/session", func(w http.ResponseWriter, r *http.Request) {
		write(w, 200, map[string]any{"authenticated": false, "execution_enabled": false})
	})
	mux.HandleFunc("GET /api/v1/projects", func(w http.ResponseWriter, r *http.Request) {
		write(w, 200, map[string]any{"source": c.Source, "items": c.Projects})
	})
	mux.HandleFunc("GET /api/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
		project := r.URL.Query().Get("project_id")
		items := make([]any, 0)
		for _, t := range c.Tasks {
			if project == "" || project == t.ProjectId {
				items = append(items, t)
			}
		}
		write(w, 200, map[string]any{"source": c.Source, "execution_enabled": false, "items": items})
	})
	mux.HandleFunc("GET /api/v1/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		for _, t := range c.Tasks {
			if t.Id == r.PathValue("id") {
				write(w, 200, map[string]any{"source": c.Source, "item": t})
				return
			}
		}
		write(w, 404, map[string]string{"code": "task_not_found", "message": "Görev bulunamadı."})
	})
	mux.HandleFunc("POST /api/v1/tasks/{id}/leases", func(w http.ResponseWriter, r *http.Request) {
		write(w, 409, map[string]string{"code": "isolation_gate_pending", "message": "Kimlik izolasyonu kapısı geçmeden görev çalıştırılamaz."})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		write(w, 404, map[string]string{"code": "not_found", "message": "Uç nokta bulunamadı."})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		// Loopback-only dev server; no broad CORS or production auth substitute.
		if host := r.Host; host != "127.0.0.1:8787" && host != "localhost:8787" {
			write(w, 403, map[string]string{"code": "invalid_host"})
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://127.0.0.1:1420" && origin != "http://localhost:1420" {
			write(w, 403, map[string]string{"code": "invalid_origin"})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != "GET" && r.Method != "POST" {
			write(w, 405, map[string]string{"code": "method_not_allowed"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
