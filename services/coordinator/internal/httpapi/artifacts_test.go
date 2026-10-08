package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"commongrid/coordinator/internal/artifact"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
)

type testArtifactVault struct {
	calls int
	err   error
}

func (v *testArtifactVault) Put(context.Context, string, []byte, string) error {
	v.calls++
	return v.err
}

type testArtifactScanner struct {
	calls int
	err   error
}

func (s *testArtifactScanner) Scan(context.Context, *artifact.Bundle) error { s.calls++; return s.err }
func testArtifactService() *ArtifactService {
	return &ArtifactService{Vault: &testArtifactVault{}, Scanner: &testArtifactScanner{}, ScanPolicy: "test-policy", ScanPolicyVersion: "v1"}
}

func TestArtifactMetadataWritesFailClosed(t *testing.T) {
	api, repo, _ := liveFixture(t)
	payload := `{"task_version":1,"contract_hash":"` + strings.Repeat("a", 64) + `","request_key":"request","base_commit":"` + strings.Repeat("b", 40) + `","artifact":{"id":"artifact","sha256":"` + strings.Repeat("c", 64) + `","size_bytes":10}}`
	w := liveRequest(api, "POST", "/api/v1/leases/lease/result", payload, nil)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "artifact_storage_unavailable") || repo.called != 0 {
		t.Fatal(w.Code, w.Body.String(), repo.called)
	}
	checkpoint := map[string]any{"schema_version": "1.0", "checkpoint_id": "checkpoint", "task_id": "task", "task_version": 1, "contract_hash": strings.Repeat("a", 64), "lease_id": "lease", "type": "hard", "base_commit": strings.Repeat("b", 40), "summary": "partial work", "continuation_instructions": "continue", "artifact_sha256": strings.Repeat("c", 64)}
	checkpointPayload, _ := json.Marshal(map[string]any{"checkpoint": checkpoint, "artifact": store.ArtifactRef{ID: "artifact", SHA256: strings.Repeat("c", 64), SizeBytes: 10}, "request_key": "request"})
	w = liveRequest(api, "POST", "/api/v1/leases/lease/checkpoint", string(checkpointPayload), nil)
	if w.Code != 503 || repo.called != 0 {
		t.Fatal(w.Code, w.Body.String(), repo.called)
	}
	w = liveRequest(api, "POST", "/api/v1/leases/lease/artifacts?purpose=result&request_key=request", "untrusted bytes", func(r *http.Request) { r.Header.Set("Content-Type", ArtifactContentType) })
	if w.Code != 503 || repo.called != 0 {
		t.Fatal(w.Code, w.Body.String(), repo.called)
	}
	// Configuring storage alone never turns scanner absence into acceptance.
	service := testArtifactService()
	service.Scanner = nil
	receipts := &artifactTestRepository{}
	api, err := newAuthenticated(receipts, &testSessions{user: "server-user"}, Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Artifacts: service})
	if err != nil {
		t.Fatal(err)
	}
	w = liveRequest(api, "POST", "/api/v1/leases/lease/artifacts?purpose=result&request_key=request", "bytes", func(r *http.Request) { r.Header.Set("Content-Type", ArtifactContentType) })
	if w.Code != 503 || !strings.Contains(w.Body.String(), "artifact_scanner_unavailable") || receipts.called != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}

type artifactTestRepository struct {
	testRepository
	lease         store.Lease
	task          store.TaskRecord
	records       map[string]store.ArtifactRecord
	registrations int
	marks         int
	registerError error
}

