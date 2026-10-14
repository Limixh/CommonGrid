package store

import (
	"context"
	"encoding/json"
	"time"

	"commongrid/coordinator/internal/contract"
	"github.com/jackc/pgx/v5"
)

const liveStates = "('reserved','active','stop_requested')"
const leaseColumns = `id,attempt_id,user_id,task_id,task_version,contract_hash,strategy_id,state,effective_limit_sec,reserved_ms,spent_ms,overrun_ms,created_at,expires_at,started_at,stop_requested_at,ended_at`

func scanLease(row pgx.Row) (Lease, error) {
	var lease Lease
	err := row.Scan(&lease.ID, &lease.AttemptID, &lease.UserID, &lease.TaskID, &lease.TaskVersion, &lease.ContractHash, &lease.StrategyID, &lease.State, &lease.EffectiveLimitSec, &lease.ReservedMs, &lease.SpentMs, &lease.OverrunMs, &lease.CreatedAt, &lease.ExpiresAt, &lease.StartedAt, &lease.StopRequestedAt, &lease.EndedAt)
	if err == pgx.ErrNoRows {
		err = ErrNotFound
	}
	return lease, err
}
func (s *Store) Lease(ctx context.Context, userID, id string) (Lease, error) {
	if !validID.MatchString(userID) || !validID.MatchString(id) {
		return Lease{}, ErrInvalid
	}
	return scanLease(s.pool.QueryRow(ctx, "SELECT "+leaseColumns+" FROM leases WHERE id=$1 AND user_id=$2", id, userID))
}

// All lease mutations use: project account, ancestor accounts ordered by id,
// task row, user row, lease row. Scope identity/ancestry are immutable in SQL.
func lockScopes(ctx context.Context, tx pgx.Tx, project, node string) ([]string, error) {
	rows, err := tx.Query(ctx, `WITH RECURSIVE lineage AS (
        SELECT id,parent_id FROM nodes WHERE id=$2 AND project_id=$1
        UNION ALL SELECT n.id,n.parent_id FROM nodes n JOIN lineage l ON n.id=l.parent_id WHERE n.project_id=$1
    ) SELECT a.id FROM budget_accounts a WHERE a.project_id=$1
        AND (a.scope='project' OR a.node_id IN (SELECT id FROM lineage))
        ORDER BY CASE WHEN a.scope='project' THEN 0 ELSE 1 END,a.id FOR UPDATE OF a`, project, node)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var required int
	if err = tx.QueryRow(ctx, `WITH RECURSIVE lineage AS (
        SELECT id,parent_id FROM nodes WHERE id=$2 AND project_id=$1
        UNION ALL SELECT n.id,n.parent_id FROM nodes n JOIN lineage l ON n.id=l.parent_id WHERE n.project_id=$1
    ) SELECT 1+count(*) FROM lineage`, project, node).Scan(&required); err != nil {
		return nil, err
	}
	if len(ids) != required || len(ids) < 2 {
		return nil, ErrInvariant
	}
	return ids, nil
}

func lockTaskUser(ctx context.Context, tx pgx.Tx, taskID, userID string) (contract.TaskContract, int64, string, int, error) {
	var raw []byte
	var projectMax int64
	var status string
	var maxConcurrent int
	err := tx.QueryRow(ctx, `SELECT v.contract,p.max_attempt_sec,t.status FROM tasks t
        JOIN task_versions v ON (v.task_id,v.version,v.contract_hash)=(t.id,t.current_version,t.current_hash)
        JOIN projects p ON p.id=t.project_id WHERE t.id=$1 FOR UPDATE OF t`, taskID).Scan(&raw, &projectMax, &status)
	if err == pgx.ErrNoRows {
		return contract.TaskContract{}, 0, "", 0, ErrNotFound
	}
	if err != nil {
		return contract.TaskContract{}, 0, "", 0, err
	}
	var task contract.TaskContract
	if err = json.Unmarshal(raw, &task); err != nil {
		return task, 0, "", 0, err
	}
	err = tx.QueryRow(ctx, "SELECT max_concurrent FROM users WHERE id=$1 FOR UPDATE", userID).Scan(&maxConcurrent)
	if err == pgx.ErrNoRows {
		err = ErrNotFound
	}
	return task, projectMax, status, maxConcurrent, err
}

