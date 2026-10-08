package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"commongrid/coordinator/internal/auth"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
)

type testSessions struct {
	user      string
	csrfCalls int
	err       error
}

func (s *testSessions) Authenticate(*http.Request) (store.AuthSession, error) {
	if s.err != nil {
		return store.AuthSession{}, s.err
	}
	if s.user == "" {
		return store.AuthSession{}, errors.New("private authentication error")
	}
	return store.AuthSession{UserID: s.user}, nil
}
func (s *testSessions) CheckCSRF(r *http.Request, _ store.AuthSession) error {
	s.csrfCalls++
	if r.Header.Get("X-CSRF-Token") != "test-token" {
		return errors.New("private CSRF error")
	}
	return nil
}
func (*testSessions) Mount(*http.ServeMux) {}

// Unused promoted methods panic if a request unexpectedly crosses a boundary.
type testRepository struct {
	Repository
	called     int
	user       string
	id         string
	limit      int
	after      string
	result     store.SubmitRequest
	checkpoint store.SubmitCheckpointRequest
	review     store.ReviewRequest
	err        error
	registered bool
}

func (s *testRepository) ListProjects(_ context.Context, limit int, after string) ([]store.ProjectSummary, error) {
	s.called++
	s.limit, s.after = limit, after
	return []store.ProjectSummary{{ID: "project", Title: "Database project", Type: "software", Description: ""}}, s.err
}
func (s *testRepository) ListTasks(_ context.Context, project string, limit int, after string) ([]store.TaskRecord, error) {
	s.called++
	s.id, s.limit, s.after = project, limit, after
	return []store.TaskRecord{{Contract: contract.TaskContract{Id: "task", ProjectId: "project"}, Status: "in_review"}}, s.err
}
func (s *testRepository) Task(_ context.Context, id string) (store.TaskRecord, error) {
	s.called++
	s.id = id
	return store.TaskRecord{Contract: contract.TaskContract{Id: id}, Status: "accepted"}, s.err
}
func (s *testRepository) ListUserLeases(_ context.Context, user string, limit int, after string) ([]store.Lease, error) {
	s.called++
	s.user, s.limit, s.after = user, limit, after
	return nil, s.err
}
func (s *testRepository) ListUserSubmissions(_ context.Context, user string, limit int, after string) ([]store.Submission, error) {
	s.called++
	s.user, s.limit, s.after = user, limit, after
	return nil, s.err
}
func (s *testRepository) ListUserCheckpoints(_ context.Context, user string, limit int, after string) ([]store.CheckpointRecord, error) {
	s.called++
	s.user, s.limit, s.after = user, limit, after
	return nil, s.err
}
func (s *testRepository) ListReviews(_ context.Context, user string, limit int, after string) ([]store.Submission, error) {
	s.called++
	s.user, s.limit, s.after = user, limit, after
	return nil, s.err
}
func (s *testRepository) RequestStop(_ context.Context, user, id string) (store.Lease, error) {
	s.called++
	s.user, s.id = user, id
	return store.Lease{ID: id, UserID: user, State: "stop_requested"}, s.err
}
func (s *testRepository) End(_ context.Context, user, id, reason string) (store.Lease, error) {
	s.called++
	s.user, s.id = user, id
	return store.Lease{ID: id, UserID: user, State: reason}, s.err
}
func (s *testRepository) Submit(_ context.Context, r store.SubmitRequest) (store.Submission, error) {
	s.called++
	s.result = r
	return store.Submission{ID: "submission", UserID: r.UserID, LeaseID: r.LeaseID, Status: "submitted"}, s.err
}
func (s *testRepository) SubmitCheckpoint(_ context.Context, r store.SubmitCheckpointRequest) (store.CheckpointRecord, error) {
	s.called++
	s.checkpoint = r
	return store.CheckpointRecord{Status: "unverified"}, s.err
}
func (s *testRepository) SubmitUploaded(ctx context.Context, r store.SubmitRequest) (store.Submission, error) {
	if !s.registered || r.Artifact.ID != "artifact" || r.Artifact.SHA256 != strings.Repeat("c", 64) || r.Artifact.SizeBytes != 10 {
		return store.Submission{}, store.ErrNotFound
	}
	return s.Submit(ctx, r)
}
func (s *testRepository) SubmitUploadedCheckpoint(ctx context.Context, r store.SubmitCheckpointRequest) (store.CheckpointRecord, error) {
	if !s.registered || r.Artifact.ID != "artifact" || r.Artifact.SHA256 != strings.Repeat("c", 64) || r.Artifact.SizeBytes != 10 {
		return store.CheckpointRecord{}, store.ErrNotFound
	}
	return s.SubmitCheckpoint(ctx, r)
}
func (s *testRepository) ReviewCandidate(_ context.Context, r store.ReviewRequest) (store.Submission, error) {
	s.called++
	s.review = r
	return store.Submission{ID: r.SubmissionID, Status: "in_review"}, s.err
}
func (s *testRepository) Submission(_ context.Context, user, id string) (store.Submission, error) {
	s.called++
	s.user, s.id = user, id
	return store.Submission{}, s.err
}
func (s *testRepository) Checkpoint(_ context.Context, user, id string) (store.CheckpointRecord, error) {
	s.called++
	s.user, s.id = user, id
	return store.CheckpointRecord{}, s.err
}
func (s *testRepository) LatestUsableCheckpoint(_ context.Context, r store.LatestCheckpointRequest) (store.CheckpointRecord, error) {
	s.called++
	s.user, s.id = r.UserID, r.TaskID
	return store.CheckpointRecord{}, s.err
}