func (s *artifactTestRepository) Lease(_ context.Context, user, id string) (store.Lease, error) {
	s.called++
	if s.lease.UserID != user || s.lease.ID != id {
		return store.Lease{}, store.ErrNotFound
	}
	return s.lease, nil
}
func (s *artifactTestRepository) Task(context.Context, string) (store.TaskRecord, error) {
	s.called++
	return s.task, nil
}
func (s *artifactTestRepository) RegisterArtifact(_ context.Context, r store.ArtifactRegistration) (store.ArtifactRecord, error) {
	s.registrations++
	if s.registerError != nil {
		return store.ArtifactRecord{}, s.registerError
	}
	if s.records == nil {
		s.records = map[string]store.ArtifactRecord{}
	}
	for _, record := range s.records {
		if record.UserID == r.UserID && record.RequestKey == r.RequestKey {
			if record.ArtifactRegistration != r {
				return store.ArtifactRecord{}, store.ErrConflict
			}
			return record, nil
		}
	}
	record := store.ArtifactRecord{ArtifactRegistration: r, State: "pending"}
	s.records[r.Artifact.ID] = record
	return record, nil
}
func (s *artifactTestRepository) MarkArtifactStored(_ context.Context, user, id string, ref store.ArtifactRef) (store.ArtifactRecord, error) {
	s.marks++
	r, ok := s.records[id]
	if !ok || r.UserID != user || r.Artifact != ref {
		return store.ArtifactRecord{}, store.ErrNotFound
	}
	r.State = "ready"
	s.records[id] = r
	return r, nil
}
func (s *artifactTestRepository) ArtifactForOwner(_ context.Context, user, id string) (store.ArtifactRecord, error) {
	r, ok := s.records[id]
	if !ok || r.UserID != user {
		return store.ArtifactRecord{}, store.ErrNotFound
	}
	return r, nil
}

func (s *artifactTestRepository) SubmitUploaded(ctx context.Context, r store.SubmitRequest) (store.Submission, error) {
	record, err := s.ArtifactForOwner(ctx, r.UserID, r.Artifact.ID)
	if err != nil {
		return store.Submission{}, err
	}
	if record.State != "ready" || record.LeaseID != r.LeaseID || record.Purpose != "result" || record.Artifact != r.Artifact {
		return store.Submission{}, store.ErrInvalid
	}
	return s.testRepository.Submit(ctx, r)
}
func (s *artifactTestRepository) SubmitUploadedCheckpoint(ctx context.Context, r store.SubmitCheckpointRequest) (store.CheckpointRecord, error) {
	record, err := s.ArtifactForOwner(ctx, r.UserID, r.Artifact.ID)
	if err != nil {
		return store.CheckpointRecord{}, err
	}
	var metadata struct {
		LeaseID string `json:"lease_id"`
	}
	if json.Unmarshal(r.RawCheckpoint, &metadata) != nil || record.State != "ready" || record.LeaseID != metadata.LeaseID || record.Purpose != "checkpoint" || record.Artifact != r.Artifact {
		return store.CheckpointRecord{}, store.ErrInvalid
	}
	return s.testRepository.SubmitCheckpoint(ctx, r)
}

func TestArtifactUploadHeaderAndQueryValidationBeforeRead(t *testing.T) {
	api, repo, _ := liveFixture(t)
	for _, tc := range []struct {
		name   string
		query  string
		mutate func(*http.Request)
	}{
		{"absent purpose", "request_key=request", nil},
		{"wrong purpose", "purpose=proof&request_key=request", nil},
		{"duplicate key", "purpose=result&request_key=a&request_key=b", nil},
		{"client owner", "purpose=result&request_key=a&user_id=attacker", nil},
		{"client URL", "purpose=result&request_key=a&url=https://evil.example", nil},
		{"bad request key", "purpose=result&request_key=../x", nil},
		{"wrong media", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Set("Content-Type", "application/json") }},
		{"media parameter", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Set("Content-Type", ArtifactContentType+"; charset=utf-8") }},
		{"duplicate media", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Add("Content-Type", ArtifactContentType) }},
		{"encoding", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Set("Content-Encoding", "identity") }},
		{"duplicate length", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Add("Content-Length", "1"); r.Header.Add("Content-Length", "2") }},
		{"ambiguous length", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Set("Content-Length", "1, 2") }},
		{"length mismatch", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Set("Content-Length", "1") }},
		{"length overflow", "purpose=result&request_key=a", func(r *http.Request) { r.ContentLength = maxArtifactBody + 1 }},
		{"ambiguous transfer", "purpose=result&request_key=a", func(r *http.Request) { r.Header.Set("Transfer-Encoding", "chunked") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := liveRequest(api, "POST", "/api/v1/leases/lease/artifacts?"+tc.query, "bytes", func(r *http.Request) {
				r.Header.Set("Content-Type", ArtifactContentType)
				if tc.mutate != nil {
					tc.mutate(r)
				}
			})
			if w.Code != 400 || repo.called != 0 {
				t.Fatal(w.Code, w.Body.String(), repo.called)
			}
		})
	}
}