func (s *Store) Reserve(ctx context.Context, request ReserveRequest) (Lease, error) {
	if err := request.validate(); err != nil {
		return Lease{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Lease{}, err
	}
	defer rollback(tx)
	var project, node string
	if err = tx.QueryRow(ctx, "SELECT project_id,node_id FROM tasks WHERE id=$1", request.TaskID).Scan(&project, &node); err == pgx.ErrNoRows {
		return Lease{}, ErrNotFound
	} else if err != nil {
		return Lease{}, err
	}
	accounts, err := lockScopes(ctx, tx, project, node)
	if err != nil {
		return Lease{}, err
	}
	task, projectMax, status, maxConcurrent, err := lockTaskUser(ctx, tx, request.TaskID, request.UserID)
	if err != nil {
		return Lease{}, err
	}
	var existingID, fingerprint string
	err = tx.QueryRow(ctx, "SELECT id,request_hash FROM leases WHERE user_id=$1 AND request_key=$2", request.UserID, request.RequestKey).Scan(&existingID, &fingerprint)
	if err == nil {
		if fingerprint != request.fingerprint() {
			return Lease{}, ErrConflict
		}
		existing, err := scanLease(tx.QueryRow(ctx, "SELECT "+leaseColumns+" FROM leases WHERE id=$1", existingID))
		if err != nil {
			return Lease{}, err
		}
		return existing, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return Lease{}, err
	}
	if task.TaskVersion != request.TaskVersion || task.ContractHash != request.ContractHash {
		return Lease{}, ErrStale
	}
	if status != "open" && status != "resumable" {
		return Lease{}, ErrClosed
	}
	strategyFound := false
	for _, strategy := range task.Strategies {
		if strategy.Id == request.StrategyID {
			strategyFound = true
		}
	}
	if !strategyFound {
		return Lease{}, ErrInvalid
	}
	var userActive, taskActive, sameUser int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM leases WHERE user_id=$1 AND state IN "+liveStates, request.UserID).Scan(&userActive); err != nil {
		return Lease{}, err
	}
	if err = tx.QueryRow(ctx, "SELECT count(*),count(*) FILTER (WHERE user_id=$2) FROM leases WHERE task_id=$1 AND state IN "+liveStates, request.TaskID, request.UserID).Scan(&taskActive, &sameUser); err != nil {
		return Lease{}, err
	}
	if userActive >= maxConcurrent || taskActive >= int(task.Parallelism.Cap) || sameUser != 0 {
		return Lease{}, ErrCapacity
	}
	seconds := effectiveLimit(request.LimitSec, projectMax, task.Environment.TimeLimitSec)
	reservation := worstCaseMs(seconds)
	for _, account := range accounts {
		result, err := tx.Exec(ctx, "UPDATE budget_accounts SET reserved_ms=reserved_ms+$2 WHERE id=$1 AND limit_ms-spent_ms-reserved_ms >= $2", account, reservation)
		if err != nil {
			return Lease{}, err
		}
		if result.RowsAffected() != 1 {
			return Lease{}, ErrBudget
		}
	}
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return Lease{}, err
	}
	lease := Lease{ID: newID("lease-"), AttemptID: newID("attempt-"), UserID: request.UserID, TaskID: request.TaskID, TaskVersion: request.TaskVersion, ContractHash: request.ContractHash, StrategyID: request.StrategyID, State: "reserved", EffectiveLimitSec: seconds, ReservedMs: reservation, CreatedAt: now, ExpiresAt: now.Add(time.Duration(reservation) * time.Millisecond)}
	if _, err = tx.Exec(ctx, `INSERT INTO leases(id,attempt_id,user_id,task_id,task_version,contract_hash,strategy_id,request_key,request_hash,state,effective_limit_sec,reserved_ms,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, lease.ID, lease.AttemptID, lease.UserID, lease.TaskID, lease.TaskVersion, lease.ContractHash, lease.StrategyID, request.RequestKey, request.fingerprint(), lease.State, seconds, reservation, now, lease.ExpiresAt); err != nil {
		return Lease{}, err
	}
	for _, account := range accounts {
		if _, err = tx.Exec(ctx, "INSERT INTO lease_budgets(lease_id,account_id,reserved_ms) VALUES($1,$2,$3)", lease.ID, account, reservation); err != nil {
			return Lease{}, err
		}
	}
	if err = emit(ctx, tx, "lease.reserved", lease); err != nil {
		return Lease{}, err
	}
	return lease, tx.Commit(ctx)
}

func (s *Store) mutateLease(ctx context.Context, userID, id, operation string) (Lease, error) {
	if !validID.MatchString(userID) || !validID.MatchString(id) {
		return Lease{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Lease{}, err
	}
	defer rollback(tx)
	var taskID, project, node string
	if err = tx.QueryRow(ctx, "SELECT l.task_id,t.project_id,t.node_id FROM leases l JOIN tasks t ON t.id=l.task_id WHERE l.id=$1 AND l.user_id=$2", id, userID).Scan(&taskID, &project, &node); err == pgx.ErrNoRows {
		return Lease{}, ErrNotFound
	} else if err != nil {
		return Lease{}, err
	}
	if _, err = lockScopes(ctx, tx, project, node); err != nil {
		return Lease{}, err
	}
	task, _, taskStatus, _, err := lockTaskUser(ctx, tx, taskID, userID)
	if err != nil {
		return Lease{}, err
	}
	lease, err := scanLease(tx.QueryRow(ctx, "SELECT "+leaseColumns+" FROM leases WHERE id=$1 FOR UPDATE", id))
	if err != nil {
		return Lease{}, err
	}
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return Lease{}, err
	}
	ended := lease.State == "completed" || lease.State == "released" || lease.State == "expired"
	if ended {
		if operation == "start" || operation == "stop" || operation == "heartbeat" {
			return Lease{}, ErrClosed
		}
		return lease, tx.Commit(ctx)
	}
	var kind string
	switch operation {
	case "start":
		if task.TaskVersion != lease.TaskVersion || task.ContractHash != lease.ContractHash {
			return Lease{}, ErrStale
		}
		if taskStatus != "open" && taskStatus != "resumable" {
			return Lease{}, ErrClosed
		}
		if !now.Before(lease.ExpiresAt) {
			return Lease{}, ErrClosed
		}
		if lease.State == "active" {
			return lease, tx.Commit(ctx)
		}
		if lease.State != "reserved" || !now.Before(lease.ExpiresAt) {
			return Lease{}, ErrClosed
		}
		lease.State = "active"
		lease.StartedAt = &now
		kind = "lease.started"
	case "heartbeat":
		if task.TaskVersion != lease.TaskVersion || task.ContractHash != lease.ContractHash {
			return Lease{}, ErrStale
		}
		if taskStatus != "open" && taskStatus != "resumable" {
			return Lease{}, ErrClosed
		}
		if (lease.State != "active" && lease.State != "stop_requested") || !now.Before(lease.ExpiresAt) {
			return Lease{}, ErrClosed
		}
		// Heartbeats acknowledge ownership and current state. They never extend
		// the reservation or trust a client clock, reported usage or pass flag.
		return lease, tx.Commit(ctx)
	case "stop":
		if lease.State == "stop_requested" {
			return lease, tx.Commit(ctx)
		}
		lease.State = "stop_requested"
		lease.StopRequestedAt = &now
		kind = "lease.stop_requested"
	case "stopped", "completed", "expired":
		state := "released"
		if operation == "completed" {
			state = "completed"
		}
		if operation == "expired" {
			state = "expired"
		}
		lease, err = finishLease(ctx, tx, lease, now, state)
		if err != nil {
			return Lease{}, err
		}
		return lease, tx.Commit(ctx)
	default:
		return Lease{}, ErrInvalid
	}
	if _, err = tx.Exec(ctx, `UPDATE leases SET state=$2,started_at=$3,stop_requested_at=$4,ended_at=$5,spent_ms=$6,overrun_ms=$7 WHERE id=$1`, lease.ID, lease.State, lease.StartedAt, lease.StopRequestedAt, lease.EndedAt, lease.SpentMs, lease.OverrunMs); err != nil {
		return Lease{}, err
	}
	if err = emit(ctx, tx, kind, lease); err != nil {
		return Lease{}, err
	}
	return lease, tx.Commit(ctx)
}

func (s *Store) Start(ctx context.Context, userID, id string) (Lease, error) {
	return s.mutateLease(ctx, userID, id, "start")
}
func (s *Store) Heartbeat(ctx context.Context, userID, id string) (Lease, error) {
	return s.mutateLease(ctx, userID, id, "heartbeat")
}
func (s *Store) RequestStop(ctx context.Context, userID, id string) (Lease, error) {
	return s.mutateLease(ctx, userID, id, "stop")
}
func (s *Store) End(ctx context.Context, userID, id, reason string) (Lease, error) {
	if reason != "stopped" && reason != "completed" && reason != "expired" {
		return Lease{}, ErrInvalid
	}
	return s.mutateLease(ctx, userID, id, reason)
}

// Reaping only settles a lease. It never restarts or launches a volunteer CLI.
func (s *Store) ExpireDue(ctx context.Context, limit int) (int, error) {
	if limit < 1 || limit > 1000 {
		return 0, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, "SELECT id,user_id FROM leases WHERE state IN "+liveStates+" AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT $1", limit)
	if err != nil {
		return 0, err
	}
	var due [][2]string
	for rows.Next() {
		var item [2]string
		if err = rows.Scan(&item[0], &item[1]); err != nil {
			rows.Close()
			return 0, err
		}
		due = append(due, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	for _, item := range due {
		if _, err = s.End(ctx, item[1], item[0], "expired"); err != nil {
			return 0, err
		}
	}
	return len(due), nil
}