func liveFixture(t *testing.T) (http.Handler, *testRepository, *testSessions) {
	t.Helper()
	repo := &testRepository{}
	sessions := &testSessions{user: "server-user"}
	api, err := newAuthenticated(repo, sessions, Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true})
	if err != nil {
		t.Fatal(err)
	}
	return api, repo, sessions
}
func liveRequest(api http.Handler, method, path, payload string, modify func(*http.Request)) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(payload))
	r.Host = "127.0.0.1:8787"
	r.Header.Set("Origin", "http://127.0.0.1:1420")
	r.Header.Set("X-CSRF-Token", "test-token")
	r.Header.Set("Content-Type", "application/json")
	if modify != nil {
		modify(r)
	}
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	return w
}
func TestAuthenticatedBoundaryAndPermanentExecutionGate(t *testing.T) {
	api, repo, sessions := liveFixture(t)
	for _, path := range []string{"/api/v1/tasks/task/leases", "/api/v1/leases/lease/start"} {
		w := liveRequest(api, "POST", path, `{"execution_enabled":true,"user_id":"attacker"}`, nil)
		if w.Code != 409 || !strings.Contains(w.Body.String(), `"execution_enabled":false`) || !strings.Contains(w.Body.String(), "isolation_gate_pending") {
			t.Fatal(w.Code, w.Body.String())
		}
		sessions.user = ""
		w = liveRequest(api, "POST", path, `{}`, nil)
		if w.Code != 401 {
			t.Fatal(w.Code, w.Body.String())
		}
		sessions.user = "server-user"
	}
	if repo.called != 0 {
		t.Fatal("gate reached durable repository")
	}
	for _, tc := range []struct {
		name   string
		mutate func(*http.Request)
		status int
	}{
		{"untrusted host", func(r *http.Request) { r.Host = "evil.example"; r.Header.Set("X-Forwarded-Host", "127.0.0.1:8787") }, 403},
		{"spoofed origin", func(r *http.Request) { r.Header.Set("Origin", "http://localhost:1420") }, 403},
		{"absent write origin", func(r *http.Request) { r.Header.Del("Origin") }, 403},
		{"duplicate origin", func(r *http.Request) { r.Header.Add("Origin", "http://127.0.0.1:1420") }, 403},
		{"absent CSRF", func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, 403},
		{"duplicate CSRF", func(r *http.Request) { r.Header.Add("X-CSRF-Token", "test-token") }, 403},
		{"wrong CSRF", func(r *http.Request) { r.Header.Set("X-CSRF-Token", "other") }, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := liveRequest(api, "POST", "/api/v1/leases/lease/stop", `{}`, tc.mutate)
			if w.Code != tc.status || repo.called != 0 {
				t.Fatal(w.Code, w.Body.String(), repo.called)
			}
			if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal(w.Header())
			}
		})
	}
}

