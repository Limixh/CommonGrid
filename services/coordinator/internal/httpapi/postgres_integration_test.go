package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"commongrid/coordinator/internal/artifact"
	"commongrid/coordinator/internal/auth"
	"commongrid/coordinator/internal/catalog"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
	"commongrid/coordinator/internal/verification"
	"github.com/jackc/pgx/v5"
)

// Identity exchange, scanning and the trusted harness use explicit fixtures.
// Authentication, ownership, byte storage, receipts and verdict fencing use the
// real migrated database and private vault; no model or shell execution occurs.
type databaseIdentityProvider struct{}

func (databaseIdentityProvider) AuthorizationURL(state, verifier, nonce, redirect string) string {
	return "https://github.com/login/oauth/authorize?state=" + url.QueryEscape(state)
}
func (databaseIdentityProvider) Exchange(_ context.Context, code, verifier, nonce, redirect string) (store.ExternalIdentity, error) {
	if (code != "owner" && code != "worker") || len(verifier) != 43 || len(nonce) != 43 || redirect != "http://127.0.0.1:8787/api/v1/auth/github/callback" {
		return store.ExternalIdentity{}, auth.ErrProvider
	}
	return store.ExternalIdentity{Provider: "github", Subject: code, DisplayName: "Same display name"}, nil
}

type databaseBrowser struct {
	cookie     *http.Cookie
	user, csrf string
}

const databaseSource = "def fixtureValue : Nat := 7\n"
const databaseOtherSource = "def fixtureValue : Nat := 8\n"

type databaseArtifactScanner struct{}

func (databaseArtifactScanner) Scan(ctx context.Context, bundle *artifact.Bundle) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(bundle.Files) != 1 || bundle.Files[0].Path != "Main.lean" || (string(bundle.Files[0].Bytes) != databaseSource && string(bundle.Files[0].Bytes) != databaseOtherSource) {
		return errors.New("test_scanner_rejected")
	}
	return nil
}

type databaseHarness struct{}

func (databaseHarness) Verify(ctx context.Context, request verification.Request) (verification.Outcome, error) {
	if err := ctx.Err(); err != nil {
		return verification.Outcome{}, err
	}
	// This checks the actual parsed uploaded bytes; it cannot adopt a client
	// pass flag or execute the contract's shell commands.
	pass := len(request.Bundle.Files) == 1 && request.Bundle.Files[0].Path == "Main.lean" && string(request.Bundle.Files[0].Bytes) == databaseSource
	return verification.Outcome{Pass: pass, CheckedSHA256: request.ArtifactSHA256}, nil
}

type databaseHarnessResolver struct{}

func (databaseHarnessResolver) Resolve(task contract.TaskContract, purpose string) (verification.Harness, error) {
	if task.Id != "task" || task.Workspace.Commit != strings.Repeat("0", 40) || task.Verification.Profile != "lean-proof" || (purpose != "result" && purpose != "checkpoint") {
		return nil, verification.ErrHarness
	}
	return databaseHarness{}, nil
}

func databaseAPI(t *testing.T) (*store.Store, http.Handler, *verification.Worker) {
	t.Helper()
	dsn := os.Getenv("CG_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("CG_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("CG_TEST_DATABASE_URL required")
		}
		t.Skip("PostgreSQL integration: run npm run test:db")
	}
	schema := "cg_http_" + strings.ToLower(rand.Text())
	db, err := store.Open(context.Background(), dsn, schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		if !strings.HasPrefix(schema, "cg_http_") {
			t.Fatal("refusing non-test schema cleanup")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		connection, err := pgx.Connect(ctx, dsn)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close(ctx)
		if _, err = connection.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	if err = db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = db.CheckMigrations(context.Background()); err != nil {
		t.Fatal(err)
	}
	vault, err := artifact.NewVault(filepath.Join(t.TempDir(), "private-vault"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := vault.Close(); err != nil {
			t.Error(err)
		}
	})
	var scanner ArtifactScanner = databaseArtifactScanner{}
	service := &ArtifactService{Vault: vault, Scanner: scanner, ScanPolicy: "trusted-test-fixture", ScanPolicyVersion: "v1", DevelopmentOnly: true}
	if binary, digest := os.Getenv("CG_TEST_TRIVY_BINARY"), os.Getenv("CG_TEST_TRIVY_SHA256"); binary != "" || digest != "" || os.Getenv("CG_REQUIRE_TRIVY_TESTS") == "1" {
		scanner, err = artifact.NewTrivyScanner(binary, digest, t.TempDir())
		if err != nil {
			t.Fatal("required independent scanner unavailable", err)
		}
		service.Scanner = scanner
		service.ScanPolicy = artifact.TrivyScanPolicy
		service.ScanPolicyVersion = artifact.TrivyScanPolicyVersion
	}
	verifier, err := verification.New(db, vault, scanner, databaseHarnessResolver{}, verification.Config{ScanPolicy: service.ScanPolicy, ScanPolicyVersion: service.ScanPolicyVersion})
	if err != nil {
		t.Fatal(err)
	}
	manager, err := auth.NewManager(db, auth.Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Providers: map[string]auth.Provider{"github": databaseIdentityProvider{}}})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewAuthenticated(db, manager, Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Artifacts: service})
	if err != nil {
		t.Fatal(err)
	}
	return db, handler, verifier
}