type forbiddenReadBody struct{ read bool }

func (b *forbiddenReadBody) Read([]byte) (int, error) {
	b.read = true
	return 0, errors.New("unexpected read")
}
func (*forbiddenReadBody) Close() error { return nil }

func TestArtifactUploadAuthenticationAndCSRFBeforeRead(t *testing.T) {
	api, repo, sessions := liveFixture(t)
	for _, mutate := range []func(*http.Request){
		func(r *http.Request) { sessions.user = "" },
		func(r *http.Request) { r.Header.Del("X-CSRF-Token") },
		func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") },
		func(r *http.Request) { r.Host = "evil.example" },
	} {
		sessions.user = "server-user"
		b := &forbiddenReadBody{}
		w := liveRequest(api, "POST", "/api/v1/leases/lease/artifacts?purpose=result&request_key=request", "", func(r *http.Request) {
			r.Body = b
			r.ContentLength = -1
			r.Header.Set("Content-Type", ArtifactContentType)
			mutate(r)
		})
		if (w.Code != 401 && w.Code != 403) || b.read || repo.called != 0 {
			t.Fatal(w.Code, w.Body.String(), b.read)
		}
	}
}

func TestArtifactServiceLimitsBeforeBodyRead(t *testing.T) {
	service := testArtifactService()
	service.once.Do(func() { service.slots = make(chan struct{}, 4) })
	for range 4 {
		service.slots <- struct{}{}
	}
	repo := &artifactTestRepository{}
	api, err := newAuthenticated(repo, &testSessions{user: "server-user"}, Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Artifacts: service})
	if err != nil {
		t.Fatal(err)
	}
	b := &forbiddenReadBody{}
	w := liveRequest(api, "POST", "/api/v1/leases/lease/artifacts?purpose=result&request_key=request", "", func(r *http.Request) {
		r.Body = b
		r.ContentLength = -1
		r.Header.Set("Content-Type", ArtifactContentType)
	})
	if w.Code != 503 || !strings.Contains(w.Body.String(), "artifact_upload_busy") || b.read || repo.called != 0 {
		t.Fatal(w.Code, w.Body.String(), b.read)
	}
}

var _ io.ReadCloser = (*forbiddenReadBody)(nil)

func artifactFixture(t *testing.T) (http.Handler, *artifactTestRepository, *testSessions, *ArtifactService, []byte) {
	t.Helper()
	taskBytes, err := os.ReadFile("../artifact/testdata/client-task.json")
	if err != nil {
		t.Fatal(err)
	}
	var task contract.TaskContract
	if json.Unmarshal(taskBytes, &task) != nil {
		t.Fatal("task fixture")
	}
	raw, err := os.ReadFile("../artifact/testdata/client-bundle.zip")
	if err != nil {
		t.Fatal(err)
	}
	repo := &artifactTestRepository{lease: store.Lease{ID: "lease-client-fixture", UserID: "server-user", TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, StrategyID: "invariant", State: "active"}, task: store.TaskRecord{Contract: task, Status: "open"}}
	sessions := &testSessions{user: "server-user"}
	service := testArtifactService()
	api, err := newAuthenticated(repo, sessions, Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Artifacts: service})
	if err != nil {
		t.Fatal(err)
	}
	return api, repo, sessions, service, raw
}

func artifactRequest(api http.Handler, raw []byte, key string) *httptest.ResponseRecorder {
	return liveRequest(api, "POST", "/api/v1/leases/lease-client-fixture/artifacts?purpose=result&request_key="+key, string(raw), func(r *http.Request) { r.Header.Set("Content-Type", ArtifactContentType) })
}

