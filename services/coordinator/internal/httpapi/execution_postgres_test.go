package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"commongrid/coordinator/internal/artifact"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
	"commongrid/coordinator/internal/verification"
)

// Used only when the real pinned Trivy flags are absent. No model calls or
// independent verification pass is implied by this local scanner fixture.
type softwareDatabaseScanner struct{}

func (softwareDatabaseScanner) Scan(ctx context.Context, bundle *artifact.Bundle) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(bundle.Files) != 1 || (bundle.Files[0].Path != "src/search.ts" && bundle.Files[0].Path != "src/intervals.ts") || len(bundle.Files[0].Bytes) == 0 {
		return errors.New("software_scanner_fixture_rejected")
	}
	return nil
}

func databaseLeaseReceipt(t *testing.T, response *httptest.ResponseRecorder) store.Lease {
	t.Helper()
	databaseStatus(t, response, http.StatusOK)
	var receipt struct {
		Item             store.Lease `json:"item"`
		ExecutionEnabled bool        `json:"execution_enabled"`
		ServerTime       string      `json:"server_time"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.ExecutionEnabled || receipt.ServerTime == "" || receipt.Item.ID == "" {
		t.Fatal("missing scoped execution receipt", response.Body)
	}
	return receipt.Item
}

func TestPostgresPinnedExecutionHTTPLeaseAndUploadedReceipt(t *testing.T) {
	db, handler, verifier := databaseAPIWithExecution(t, []string{"software-bounds", "software-intervals"})
	ctx := context.Background()
	owner := databaseLogin(t, handler, "owner")
	worker := databaseLogin(t, handler, "worker")
	bounds := softwareTask(t, "software-bounds")
	intervals := softwareTask(t, "software-intervals")
	if err := db.CreateProject(ctx, bounds.ProjectId, owner.user, 10000000, 1200); err != nil {
		t.Fatal(err)
	}
	for _, task := range []contract.TaskContract{bounds, intervals} {
		if err := db.CreateNode(ctx, task.NodeId, task.ProjectId, nil, 10000000); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(task)
		if err := db.Publish(ctx, raw); err != nil {
			t.Fatal(err)
		}
	}
	response := databaseRequest(handler, worker, "GET", "/api/v1/tasks", "")
	databaseStatus(t, response, 200)
	if !strings.Contains(response.Body.String(), `"execution_enabled":false`) || !strings.Contains(response.Body.String(), `"software-bounds":{"task_version":1`) || !strings.Contains(response.Body.String(), `"software-intervals":{"task_version":1`) {
		t.Fatal(response.Body)
	}
	payload := reservePayload(bounds)
	reservePath := "/api/v1/tasks/" + bounds.Id + "/leases"
	databaseStatus(t, databaseRequest(handler, databaseBrowser{}, "POST", reservePath, payload), 401)
	noCSRF := worker
	noCSRF.csrf = ""
	databaseStatus(t, databaseRequest(handler, noCSRF, "POST", reservePath, payload), 403)
	databaseStatus(t, databaseRequest(handler, worker, "POST", reservePath, strings.TrimSuffix(payload, "}")+`,"user_id":"attacker"}`), 400)
	lease := databaseLeaseReceipt(t, databaseRequest(handler, worker, "POST", reservePath, payload))
	if lease.UserID != worker.user || lease.State != "reserved" || lease.EffectiveLimitSec != 1200 {
		t.Fatal(lease)
	}
	replay := databaseLeaseReceipt(t, databaseRequest(handler, worker, "POST", reservePath, payload))
	if replay.ID != lease.ID {
		t.Fatal("reserve retry changed lease")
	}
	databaseStatus(t, databaseRequest(handler, worker, "POST", reservePath, strings.Replace(payload, "reserve-key", "another-reserve-key", 1)), 429)
	startPath := "/api/v1/leases/" + lease.ID + "/start"
	heartbeatPath := "/api/v1/leases/" + lease.ID + "/heartbeat"
	databaseStatus(t, databaseRequest(handler, owner, "POST", startPath, `{}`), 404)
	databaseStatus(t, databaseRequest(handler, worker, "POST", heartbeatPath, `{}`), 409)
	active := databaseLeaseReceipt(t, databaseRequest(handler, worker, "POST", startPath, `{}`))
	if active.State != "active" || active.StartedAt == nil {
		t.Fatal(active)
	}
	heartbeat := databaseLeaseReceipt(t, databaseRequest(handler, worker, "POST", heartbeatPath, `{}`))
	if heartbeat.State != "active" || !heartbeat.ExpiresAt.Equal(lease.ExpiresAt) || heartbeat.ReservedMs != lease.ReservedMs || heartbeat.SpentMs != 0 {
		t.Fatal("heartbeat renewed or altered accounting", heartbeat)
	}
	databaseStatus(t, databaseRequest(handler, owner, "POST", heartbeatPath, `{}`), 404)

	// Rebind the checked-in deterministic worker ZIP's actual candidate bytes
	// to the newly allocated server lease. All bytes go through the live scan
	// and vault, then SubmitUploaded; a local pass is never a domain verdict.
	golden, err := os.ReadFile("../artifact/testdata/software-result-bundle.zip")
	if err != nil {
		t.Fatal(err)
	}
	var oldBinding artifact.Binding
	rawBinding, err := os.ReadFile("../artifact/testdata/software-result-binding.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(rawBinding, &oldBinding); err != nil {
		t.Fatal(err)
	}
	bundle, err := artifact.Validate(golden, bounds, oldBinding)
	if err != nil {
		t.Fatal(err)
	}
	binding := artifact.Binding{Purpose: "result", TaskID: bounds.Id, TaskVersion: bounds.TaskVersion, ContractHash: bounds.ContractHash, LeaseID: lease.ID, BaseCommit: bounds.Workspace.Commit, StrategyID: lease.StrategyID}
	uploadBytes, err := artifact.Encode(binding, map[string][]byte{bundle.Files[0].Path: bundle.Files[0].Bytes})
	if err != nil {
		t.Fatal(err)
	}
	databaseStatus(t, databaseUploadRequest(handler, owner, lease.ID, "result", "software-upload", uploadBytes), 404)
	upload := databaseUploadRequest(handler, worker, lease.ID, "result", "software-upload", uploadBytes)
	databaseStatus(t, upload, 200)
	var artifactReceipt struct {
		Item store.ArtifactRef `json:"item"`
	}
	if err = json.Unmarshal(upload.Body.Bytes(), &artifactReceipt); err != nil {
		t.Fatal(err)
	}
	resultPayload, _ := json.Marshal(map[string]any{"task_version": bounds.TaskVersion, "contract_hash": bounds.ContractHash, "request_key": "software-result", "base_commit": bounds.Workspace.Commit, "artifact": artifactReceipt.Item})
	resultPath := "/api/v1/leases/" + lease.ID + "/result"
	databaseStatus(t, databaseRequest(handler, owner, "POST", resultPath, string(resultPayload)), 404)
	result := databaseRequest(handler, worker, "POST", resultPath, string(resultPayload))
	databaseStatus(t, result, 200)
	var submission struct {
		Item store.Submission `json:"item"`
	}
	if err = json.Unmarshal(result.Body.Bytes(), &submission); err != nil {
		t.Fatal(err)
	}
	if submission.Item.Status != "submitted" || submission.Item.UserID != worker.user || submission.Item.LeaseID != lease.ID {
		t.Fatal("local result became trusted verdict", submission)
	}
	resultReplay := databaseRequest(handler, worker, "POST", resultPath, string(resultPayload))
	databaseStatus(t, resultReplay, 200)
	if resultReplay.Body.String() != result.Body.String() {
		t.Fatal("result replay differs")
	}
	completed, err := db.Lease(ctx, worker.user, lease.ID)
	if err != nil || completed.State != "completed" || completed.EndedAt == nil || completed.SpentMs > completed.ReservedMs {
		t.Fatal("receipt did not settle lease", completed, err)
	}
	databaseStatus(t, databaseRequest(handler, worker, "POST", heartbeatPath, `{}`), 409)
	if _, err = verifier.Submission(ctx, submission.Item.ID); !errors.Is(err, verification.ErrHarness) {
		t.Fatal("unsupported central harness adopted local pass", err)
	}
	receipt, err := db.Submission(ctx, worker.user, submission.Item.ID)
	if err != nil || receipt.Status != "submitted" {
		t.Fatal("unavailable harness changed receipt", receipt, err)
	}

	// The second exact approved task shares the lifecycle, and stopped leases
	// keep heartbeat state visible without renewal until explicitly settled.
	lease2 := databaseLeaseReceipt(t, databaseRequest(handler, worker, "POST", "/api/v1/tasks/"+intervals.Id+"/leases", strings.Replace(reservePayload(intervals), "reserve-key", "intervals-reserve-key", 1)))
	databaseLeaseReceipt(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease2.ID+"/start", `{}`))
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease2.ID+"/stop", `{}`), 200)
	stopping := databaseLeaseReceipt(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease2.ID+"/heartbeat", `{}`))
	if stopping.State != "stop_requested" || !stopping.ExpiresAt.Equal(lease2.ExpiresAt) {
		t.Fatal(stopping)
	}
	databaseStatus(t, databaseRequest(handler, worker, "POST", "/api/v1/leases/"+lease2.ID+"/end", `{"reason":"stopped"}`), 200)
}