func databaseBundle(t *testing.T, task contract.TaskContract, lease store.Lease, purpose, source string) []byte {
	t.Helper()
	binding := artifact.Binding{TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, LeaseID: lease.ID, BaseCommit: task.Workspace.Commit, StrategyID: lease.StrategyID, Purpose: purpose}
	raw, err := artifact.Encode(binding, map[string][]byte{"Main.lean": []byte(source)})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func databaseUploadRequest(handler http.Handler, browser databaseBrowser, lease, purpose, key string, raw []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/api/v1/leases/"+lease+"/artifacts?purpose="+url.QueryEscape(purpose)+"&request_key="+url.QueryEscape(key), bytes.NewReader(raw))
	if browser.cookie != nil {
		request.AddCookie(browser.cookie)
	}
	request.Header.Set("Origin", "http://127.0.0.1:1420")
	request.Header.Set("Content-Type", ArtifactContentType)
	request.Header.Set("X-CSRF-Token", browser.csrf)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func databaseUpload(t *testing.T, handler http.Handler, browser databaseBrowser, task contract.TaskContract, lease store.Lease, purpose, key string) store.ArtifactRef {
	t.Helper()
	raw := databaseBundle(t, task, lease, purpose, databaseSource)
	response := databaseUploadRequest(handler, browser, lease.ID, purpose, key, raw)
	databaseStatus(t, response, http.StatusOK)
	var receipt struct {
		Item store.ArtifactRef `json:"item"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	if receipt.Item.SHA256 != hex.EncodeToString(digest[:]) || receipt.Item.SizeBytes != int64(len(raw)) || !strings.HasPrefix(receipt.Item.ID, "artifact-") {
		t.Fatal("upload receipt does not bind bytes", receipt)
	}
	return receipt.Item
}

func databaseRequest(handler http.Handler, browser databaseBrowser, method, path, payload string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8787"+path, strings.NewReader(payload))
	if browser.cookie != nil {
		r.AddCookie(browser.cookie)
	}
	if method == http.MethodPost {
		r.Header.Set("Origin", "http://127.0.0.1:1420")
		r.Header.Set("Content-Type", "application/json")
		if browser.csrf != "" {
			r.Header.Set("X-CSRF-Token", browser.csrf)
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func databaseLogin(t *testing.T, handler http.Handler, subject string) databaseBrowser {
	t.Helper()
	start := databaseRequest(handler, databaseBrowser{}, "GET", "/api/v1/auth/github/start", "")
	if start.Code != 302 {
		t.Fatalf("start: %d %s", start.Code, start.Body)
	}
	location, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	var browserCookie *http.Cookie
	for _, cookie := range start.Result().Cookies() {
		if cookie.Name == "cg_browser" {
			browserCookie = cookie
		}
	}
	if browserCookie == nil {
		t.Fatal("browser binding missing")
	}
	callback := databaseRequest(handler, databaseBrowser{cookie: browserCookie}, "GET", "/api/v1/auth/github/callback?state="+url.QueryEscape(location.Query().Get("state"))+"&code="+subject, "")
	if callback.Code != 303 {
		t.Fatalf("callback: %d %s", callback.Code, callback.Body)
	}
	var browser databaseBrowser
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name == "cg_session" {
			browser.cookie = cookie
		}
	}
	if browser.cookie == nil || !browser.cookie.HttpOnly || browser.cookie.SameSite != http.SameSiteLaxMode {
		t.Fatal("private session cookie missing")
	}
	response := databaseRequest(handler, browser, "GET", "/api/v1/auth/session", "")
	var session struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			ID string `json:"id"`
		} `json:"user"`
		CSRF string `json:"csrf_token"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &session) != nil || !session.Authenticated {
		t.Fatal("session lookup failed", response.Code)
	}
	browser.user, browser.csrf = session.User.ID, session.CSRF
	if browser.user == "" || len(browser.csrf) != 43 {
		t.Fatal("principal missing")
	}
	return browser
}

func databaseTask(t *testing.T, db *store.Store, owner string) contract.TaskContract {
	t.Helper()
	ctx := context.Background()
	if err := db.CreateProject(ctx, "project", owner, 10000000, 120); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateNode(ctx, "leaf", "project", nil, 10000000); err != nil {
		t.Fatal(err)
	}
	fixtures, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	task := fixtures.Tasks[0]
	task.Id, task.ProjectId, task.NodeId = "task", "project", "leaf"
	task.DependsOn = []string{}
	task.Parallelism = contract.Parallelism{Mode: "independent", Initial: 1, Cap: 2}
	raw, _ := json.Marshal(task)
	task.ContractHash, err = contract.ComputeHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(task)
	if err = db.Publish(ctx, raw); err != nil {
		t.Fatal(err)
	}
	return task
}

func databaseStatus(t *testing.T, response *httptest.ResponseRecorder, expected int) {
	t.Helper()
	if response.Code != expected {
		t.Fatalf("status=%d want=%d: %s", response.Code, expected, response.Body)
	}
}

func TestPostgresAuthenticatedHTTPPrincipalReceiptsAndReview(t *testing.T) {
	db, handler, verifier := databaseAPI(t)
	ctx := context.Background()
	owner := databaseLogin(t, handler, "owner")
	worker := databaseLogin(t, handler, "worker")
	if owner.user == worker.user {
		t.Fatal("same display name linked accounts")
	}
	task := databaseTask(t, db, owner.user)
	databaseStatus(t, databaseRequest(handler, databaseBrowser{}, "GET", "/api/v1/projects", ""), 401)
	databaseStatus(t, databaseRequest(handler, worker, "GET", "/api/v1/tasks?limit=1", ""), 200)
	databaseStatus(t, databaseRequest(handler, worker, "GET", "/api/v1/tasks?limit=1&limit=2", ""), 403)
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/tasks/task/leases", "{}"), 409)
	// Seed an existing worker lease through trusted domain methods, never HTTP.
	lease, err := db.Reserve(ctx, store.ReserveRequest{UserID: worker.user, TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, StrategyID: task.Strategies[0].Id, RequestKey: "test-lease", LimitSec: 120})
	if err != nil {
		t.Fatal(err)
	}
	lease, err = db.Start(ctx, worker.user, lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/start", "{}"), 409)
	databaseStatus(t, databaseRequest(handler, owner, "GET", "/api/v1/leases/"+lease.ID, ""), 404)
	noCSRF := worker
	noCSRF.csrf = ""
	databaseStatus(t, databaseRequest(handler, noCSRF, "POST", "/api/v1/leases/"+lease.ID+"/stop", "{}"), 403)
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/end", `{"reason":"completed"}`), 400)
	checkpointArtifact := databaseUpload(t, handler, worker, task, lease, "checkpoint", "checkpoint-upload")
	databaseStatus(t, databaseRequest(handler, owner, "GET", "/api/v1/artifacts/"+checkpointArtifact.ID, ""), 404)
	artifactReceipt := databaseRequest(handler, worker, "GET", "/api/v1/artifacts/"+checkpointArtifact.ID, "")
	databaseStatus(t, artifactReceipt, 200)
	if strings.Contains(artifactReceipt.Body.String(), databaseSource) || strings.Contains(artifactReceipt.Body.String(), "Main.lean") {
		t.Fatal("receipt exposed source bytes")
	}
	checkpoint := contract.Checkpoint{SchemaVersion: "1.0", CheckpointId: "private-checkpoint", TaskId: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, LeaseId: lease.ID, Type: "hard", BaseCommit: task.Workspace.Commit, Summary: "PRIVATE_CONTEXT", ContinuationInstructions: "PRIVATE_CONTINUATION", ArtifactSha256: checkpointArtifact.SHA256}
	soft := checkpoint
	soft.Type = "soft"
	softPayload, _ := json.Marshal(map[string]any{"checkpoint": soft, "artifact": checkpointArtifact, "request_key": "soft-source-denied"})
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/checkpoint", string(softPayload)), 400)
	missingArtifact := checkpointArtifact
	missingArtifact.ID = "artifact-" + strings.Repeat("f", 32)
	unregisteredCP, _ := json.Marshal(map[string]any{"checkpoint": checkpoint, "artifact": missingArtifact, "request_key": "checkpoint-receipt"})
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/checkpoint", string(unregisteredCP)), 404)
	cpPayload, _ := json.Marshal(map[string]any{"checkpoint": checkpoint, "artifact": checkpointArtifact, "request_key": "checkpoint-receipt"})
	databaseStatus(t, databaseRequest(handler, owner, "POST", "/api/v1/leases/"+lease.ID+"/checkpoint", string(cpPayload)), 404)
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/checkpoint", string(cpPayload)), 200)
	verifiedCheckpoint, err := verifier.Checkpoint(ctx, checkpoint.CheckpointId)
	if err != nil || verifiedCheckpoint.Status != "usable" {
		t.Fatal(err)
	}
	databaseStatus(t, databaseRequest(handler, owner, "GET", "/api/v1/checkpoints/private-checkpoint", ""), 404)
	resume := "/api/v1/tasks/task/resume?task_version=1&contract_hash=" + task.ContractHash + "&base_commit=" + task.Workspace.Commit + "&strategy_id=" + lease.StrategyID
	databaseStatus(t, databaseRequest(handler, worker, "GET", resume, ""), 200)
	databaseStatus(t, databaseRequest(handler, owner, "GET", resume, ""), 404)
	resultArtifact := databaseUpload(t, handler, worker, task, lease, "result", "result-upload")
	resultReplay := databaseUpload(t, handler, worker, task, lease, "result", "result-upload")
	if resultArtifact != resultReplay {
		t.Fatal("upload retry changed receipt")
	}
	differentBytes := databaseBundle(t, task, lease, "result", databaseOtherSource)
	databaseStatus(t, databaseUploadRequest(handler, worker, lease.ID, "result", "result-upload", differentBytes), 409)
	resultDTO := map[string]any{"task_version": task.TaskVersion, "contract_hash": task.ContractHash, "request_key": "result-receipt", "base_commit": task.Workspace.Commit, "artifact": resultArtifact}
	resultDTO["user_id"] = worker.user
	forged, _ := json.Marshal(resultDTO)
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/result", string(forged)), 400)
	delete(resultDTO, "user_id")
	for _, wrong := range []store.ArtifactRef{missingArtifact, checkpointArtifact, {ID: resultArtifact.ID, SHA256: strings.Repeat("b", 64), SizeBytes: resultArtifact.SizeBytes}, {ID: resultArtifact.ID, SHA256: resultArtifact.SHA256, SizeBytes: resultArtifact.SizeBytes + 1}} {
		resultDTO["artifact"] = wrong
		invalidPayload, _ := json.Marshal(resultDTO)
		databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/result", string(invalidPayload)), 404)
	}
	resultDTO["artifact"] = resultArtifact
	resultPayload, _ := json.Marshal(resultDTO)
	databaseStatus(t, databaseRequest(handler, owner, "POST", "/api/v1/leases/"+lease.ID+"/result", string(resultPayload)), 404)
	response := databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/result", string(resultPayload))
	databaseStatus(t, response, 200)
	var receipt struct {
		Item store.Submission `json:"item"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Item.UserID != worker.user || receipt.Item.Status != "submitted" {
		t.Fatal("non-authoritative receipt")
	}
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease.ID+"/result", string(resultPayload)), 200)
	verifiedSubmission, err := verifier.Submission(ctx, receipt.Item.ID)
	if err != nil || verifiedSubmission.Status != "verified_candidate" {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/me/leases", "/api/v1/me/submissions", "/api/v1/me/checkpoints"} {
		response := databaseRequest(handler, owner, "GET", path, "")
		databaseStatus(t, response, 200)
		if strings.Contains(response.Body.String(), worker.user) || strings.Contains(response.Body.String(), "PRIVATE_CONTEXT") {
			t.Fatal("cross-user list exposed private record")
		}
	}
	reviews := databaseRequest(handler, owner, "GET", "/api/v1/reviews", "")
	databaseStatus(t, reviews, 200)
	if !strings.Contains(reviews.Body.String(), receipt.Item.ID) {
		t.Fatal("eligible owner review missing")
	}
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/submissions/"+receipt.Item.ID+"/review", `{"decision":"approve","comments":"self"}`), 403)
	databaseStatus(t, databaseRequest(handler, owner, "POST", "/api/v1/submissions/"+receipt.Item.ID+"/review", `{"decision":"approve","comments":"checked"}`), 200)
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/submissions/"+receipt.Item.ID+"/verify", `{"pass":true}`), 404)
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/auth/logout", ""), 204)
	databaseStatus(t, databaseRequest(handler, worker, "GET", "/api/v1/me/submissions", ""), 401)
}