func artifactResponseRef(t *testing.T, w *httptest.ResponseRecorder) store.ArtifactRef {
	t.Helper()
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response struct {
		Item store.ArtifactRef `json:"item"`
	}
	if json.Unmarshal(w.Body.Bytes(), &response) != nil || !strings.HasPrefix(response.Item.ID, "artifact-") {
		t.Fatal(w.Body.String())
	}
	return response.Item
}

func rewriteBundle(t *testing.T, raw []byte, manifestEdit func(map[string]any), replacement []byte, duplicate bool) []byte {
	t.Helper()
	r, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string][]byte{}
	for _, f := range r.File {
		reader, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		entries[f.Name], err = io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	var manifest map[string]any
	if json.Unmarshal(entries["manifest.json"], &manifest) != nil {
		t.Fatal("manifest fixture")
	}
	if manifestEdit != nil {
		manifestEdit(manifest)
	}
	if replacement != nil {
		entries["files/src/search.ts"] = replacement
		file := manifest["files"].([]any)[0].(map[string]any)
		sum := sha256.Sum256(replacement)
		file["sha256"] = hex.EncodeToString(sum[:])
		file["size_bytes"] = len(replacement)
	}
	entries["manifest.json"], err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, name := range []string{"manifest.json", "files/src/search.ts"} {
		content := entries[name]
		f, err := writer.CreateRaw(&zip.FileHeader{Name: name, Method: zip.Store, Flags: 0x0800, CreatorVersion: 0x0314, ReaderVersion: 20, ModifiedDate: 33, ExternalAttrs: 0100644 << 16, CRC32: crc32.ChecksumIEEE(content), CompressedSize64: uint64(len(content)), UncompressedSize64: uint64(len(content))})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write(entries[name]); err != nil {
			t.Fatal(err)
		}
	}
	if duplicate {
		content := entries["files/src/search.ts"]
		f, err := writer.CreateRaw(&zip.FileHeader{Name: "files/src/search.ts", Method: zip.Store, Flags: 0x0800, CreatorVersion: 0x0314, ReaderVersion: 20, ModifiedDate: 33, ExternalAttrs: 0100644 << 16, CRC32: crc32.ChecksumIEEE(content), CompressedSize64: uint64(len(content)), UncompressedSize64: uint64(len(content))})
		if err != nil {
			t.Fatal(err)
		}
		f.Write(entries["files/src/search.ts"])
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestArtifactUploadReceiptOwnershipAndIdempotency(t *testing.T) {
	api, repo, sessions, service, raw := artifactFixture(t)
	ref := artifactResponseRef(t, artifactRequest(api, raw, "upload"))
	if repo.registrations != 1 || repo.marks != 1 || service.Scanner.(*testArtifactScanner).calls != 1 || repo.records[ref.ID].State != "ready" {
		t.Fatal(repo)
	}
	if again := artifactResponseRef(t, artifactRequest(api, raw, "upload")); again != ref {
		t.Fatal(ref, again)
	}
	changed := rewriteBundle(t, raw, nil, []byte("export const answer = 43;\n"), false)
	w := artifactRequest(api, changed, "upload")
	if w.Code != 409 || service.Vault.(*testArtifactVault).calls != 2 {
		t.Fatal(w.Code, w.Body.String(), service.Vault.(*testArtifactVault).calls)
	}
	w = liveRequest(api, "GET", "/api/v1/artifacts/"+ref.ID, "", nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "src/search.ts") || strings.Contains(w.Body.String(), "server-user") || strings.Contains(w.Body.String(), "scan_policy") {
		t.Fatal(w.Code, w.Body.String())
	}
	sessions.user = "other-user"
	w = liveRequest(api, "GET", "/api/v1/artifacts/"+ref.ID, "", nil)
	if w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	before := repo.registrations
	w = artifactRequest(api, raw, "other")
	if w.Code != 404 || repo.registrations != before {
		t.Fatal(w.Code, w.Body.String())
	}
	sessions.user = "server-user"
	result := map[string]any{"task_version": repo.lease.TaskVersion, "contract_hash": repo.lease.ContractHash, "request_key": "result", "base_commit": repo.task.Contract.Workspace.Commit, "artifact": ref}
	payload, _ := json.Marshal(result)
	w = liveRequest(api, "POST", "/api/v1/leases/lease-client-fixture/result", string(payload), nil)
	if w.Code != 200 || repo.result.UserID != "server-user" {
		t.Fatal(w.Code, w.Body.String())
	}
	sessions.user = "other-user"
	w = liveRequest(api, "POST", "/api/v1/leases/lease-client-fixture/result", string(payload), nil)
	if w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	sessions.user = "server-user"
	ref.SHA256 = strings.Repeat("f", 64)
	result["artifact"] = ref
	payload, _ = json.Marshal(result)
	w = liveRequest(api, "POST", "/api/v1/leases/lease-client-fixture/result", string(payload), nil)
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
}

type repeatedArtifactBody struct{ bytesRead int64 }

func (b *repeatedArtifactBody) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	b.bytesRead += int64(len(p))
	return len(p), nil
}
func (*repeatedArtifactBody) Close() error { return nil }

func TestArtifactUnknownSizeStreamStopsAtLimit(t *testing.T) {
	api, repo, _, service, _ := artifactFixture(t)
	b := &repeatedArtifactBody{}
	w := liveRequest(api, "POST", "/api/v1/leases/lease-client-fixture/artifacts?purpose=result&request_key=upload", "", func(r *http.Request) {
		r.Body = b
		r.ContentLength = -1
		r.Header.Set("Content-Type", ArtifactContentType)
	})
	if w.Code != 400 || b.bytesRead != maxArtifactBody+1 || repo.registrations != 0 || service.Scanner.(*testArtifactScanner).calls != 0 || service.Vault.(*testArtifactVault).calls != 0 {
		t.Fatal(w.Code, w.Body.String(), b.bytesRead)
	}
}

func TestArtifactDevelopmentOnlyScannerConfiguration(t *testing.T) {
	service := testArtifactService()
	service.DevelopmentOnly = true
	_, err := newAuthenticated(&testRepository{}, &testSessions{user: "server-user"}, Config{PublicURL: "https://service.example", UIOrigin: "https://ui.example", Artifacts: service})
	if !errors.Is(err, store.ErrInvalid) {
		t.Fatal("development scanner accepted in production", err)
	}
}

func TestArtifactUploadValidationAndRequiredScanner(t *testing.T) {
	for _, name := range []string{"malformed", "wrong binding", "duplicate file", "known secret", "scanner rejected", "scanner unavailable", "quota exhausted", "vault failure"} {
		t.Run(name, func(t *testing.T) {
			api, repo, _, service, raw := artifactFixture(t)
			want := 400
			switch name {
			case "malformed":
				raw = []byte("not a bundle")
			case "wrong binding":
				raw = rewriteBundle(t, raw, func(m map[string]any) { m["lease_id"] = "other-lease" }, nil, false)
			case "duplicate file":
				raw = rewriteBundle(t, raw, nil, nil, true)
			case "known secret":
				raw = rewriteBundle(t, raw, nil, []byte("-----BEGIN PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----\n"), false)
			case "scanner rejected":
				service.Scanner.(*testArtifactScanner).err = errors.New("private scan diagnostic")
				want = 422
			case "scanner unavailable":
				service.Scanner.(*testArtifactScanner).err = ErrArtifactScannerUnavailable
				want = 503
			case "quota exhausted":
				repo.registerError = store.ErrCapacity
				want = 429
			case "vault failure":
				service.Vault.(*testArtifactVault).err = errors.New("private vault path")
				want = 503
			}
			w := artifactRequest(api, raw, "upload")
			if w.Code != want || strings.Contains(w.Body.String(), "private") {
				t.Fatal(w.Code, w.Body.String())
			}
			if name != "vault failure" && service.Vault.(*testArtifactVault).calls != 0 {
				t.Fatal("invalid data reached vault")
			}
			if name == "vault failure" {
				for _, record := range repo.records {
					if record.State != "pending" {
						t.Fatal("failed storage became usable")
					}
				}
				service.Vault.(*testArtifactVault).err = nil
				artifactResponseRef(t, artifactRequest(api, raw, "upload"))
			}
		})
	}
}