func TestAuthenticatedReadsAndBoundedQueries(t *testing.T) {
	api, repo, sessions := liveFixture(t)
	w := liveRequest(api, "GET", "/api/v1/tasks?project_id=project&limit=1&after=cursor", "", nil)
	if w.Code != 200 || repo.id != "project" || repo.limit != 1 || repo.after != "cursor" {
		t.Fatal(w.Code, w.Body.String(), repo)
	}
	var data struct {
		Source    string                  `json:"source"`
		Items     []contract.TaskContract `json:"items"`
		Statuses  map[string]string       `json:"statuses"`
		Next      string                  `json:"next_cursor"`
		Execution bool                    `json:"execution_enabled"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.Source != "database" || data.Execution || len(data.Items) != 1 || data.Items[0].Id != "task" || data.Statuses["task"] != "in_review" || data.Next != "task" {
		t.Fatal(data)
	}
	for _, path := range []string{"/api/v1/me/leases", "/api/v1/me/submissions", "/api/v1/me/checkpoints", "/api/v1/reviews"} {
		w = liveRequest(api, "GET", path, "", nil)
		if w.Code != 200 || repo.user != "server-user" || repo.limit != 50 || !strings.Contains(w.Body.String(), `"items":[]`) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, q := range []string{"limit=0", "limit=-1", "limit=101", "limit=01", "limit=+1", "limit=1&limit=2", "after=../bad", "user_id=attacker", "project_id=project&project_id=other", "%zz=bad"} {
		before := repo.called
		w = liveRequest(api, "GET", "/api/v1/tasks?"+q, "", nil)
		if w.Code != 400 || repo.called != before {
			t.Fatal(q, w.Code, w.Body.String())
		}
	}
	sessions.user = ""
	before := repo.called
	w = liveRequest(api, "GET", "/api/v1/projects", "", nil)
	if w.Code != 401 || repo.called != before {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAuthenticatedWritesForceServerPrincipal(t *testing.T) {
	repo := &testRepository{registered: true}
	api, err := newAuthenticated(repo, &testSessions{user: "server-user"}, Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Artifacts: testArtifactService()})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ path, payload string }{
		{"/api/v1/leases/lease/stop", `{}`},
		{"/api/v1/leases/lease/end", `{"reason":"stopped"}`},
		{"/api/v1/leases/lease/result", `{"task_version":1,"contract_hash":"` + strings.Repeat("a", 64) + `","request_key":"request","base_commit":"` + strings.Repeat("b", 40) + `","artifact":{"id":"artifact","sha256":"` + strings.Repeat("c", 64) + `","size_bytes":10}}`},
		{"/api/v1/submissions/submission/review", `{"decision":"approve","comments":"review text"}`},
	} {
		w := liveRequest(api, "POST", test.path, test.payload, nil)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if repo.user != "server-user" || repo.id != "lease" || repo.result.UserID != "server-user" || repo.result.LeaseID != "lease" || repo.review.ReviewerID != "server-user" || repo.review.SubmissionID != "submission" {
		t.Fatal(repo)
	}
	checkpoint := contract.Checkpoint{SchemaVersion: "1.0", CheckpointId: "checkpoint", TaskId: "task", TaskVersion: 1, ContractHash: strings.Repeat("a", 64), LeaseId: "lease", Type: "hard", BaseCommit: strings.Repeat("b", 40), Summary: "partial work", ContinuationInstructions: "continue", ArtifactSha256: strings.Repeat("c", 64)}
	raw, _ := json.Marshal(checkpoint)
	payload := fmt.Sprintf(`{"checkpoint":%s,"artifact":{"id":"artifact","sha256":"%s","size_bytes":10},"request_key":"request"}`, raw, checkpoint.ArtifactSha256)
	w := liveRequest(api, "POST", "/api/v1/leases/lease/checkpoint", payload, nil)
	if w.Code != 200 || repo.checkpoint.UserID != "server-user" {
		t.Fatal(w.Code, w.Body.String())
	}
	before := repo.called
	w = liveRequest(api, "POST", "/api/v1/leases/different/checkpoint", payload, nil)
	if w.Code != 400 || repo.called != before {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAuthenticatedStrictJSONBeforeMutation(t *testing.T) {
	api, repo, _ := liveFixture(t)
	for _, payload := range []string{`{"user_id":"attacker"}`, `{"accepted":true}`, `{"reason":"completed"}`, `{"reason":"stopped","reason":"completed"}`, `{"Reason":"stopped"}`, `{"reason":null}`, `{"reason":1}`, `[]`, `null`, `{} {}`, `{"reason":"\ud800"}`, `{"reason":"` + strings.Repeat("a", maxBody) + `"}`} {
		w := liveRequest(api, "POST", "/api/v1/leases/lease/end", payload, nil)
		if w.Code != 400 || repo.called != 0 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, mutation := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("Content-Type") }, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, func(r *http.Request) { r.Header.Add("Content-Type", "application/json") }, func(r *http.Request) { r.Header.Set("Content-Type", "application/json; charset=latin1") }, func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }, func(r *http.Request) { r.Header.Set("Content-Type", "application/json; other=utf-8") },
	} {
		w := liveRequest(api, "POST", "/api/v1/leases/lease/end", `{"reason":"stopped"}`, mutation)
		if w.Code != 400 || repo.called != 0 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := liveRequest(api, "POST", "/api/v1/leases/lease/result", `{"artifact":{"id":"a","ID":"b"}}`, nil)
	if w.Code != 400 || repo.called != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAuthenticatedOperationalAndAmbiguousCredentialErrors(t *testing.T) {
	api, repo, sessions := liveFixture(t)
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{{auth.ErrUnavailable, 503, "authentication_unavailable"}, {auth.ErrForbidden, 403, "invalid_credentials"}, {auth.ErrUnauthenticated, 401, "unauthenticated"}} {
		sessions.err = fmt.Errorf("private DB credentials: %w", test.err)
		w := liveRequest(api, "GET", "/api/v1/projects", "", nil)
		if w.Code != test.status || !strings.Contains(w.Body.String(), test.code) || strings.Contains(w.Body.String(), "private DB") || repo.called != 0 {
			t.Fatal(w.Code, w.Body.String(), repo.called)
		}
	}
}

func TestAuthenticatedOwnedReadsResumeAndSanitizedErrors(t *testing.T) {
	api, repo, _ := liveFixture(t)
	for _, path := range []string{"/api/v1/submissions/receipt", "/api/v1/checkpoints/checkpoint", "/api/v1/tasks/task/resume?task_version=1&contract_hash=" + strings.Repeat("a", 64) + "&base_commit=" + strings.Repeat("b", 40) + "&strategy_id=strategy"} {
		w := liveRequest(api, "GET", path, "", nil)
		if w.Code != 200 || repo.user != "server-user" {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{{store.ErrInvalid, 400, "invalid_request"}, {store.ErrNotFound, 404, "not_found"}, {store.ErrReviewDenied, 403, "review_not_authorized"}, {store.ErrClosed, 409, "lease_or_task_closed"}, {store.ErrStale, 409, "stale_contract"}, {store.ErrConflict, 409, "idempotency_conflict"}, {store.ErrCapacity, 429, "capacity_exhausted"}, {errors.New("postgres://password@private-host"), 500, "internal_error"}} {
		repo.err = fmt.Errorf("sensitive context: %w", test.err)
		w := liveRequest(api, "GET", "/api/v1/submissions/receipt", "", nil)
		if w.Code != test.status || !strings.Contains(w.Body.String(), test.code) || strings.Contains(w.Body.String(), "sensitive") || strings.Contains(w.Body.String(), "private-host") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestAuthenticatedConstructorRejectsUnsafeConfiguration(t *testing.T) {
	repo := &testRepository{}
	sessions := &testSessions{user: "user"}
	for _, c := range []Config{{PublicURL: "http://service.example", UIOrigin: "https://ui.example"}, {PublicURL: "https://service.example/path", UIOrigin: "https://ui.example"}, {PublicURL: "https://service.example", UIOrigin: "https://evil@example.org"}, {PublicURL: "https://service.example", UIOrigin: "http://ui.example", Development: true}, {PublicURL: "https://service.example:99999", UIOrigin: "https://ui.example"}} {
		if _, err := newAuthenticated(repo, sessions, c); err == nil {
			t.Fatal("accepted unsafe configuration", c)
		}
	}
	if _, err := NewAuthenticated(repo, nil, Config{}); err == nil {
		t.Fatal("nil manager accepted")
	}
	var absent *testRepository
	if _, err := newAuthenticated(absent, sessions, Config{}); err == nil {
		t.Fatal("nil repository accepted")
	}
}
