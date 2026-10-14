package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"commongrid/coordinator/internal/catalog"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
)

type executionTestRepository struct {
	artifactTestRepository
	reserve   store.ReserveRequest
	mutations int
}

func (s *executionTestRepository) Reserve(_ context.Context, request store.ReserveRequest) (store.Lease, error) {
	s.mutations++
	s.reserve = request
	return s.lease, s.err
}
func (s *executionTestRepository) Start(_ context.Context, user, id string) (store.Lease, error) {
	s.mutations++
	s.user, s.id = user, id
	return s.lease, s.err
}
func (s *executionTestRepository) Heartbeat(ctx context.Context, user, id string) (store.Lease, error) {
	return s.Start(ctx, user, id)
}
func (s *executionTestRepository) ListTasks(context.Context, string, int, string) ([]store.TaskRecord, error) {
	return []store.TaskRecord{s.task}, nil
}

func softwareTask(t *testing.T, id string) contract.TaskContract {
	t.Helper()
	fixtures, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range fixtures.Tasks {
		if task.Id == id {
			return task
		}
	}
	t.Fatal("missing pinned task")
	return contract.TaskContract{}
}

func executionFixture(t *testing.T) (http.Handler, *executionTestRepository) {
	t.Helper()
	task := softwareTask(t, "software-bounds")
	repo := &executionTestRepository{artifactTestRepository: artifactTestRepository{task: store.TaskRecord{Contract: task, Status: "open"}, lease: store.Lease{ID: "lease", UserID: "server-user", TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, StrategyID: "invariant", State: "active"}}}
	api, err := newAuthenticated(repo, &testSessions{user: "server-user"}, Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Artifacts: testArtifactService(), ExecutionContracts: []string{task.Id}})
	if err != nil {
		t.Fatal(err)
	}
	return api, repo
}

func reservePayload(task contract.TaskContract) string {
	raw, _ := json.Marshal(map[string]any{"task_version": task.TaskVersion, "contract_hash": task.ContractHash, "strategy_id": task.Strategies[0].Id, "request_key": "reserve-key", "limit_sec": 1200})
	return string(raw)
}

