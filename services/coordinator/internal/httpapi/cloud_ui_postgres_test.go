package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
)

// OAuth identity exchange, scanner and verifier are explicit local fixtures.
// Catalog pages, session ownership, vault bytes, receipts and checkpoint
// compatibility pass through the production HTTP handler and real PostgreSQL.
// No CLI, model, paid API or task shell command is invoked by this test.
func TestPostgresCloudContributionAndCatalog(t *testing.T) {
	db, handler, verifier := databaseAPI(t)
	ctx := context.Background()
	owner := databaseLogin(t, handler, "owner")
	worker := databaseLogin(t, handler, "worker")
	task := databaseTask(t, db, owner.user)
	taskIDs := []string{task.Id}
	for i := 0; i < 64; i++ {
		// Round-trip to avoid sharing mutable slices with the base contract.
		raw, err := json.Marshal(task)
		if err != nil {
			t.Fatal(err)
		}
		var paged contract.TaskContract
		if err := json.Unmarshal(raw, &paged); err != nil {
			t.Fatal(err)
		}
		paged.Id = fmt.Sprintf("zz-page-%03d", i)
		paged.Title = fmt.Sprintf("Cloud catalog task %03d", i)
		paged.DependsOn = []string{}
		if i == 0 {
			paged.DependsOn = []string{"zz-page-063"}
		}
		raw, err = json.Marshal(paged)
		if err != nil {
			t.Fatal(err)
		}
		paged.ContractHash, err = contract.ComputeHash(raw)
		if err != nil {
			t.Fatal(err)
		}
		raw, err = json.Marshal(paged)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Publish(ctx, raw); err != nil {
			t.Fatalf("publish catalog task %s: %v", paged.Id, err)
		}
		taskIDs = append(taskIDs, paged.Id)
	}

	lease, err := db.Reserve(ctx, store.ReserveRequest{UserID: worker.user, TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, StrategyID: task.Strategies[0].Id, RequestKey: "cloud-ui-lease", LimitSec: 120})
	if err != nil {
		t.Fatal(err)
	}
	lease, err = db.Start(ctx, worker.user, lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	checkpointArtifact := databaseUpload(t, handler, worker, task, lease, "checkpoint", "cloud-ui-checkpoint-upload")
	checkpoint := contract.Checkpoint{
		SchemaVersion: "1.0", CheckpointId: "cloud-ui-checkpoint", TaskId: task.Id,
		TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, LeaseId: lease.ID,
		Type: "hard", BaseCommit: task.Workspace.Commit, ArtifactSha256: checkpointArtifact.SHA256,
		Summary:                  strings.Repeat("😀", 2100) + strings.Repeat("longword", 200),
		ContinuationInstructions: strings.Repeat("🧭", 12001) + " Continue from the saved lemma. " + strings.Repeat("continuation", 200),
	}
	payload, err := json.Marshal(map[string]any{"checkpoint": checkpoint, "artifact": checkpointArtifact, "request_key": "cloud-ui-checkpoint"})
	if err != nil {
		t.Fatal(err)
	}
	databaseStatus(t, databaseRequest(handler, worker, http.MethodPost, "/api/v1/leases/"+lease.ID+"/checkpoint", string(payload)), http.StatusOK)
	verifiedCheckpoint, err := verifier.Checkpoint(ctx, checkpoint.CheckpointId)
	if err != nil || verifiedCheckpoint.Status != "usable" || verifiedCheckpoint.Metadata.Summary != checkpoint.Summary || verifiedCheckpoint.Artifact != checkpointArtifact {
		t.Fatalf("checkpoint verification or byte binding failed: %v", err)
	}
	resultArtifact := databaseUpload(t, handler, worker, task, lease, "result", "cloud-ui-result-upload")
	payload, err = json.Marshal(map[string]any{"task_version": task.TaskVersion, "contract_hash": task.ContractHash, "base_commit": task.Workspace.Commit, "artifact": resultArtifact, "request_key": "cloud-ui-submission"})
	if err != nil {
		t.Fatal(err)
	}
	submitted := databaseRequest(handler, worker, http.MethodPost, "/api/v1/leases/"+lease.ID+"/result", string(payload))
	databaseStatus(t, submitted, http.StatusOK)
	var submission struct {
		Item store.Submission `json:"item"`
	}
	if err := json.Unmarshal(submitted.Body.Bytes(), &submission); err != nil {
		t.Fatal(err)
	}
	verifiedSubmission, err := verifier.Submission(ctx, submission.Item.ID)
	if err != nil || verifiedSubmission.Status != "verified_candidate" || verifiedSubmission.Artifact != resultArtifact {
		t.Fatalf("submission verification or byte binding failed: %v", err)
	}

	validator, err := contract.NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool)
	after := ""
	for page, expectedSize := range []int{50, 15} {
		path := "/api/v1/tasks"
		if after != "" {
			path += "?after=" + after
		}
		response := databaseRequest(handler, worker, http.MethodGet, path, "")
		databaseStatus(t, response, http.StatusOK)
		var envelope struct {
			Source           string                  `json:"source"`
			ExecutionEnabled bool                    `json:"execution_enabled"`
			Items            []contract.TaskContract `json:"items"`
			Statuses         map[string]string       `json:"statuses"`
			NextCursor       string                  `json:"next_cursor"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Source != "database" || envelope.ExecutionEnabled || len(envelope.Items) != expectedSize || len(envelope.Statuses) != expectedSize {
			t.Fatalf("page %d source/size/status map mismatch", page+1)
		}
		for index, item := range envelope.Items {
			want := taskIDs[len(seen)]
			if seen[item.Id] || item.Id != want {
				t.Fatalf("page %d index %d is duplicate or out of order", page+1, index)
			}
			seen[item.Id] = true
			raw, err := json.Marshal(item)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := validator.Task(raw); err != nil {
				t.Fatalf("page task %s does not validate: %v", item.Id, err)
			}
			expectedStatus := "open"
			if item.Id == task.Id {
				expectedStatus = "awaiting_review"
			}
			if envelope.Statuses[item.Id] != expectedStatus {
				t.Fatalf("task %s status is not authoritative", item.Id)
			}
			if item.Id == "zz-page-000" && (len(item.DependsOn) != 1 || item.DependsOn[0] != "zz-page-063") {
				t.Fatal("cross-page dependency lost")
			}
		}
		if page == 0 && envelope.NextCursor != "zz-page-048" || page == 1 && envelope.NextCursor != "" {
			t.Fatal("unexpected default pagination cursor")
		}
		after = envelope.NextCursor
	}
	if len(seen) != 65 {
		t.Fatal("catalog did not contain all 65 records")
	}

	for _, entry := range []struct{ path, id string }{
		{"/api/v1/leases/", lease.ID},
		{"/api/v1/submissions/", submission.Item.ID},
		{"/api/v1/checkpoints/", checkpoint.CheckpointId},
	} {
		response := databaseRequest(handler, worker, http.MethodGet, entry.path+entry.id, "")
		databaseStatus(t, response, http.StatusOK)
		if !strings.Contains(response.Body.String(), entry.id) {
			t.Fatal("detail did not contain its receipt id")
		}
		switch entry.path {
		case "/api/v1/leases/":
			var detail struct {
				Item store.Lease `json:"item"`
			}
			if json.Unmarshal(response.Body.Bytes(), &detail) != nil || detail.Item.ID != lease.ID || detail.Item.AttemptID != lease.AttemptID || detail.Item.StrategyID != lease.StrategyID || detail.Item.State != "completed" || detail.Item.StartedAt == nil || detail.Item.EndedAt == nil || detail.Item.ReservedMs <= 0 {
				t.Fatal("lease detail lost authoritative state or time capacity")
			}
		case "/api/v1/submissions/":
			var detail struct {
				Item store.Submission `json:"item"`
			}
			if json.Unmarshal(response.Body.Bytes(), &detail) != nil || detail.Item.ID != submission.Item.ID || detail.Item.Status != "verified_candidate" || detail.Item.VerifiedAt == nil || detail.Item.Artifact != resultArtifact || detail.Item.BaseCommit != task.Workspace.Commit {
				t.Fatal("submission detail lost verification or artifact binding")
			}
		case "/api/v1/checkpoints/":
			var detail struct {
				Item store.CheckpointRecord `json:"item"`
			}
			if json.Unmarshal(response.Body.Bytes(), &detail) != nil || detail.Item.Metadata.CheckpointId != checkpoint.CheckpointId || detail.Item.Metadata.Summary != checkpoint.Summary || detail.Item.Metadata.ContinuationInstructions != checkpoint.ContinuationInstructions || detail.Item.Status != "usable" || detail.Item.VerifiedAt == nil || detail.Item.Artifact != checkpointArtifact {
				t.Fatal("checkpoint detail lost Unicode text or verification binding")
			}
		}
		databaseStatus(t, databaseRequest(handler, owner, http.MethodGet, entry.path+entry.id, ""), http.StatusNotFound)
		databaseStatus(t, databaseRequest(handler, databaseBrowser{}, http.MethodGet, entry.path+entry.id, ""), http.StatusUnauthorized)
	}
	for _, kind := range []string{"leases", "submissions", "checkpoints"} {
		response := databaseRequest(handler, worker, http.MethodGet, "/api/v1/me/"+kind, "")
		databaseStatus(t, response, http.StatusOK)
		var records struct {
			Items []json.RawMessage `json:"items"`
		}
		if json.Unmarshal(response.Body.Bytes(), &records) != nil || len(records.Items) != 1 {
			t.Fatal("worker contribution list missing its real receipt")
		}
		response = databaseRequest(handler, owner, http.MethodGet, "/api/v1/me/"+kind, "")
		databaseStatus(t, response, http.StatusOK)
		if json.Unmarshal(response.Body.Bytes(), &records) != nil || len(records.Items) != 0 {
			t.Fatal("owner contribution list exposed another account's receipt")
		}
	}
	resumePath := "/api/v1/tasks/task/resume?task_version=1&contract_hash=" + task.ContractHash + "&base_commit=" + task.Workspace.Commit + "&strategy_id=" + lease.StrategyID
	resume := databaseRequest(handler, worker, http.MethodGet, resumePath, "")
	databaseStatus(t, resume, http.StatusOK)
	var resumed struct {
		Item store.CheckpointRecord `json:"item"`
	}
	if json.Unmarshal(resume.Body.Bytes(), &resumed) != nil || resumed.Item.Metadata.CheckpointId != checkpoint.CheckpointId || resumed.Item.Metadata.ContinuationInstructions != checkpoint.ContinuationInstructions || resumed.Item.Status != "usable" {
		t.Fatal("resume did not preserve the compatible verified checkpoint")
	}
	databaseStatus(t, databaseRequest(handler, owner, http.MethodGet, resumePath, ""), http.StatusNotFound)

	if ready := os.Getenv("CG_CLOUD_UI_READY_FILE"); ready != "" {
		serveCloudUIFixture(t, handler, worker, ready, taskIDs, lease.ID, checkpoint.CheckpointId, submission.Item.ID)
	}
}

// The optional native acceptance transport keeps a fixture worker cookie only
// in memory. It exposes production read handlers; OAuth mutation endpoints,
// writes, uploads and artifact byte access are not part of this transport.
func serveCloudUIFixture(t *testing.T, handler http.Handler, worker databaseBrowser, ready string, taskIDs []string, leaseID, checkpointID, submissionID string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			write(w, http.StatusMethodNotAllowed, map[string]string{"code": "read_only_fixture"})
			return
		}
		path := r.URL.Path
		allowed := path == "/health" || path == "/api/v1/auth/session" || path == "/api/v1/auth/providers" || path == "/api/v1/projects" || path == "/api/v1/tasks"
		for _, prefix := range []string{"/api/v1/tasks/", "/api/v1/leases/", "/api/v1/submissions/", "/api/v1/checkpoints/", "/api/v1/me/"} {
			allowed = allowed || strings.HasPrefix(path, prefix)
		}
		if !allowed {
			write(w, http.StatusNotFound, map[string]string{"code": "not_found"})
			return
		}
		request := r.Clone(r.Context())
		request.Method = http.MethodGet // net/http still suppresses HEAD response bytes.
		request.Host = "127.0.0.1:8787"
		request.Header.Del("Cookie")
		request.AddCookie(worker.cookie)
		request.Header.Set("Origin", "http://127.0.0.1:1420")
		handler.ServeHTTP(w, request)
	}))
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	response, err := client.Get(server.URL + "/api/v1/tasks")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || len(response.Cookies()) != 0 {
		response.Body.Close()
		t.Fatal("native fixture transport failed or exposed a cookie")
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		request, err := http.NewRequest(method, server.URL+"/api/v1/auth/logout", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusMethodNotAllowed {
			t.Fatal("native fixture allowed a write")
		}
	}
	metadata := struct {
		URL          string   `json:"url"`
		TaskIDs      []string `json:"taskIDs"`
		Count        int      `json:"count"`
		CheckpointID string   `json:"checkpointID"`
		SubmissionID string   `json:"submissionID"`
		LeaseID      string   `json:"leaseID"`
	}{server.URL, taskIDs, len(taskIDs), checkpointID, submissionID, leaseID}
	raw, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{worker.cookie.Value, worker.csrf, worker.user} {
		if secret == "" || strings.Contains(string(raw), secret) {
			t.Fatal("ready metadata must not contain account secrets")
		}
	}
	staged := ready + ".tmp"
	if err := os.WriteFile(staged, raw, 0600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(staged)
	if err := os.Rename(staged, ready); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(ready)
	t.Log("Read-only cloud UI database fixture ready; waiting for native acceptance stop file")
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(25 * time.Minute)
	defer timeout.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(ready + ".stop"); err == nil {
				return
			} else if !os.IsNotExist(err) {
				t.Fatal(err)
			}
		case <-timeout.C:
			t.Fatal("native acceptance did not stop the cloud UI fixture within 25 minutes")
		}
	}
}
