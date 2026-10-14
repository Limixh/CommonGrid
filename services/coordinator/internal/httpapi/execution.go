package httpapi

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"time"

	"commongrid/coordinator/internal/catalog"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
)

const executionMaxLimitSec int64 = 1200

type executionRepository interface {
	Reserve(context.Context, store.ReserveRequest) (store.Lease, error)
	Start(context.Context, string, string) (store.Lease, error)
	Heartbeat(context.Context, string, string) (store.Lease, error)
}

// ExecutionCapability describes only the exact approved contract. The global
// execution_enabled flag remains false; consumers must match each task's pins.
type ExecutionCapability struct {
	TaskVersion  int64    `json:"task_version"`
	ContractHash string   `json:"contract_hash"`
	BaseCommit   string   `json:"base_commit"`
	MaxLimitSec  int64    `json:"max_limit_sec"`
	Strategies   []string `json:"strategies"`
}

func configuredExecution(repo Repository, options Config) (map[string]contract.TaskContract, error) {
	approved := map[string]contract.TaskContract{}
	if len(options.ExecutionContracts) == 0 {
		return approved, nil
	}
	public, err := url.Parse(options.PublicURL)
	if err != nil || public == nil || !options.Development || !options.Artifacts.ready() {
		return nil, store.ErrInvalid
	}
	ip := net.ParseIP(public.Hostname())
	if public.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, store.ErrInvalid
	}
	if _, ok := repo.(executionRepository); !ok {
		return nil, store.ErrInvalid
	}
	if _, ok := repo.(uploadedRepository); !ok {
		return nil, store.ErrInvalid
	}
	fixtures, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	for _, id := range options.ExecutionContracts {
		if id != "software-bounds" && id != "software-intervals" {
			return nil, store.ErrInvalid
		}
		if _, exists := approved[id]; exists {
			return nil, store.ErrInvalid
		}
		for _, task := range fixtures.Tasks {
			if task.Id == id {
				approved[id] = task
			}
		}
		if _, exists := approved[id]; !exists {
			return nil, store.ErrInvalid
		}
	}
	return approved, nil
}

func (a *liveAPI) pinnedExecution(record store.TaskRecord) bool {
	expected, exists := a.execution[record.Contract.Id]
	if !exists || !reflect.DeepEqual(expected, record.Contract) {
		return false
	}
	// Revalidate the server's stored contract, including its computed hash.
	raw, err := json.Marshal(record.Contract)
	if err != nil {
		return false
	}
	_, err = a.validator.Task(raw)
	return err == nil
}

func (a *liveAPI) executionCapability(record store.TaskRecord) (ExecutionCapability, bool) {
	if (record.Status != "open" && record.Status != "resumable") || !a.pinnedExecution(record) {
		return ExecutionCapability{}, false
	}
	strategies := make([]string, 0, len(record.Contract.Strategies))
	for _, strategy := range record.Contract.Strategies {
		strategies = append(strategies, strategy.Id)
	}
	return ExecutionCapability{TaskVersion: record.Contract.TaskVersion, ContractHash: record.Contract.ContractHash, BaseCommit: record.Contract.Workspace.Commit, MaxLimitSec: min(executionMaxLimitSec, record.Contract.Environment.TimeLimitSec), Strategies: strategies}, true
}

func executionPending(w http.ResponseWriter) {
	write(w, 409, map[string]any{"code": "isolation_gate_pending", "execution_enabled": false})
}

func executionItem(w http.ResponseWriter, value store.Lease, err error) {
	if err != nil {
		apiError(w, err)
		return
	}
	write(w, 200, map[string]any{"source": "database", "execution_enabled": true, "server_time": time.Now().UTC(), "item": value})
}

func (a *liveAPI) mountExecution(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/tasks/{id}/leases", a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
		if _, exists := a.execution[r.PathValue("id")]; !exists {
			executionPending(w)
			return
		}
		var dto struct {
			TaskVersion  int64  `json:"task_version"`
			ContractHash string `json:"contract_hash"`
			StrategyID   string `json:"strategy_id"`
			RequestKey   string `json:"request_key"`
			LimitSec     int64  `json:"limit_sec"`
		}
		if err := body(r, &dto); err != nil {
			apiError(w, err)
			return
		}
		if dto.TaskVersion < 1 || !apiHash.MatchString(dto.ContractHash) || !apiID.MatchString(dto.StrategyID) || !apiID.MatchString(dto.RequestKey) || dto.LimitSec < 1 || dto.LimitSec > executionMaxLimitSec {
			apiError(w, store.ErrInvalid)
			return
		}
		record, err := a.repo.Task(r.Context(), r.PathValue("id"))
		if err != nil {
			apiError(w, err)
			return
		}
		if !a.pinnedExecution(record) {
			executionPending(w)
			return
		}
		if dto.TaskVersion != record.Contract.TaskVersion || dto.ContractHash != record.Contract.ContractHash {
			apiError(w, store.ErrStale)
			return
		}
		strategyFound := false
		for _, strategy := range record.Contract.Strategies {
			if strategy.Id == dto.StrategyID {
				strategyFound = true
			}
		}
		if !strategyFound {
			apiError(w, store.ErrInvalid)
			return
		}
		// Reserve performs the authoritative locked status/capacity/budget check,
		// while preserving idempotent retries after a receipt closes the task.
		value, err := a.repo.(executionRepository).Reserve(r.Context(), store.ReserveRequest{UserID: user, TaskID: record.Contract.Id, TaskVersion: dto.TaskVersion, ContractHash: dto.ContractHash, StrategyID: dto.StrategyID, RequestKey: dto.RequestKey, LimitSec: dto.LimitSec})
		executionItem(w, value, err)
	}))
	for _, operation := range []string{"start", "heartbeat"} {
		mux.HandleFunc("POST /api/v1/leases/{id}/"+operation, a.secured(func(w http.ResponseWriter, r *http.Request, user string) {
			if len(a.execution) == 0 {
				executionPending(w)
				return
			}
			var dto struct{}
			if err := body(r, &dto); err != nil {
				apiError(w, err)
				return
			}
			lease, err := a.repo.Lease(r.Context(), user, r.PathValue("id"))
			if err != nil {
				apiError(w, err)
				return
			}
			record, err := a.repo.Task(r.Context(), lease.TaskID)
			if err != nil {
				apiError(w, err)
				return
			}
			if !a.pinnedExecution(record) {
				executionPending(w)
				return
			}
			if lease.TaskVersion != record.Contract.TaskVersion || lease.ContractHash != record.Contract.ContractHash {
				apiError(w, store.ErrStale)
				return
			}
			repo := a.repo.(executionRepository)
			var value store.Lease
			if operation == "start" {
				value, err = repo.Start(r.Context(), user, lease.ID)
			} else {
				value, err = repo.Heartbeat(r.Context(), user, lease.ID)
			}
			executionItem(w, value, err)
		}))
	}
}