func TestPinnedExecutionCapabilityAndSessionOwnedMutations(t *testing.T) {
	api, repo := executionFixture(t)
	for _, path := range []string{"/api/v1/tasks", "/api/v1/tasks/software-bounds"} {
		response := liveRequest(api, "GET", path, "", nil)
		if response.Code != 200 || !strings.Contains(response.Body.String(), `"execution_enabled":false`) || !strings.Contains(response.Body.String(), `"software-bounds":{"task_version":1`) {
			t.Fatal(response.Code, response.Body)
		}
	}
	response := liveRequest(api, "POST", "/api/v1/tasks/software-bounds/leases", reservePayload(repo.task.Contract), nil)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"execution_enabled":true`) || repo.reserve.UserID != "server-user" || repo.reserve.LimitSec != 1200 {
		t.Fatal(response.Code, response.Body, repo.reserve)
	}
	for _, operation := range []string{"start", "heartbeat"} {
		response = liveRequest(api, "POST", "/api/v1/leases/lease/"+operation, `{}`, nil)
		if response.Code != 200 || repo.user != "server-user" || repo.id != "lease" || !strings.Contains(response.Body.String(), `"server_time":`) {
			t.Fatal(response.Code, response.Body)
		}
	}
}

func TestPinnedExecutionRejectsUntrustedBodiesAndPinsBeforeMutation(t *testing.T) {
	api, repo := executionFixture(t)
	good := reservePayload(repo.task.Contract)
	for _, payload := range []string{
		strings.Replace(good, `"limit_sec":1200`, `"limit_sec":1201`, 1),
		strings.Replace(good, `"limit_sec":1200`, `"limit_sec":0`, 1),
		strings.Replace(good, `"limit_sec":1200`, `"limit_sec":1.5`, 1),
		strings.Replace(good, `"strategy_id":"invariant"`, `"strategy_id":"untrusted"`, 1),
		strings.TrimSuffix(good, "}") + `,"user_id":"attacker"}`,
		strings.TrimSuffix(good, "}") + `,"command":"run arbitrary"}`,
		strings.TrimSuffix(good, "}") + `,"limit_sec":1}`,
		strings.Replace(good, "task_version", "Task_Version", 1),
	} {
		response := liveRequest(api, "POST", "/api/v1/tasks/software-bounds/leases", payload, nil)
		if response.Code != 400 || repo.mutations != 0 {
			t.Fatal(response.Code, response.Body, payload)
		}
	}
	for _, operation := range []string{"start", "heartbeat"} {
		for _, payload := range []string{`{"user_id":"attacker"}`, `{"expires_at":"2099-01-01"}`, `{"passed":true}`} {
			response := liveRequest(api, "POST", "/api/v1/leases/lease/"+operation, payload, nil)
			if response.Code != 400 || repo.mutations != 0 {
				t.Fatal(response.Code, response.Body)
			}
		}
		response := liveRequest(api, "POST", "/api/v1/leases/lease/"+operation, `{}`, func(r *http.Request) { r.Header.Del("X-CSRF-Token") })
		if response.Code != 403 || repo.mutations != 0 {
			t.Fatal(response.Code, response.Body)
		}
	}
	response := liveRequest(api, "POST", "/api/v1/tasks/software-intervals/leases", `{}`, nil)
	if response.Code != 409 || repo.mutations != 0 {
		t.Fatal(response.Code, response.Body)
	}
	repo.task.Contract.Verification.ServerCommand = "untrusted command"
	response = liveRequest(api, "POST", "/api/v1/tasks/software-bounds/leases", good, nil)
	if response.Code != 409 || repo.mutations != 0 {
		t.Fatal(response.Code, response.Body)
	}
	response = liveRequest(api, "GET", "/api/v1/tasks/software-bounds", "", nil)
	if !strings.Contains(response.Body.String(), `"execution_capabilities":{}`) {
		t.Fatal(response.Body)
	}
}

func TestExecutionCapabilitiesHideClosedAndRejectStaleLease(t *testing.T) {
	api, repo := executionFixture(t)
	repo.task.Status = "accepted"
	response := liveRequest(api, "GET", "/api/v1/tasks/software-bounds", "", nil)
	if !strings.Contains(response.Body.String(), `"execution_capabilities":{}`) {
		t.Fatal(response.Body)
	}
	repo.task.Status = "open"
	repo.lease.ContractHash = strings.Repeat("a", 64)
	response = liveRequest(api, "POST", "/api/v1/leases/lease/start", `{}`, nil)
	if response.Code != 409 || !strings.Contains(response.Body.String(), "stale_contract") || repo.mutations != 0 {
		t.Fatal(response.Code, response.Body)
	}
	repo.lease.UserID = "another-user"
	response = liveRequest(api, "POST", "/api/v1/leases/lease/heartbeat", `{}`, nil)
	if response.Code != 404 || repo.mutations != 0 {
		t.Fatal(response.Code, response.Body)
	}
}

func TestExecutionConfigFailsClosed(t *testing.T) {
	_, repo := executionFixture(t)
	options := Config{PublicURL: "http://127.0.0.1:8787", UIOrigin: "http://127.0.0.1:1420", Development: true, Artifacts: testArtifactService(), ExecutionContracts: []string{"software-bounds"}}
	for _, change := range []func(*Config){
		func(c *Config) { c.Development = false },
		func(c *Config) { c.PublicURL = "https://coordinator.example" },
		func(c *Config) { c.Artifacts = nil },
		func(c *Config) { c.ExecutionContracts = []string{"software-bounds", "software-bounds"} },
		func(c *Config) { c.ExecutionContracts = []string{"unknown"} },
	} {
		invalid := options
		change(&invalid)
		if _, err := configuredExecution(repo, invalid); err == nil {
			t.Fatal("unsafe execution config accepted")
		}
	}
}
