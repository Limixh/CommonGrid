package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"commongrid/coordinator/internal/contract"
	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"github.com/jackc/pgx/v5"
)

const checkpointRetention = 7 * 24 * time.Hour
const checkpointColumns = `metadata,artifact_id,artifact_sha256,artifact_size_bytes,status,coalesce(reason_code,''),created_at,expires_at,verified_at`

type SubmitCheckpointRequest struct {
	UserID        string
	RequestKey    string
	RawCheckpoint []byte
	Artifact      ArtifactRef
}

type CheckpointRecord struct {
	Metadata   contract.Checkpoint `json:"metadata"` // Untrusted explanatory text, including after verification.
	Artifact   ArtifactRef         `json:"artifact"`
	Status     string              `json:"status"`
	ReasonCode string              `json:"reason_code,omitempty"`
	CreatedAt  time.Time           `json:"created_at"`
	ExpiresAt  time.Time           `json:"expires_at"`
	VerifiedAt *time.Time          `json:"verified_at,omitempty"`
}

type CheckpointVerificationClaim struct {
	Checkpoint CheckpointRecord `json:"checkpoint"`
	Token      string           `json:"-"`
	Deadline   time.Time        `json:"deadline"`
}

// This request is accepted only from a trusted server verifier, never a client.
// ArtifactSHA256 binds its verdict to the claimed immutable artifact digest.
type CheckpointVerificationVerdict struct {
	CheckpointID   string
	Token          string
	ArtifactSHA256 string
	Status         string
	ReasonCode     string
}

type LatestCheckpointRequest struct {
	UserID       string
	TaskID       string
	TaskVersion  int64
	ContractHash string
	BaseCommit   string
	StrategyID   string
}

func scanCheckpoint(row pgx.Row) (CheckpointRecord, error) {
	var record CheckpointRecord
	var raw []byte
	err := row.Scan(&raw, &record.Artifact.ID, &record.Artifact.SHA256, &record.Artifact.SizeBytes, &record.Status, &record.ReasonCode, &record.CreatedAt, &record.ExpiresAt, &record.VerifiedAt)
	if err == pgx.ErrNoRows {
		return record, ErrNotFound
	}
	if err != nil {
		return record, err
	}
	err = json.Unmarshal(raw, &record.Metadata)
	return record, err
}

// checkpointLocks shares the budget/task/user/lease order with lease mutations.
// Verification can continue after that lease ends; no new lease is created.
func checkpointLocks(ctx context.Context, tx pgx.Tx, taskID, userID, leaseID string) (contract.TaskContract, string, Lease, time.Time, error) {
	var project, node string
	var now time.Time
	var lease Lease
	if err := tx.QueryRow(ctx, "SELECT project_id,node_id FROM tasks WHERE id=$1", taskID).Scan(&project, &node); err != nil {
		if err == pgx.ErrNoRows {
			err = ErrNotFound
		}
		return contract.TaskContract{}, "", lease, now, err
	}
	if _, err := lockScopes(ctx, tx, project, node); err != nil {
		return contract.TaskContract{}, "", lease, now, err
	}
	task, _, status, _, err := lockTaskUser(ctx, tx, taskID, userID)
	if err != nil {
		return task, status, lease, now, err
	}
	lease, err = scanLease(tx.QueryRow(ctx, "SELECT "+leaseColumns+" FROM leases WHERE id=$1 AND user_id=$2 FOR UPDATE", leaseID, userID))
	if err != nil {
		return task, status, lease, now, err
	}
	err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now)
	return task, status, lease, now, err
}

func checkpointFence(task contract.TaskContract, metadata contract.Checkpoint) error {
	if task.Id != metadata.TaskId || task.TaskVersion != metadata.TaskVersion || task.ContractHash != metadata.ContractHash || task.Workspace.Commit != metadata.BaseCommit {
		return ErrStale
	}
	return nil
}

func (s *Store) SubmitCheckpoint(ctx context.Context, request SubmitCheckpointRequest) (CheckpointRecord, error) {
	return s.submitCheckpoint(ctx, request, false)
}

func (s *Store) SubmitUploadedCheckpoint(ctx context.Context, request SubmitCheckpointRequest) (CheckpointRecord, error) {
	return s.submitCheckpoint(ctx, request, true)
}

func (s *Store) submitCheckpoint(ctx context.Context, request SubmitCheckpointRequest, uploaded bool) (CheckpointRecord, error) {
	if !validID.MatchString(request.UserID) || !validID.MatchString(request.RequestKey) {
		return CheckpointRecord{}, ErrInvalid
	}
	if err := request.Artifact.validate(); err != nil {
		return CheckpointRecord{}, err
	}
	metadata, err := s.validator.Checkpoint(request.RawCheckpoint)
	if err != nil {
		return CheckpointRecord{}, fmt.Errorf("checkpoint: %w", err)
	}
	// cg-artifact/1 carries source snapshots. Soft explanatory checkpoints need
	// a distinct text-only format before they can use public uploaded authority.
	if uploaded && metadata.Type != "hard" {
		return CheckpointRecord{}, ErrInvalid
	}
	if request.Artifact.SHA256 != metadata.ArtifactSha256 {
		return CheckpointRecord{}, ErrInvalid
	}
	canonical, err := jsoncanonicalizer.Transform(request.RawCheckpoint)
	if err != nil {
		return CheckpointRecord{}, err
	}
	fingerprintRaw, _ := json.Marshal(struct {
		Metadata json.RawMessage
		Artifact ArtifactRef
	}{canonical, request.Artifact})
	sum := sha256.Sum256(fingerprintRaw)
	fingerprint := hex.EncodeToString(sum[:])
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CheckpointRecord{}, err
	}
	defer rollback(tx)
	task, status, lease, now, err := checkpointLocks(ctx, tx, metadata.TaskId, request.UserID, metadata.LeaseId)
	if err != nil {
		return CheckpointRecord{}, err
	}
	if uploaded {
		if err = validateArtifactReferenceTx(ctx, tx, request.UserID, metadata.LeaseId, "checkpoint", request.Artifact); err != nil {
			return CheckpointRecord{}, err
		}
	}
	// Exact receipt retries acknowledge previously committed metadata without
	// accepting any new late checkpoint from a released/stale producer.
	var existingID, existingHash string
	err = tx.QueryRow(ctx, "SELECT id,request_hash FROM checkpoints WHERE user_id=$1 AND request_key=$2", request.UserID, request.RequestKey).Scan(&existingID, &existingHash)
	if err == nil {
		if existingHash != fingerprint {
			return CheckpointRecord{}, ErrConflict
		}
		existing, err := scanCheckpoint(tx.QueryRow(ctx, "SELECT "+checkpointColumns+" FROM checkpoints WHERE id=$1", existingID))
		if err != nil {
			return CheckpointRecord{}, err
		}
		return existing, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return CheckpointRecord{}, err
	}
	if err = checkpointFence(task, metadata); err != nil {
		return CheckpointRecord{}, err
	}
	if lease.TaskID != metadata.TaskId || lease.TaskVersion != metadata.TaskVersion || lease.ContractHash != metadata.ContractHash {
		return CheckpointRecord{}, ErrStale
	}
	if (lease.State != "active" && lease.State != "stop_requested") || !now.Before(lease.ExpiresAt) {
		return CheckpointRecord{}, ErrClosed
	}
	if status == "accepted" || status == "archived" || (status == "awaiting_review" && lease.State != "stop_requested") {
		return CheckpointRecord{}, ErrClosed
	}
	if !task.Handoff.Enabled || (metadata.Type == "hard" && !task.Handoff.AllowWorkspaceSnapshot) {
		return CheckpointRecord{}, ErrInvalid
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM checkpoints WHERE id=$1)", metadata.CheckpointId).Scan(&exists); err != nil {
		return CheckpointRecord{}, err
	}
	if exists {
		return CheckpointRecord{}, ErrConflict
	}
	var count int64
	// Task row lock serializes the count and insertion across every producer.
	// No pruning: expired/rejected ancestors still occupy the retained limit.
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM checkpoints WHERE task_id=$1 AND task_version=$2 AND contract_hash=$3", task.Id, task.TaskVersion, task.ContractHash).Scan(&count); err != nil {
		return CheckpointRecord{}, err
	}
	if count >= task.Handoff.MaxCheckpoints {
		return CheckpointRecord{}, ErrCapacity
	}
	expiry := now.Add(checkpointRetention)
	if metadata.ParentCheckpointId != nil {
		parent, err := scanCheckpoint(tx.QueryRow(ctx, "SELECT "+checkpointColumns+" FROM checkpoints WHERE id=$1 FOR UPDATE", *metadata.ParentCheckpointId))
		if err != nil {
			return CheckpointRecord{}, err
		}
		if err = checkpointFence(task, parent.Metadata); err != nil {
			return CheckpointRecord{}, err
		}
		if parent.Status != "usable" || !now.Before(parent.ExpiresAt) {
			return CheckpointRecord{}, ErrClosed
		}
		var parentUser, parentStrategy string
		if err = tx.QueryRow(ctx, "SELECT user_id,strategy_id FROM leases WHERE id=$1", parent.Metadata.LeaseId).Scan(&parentUser, &parentStrategy); err != nil {
			return CheckpointRecord{}, err
		}
		if parentStrategy != lease.StrategyID || (task.Parallelism.Mode == "independent" && parentUser != request.UserID) {
			return CheckpointRecord{}, ErrInvalid
		}
		// Child expiry cannot exceed its parent's, preserving the entire
		// required ancestry without pruning or silently losing expired links.
		if expiry.After(parent.ExpiresAt) {
			expiry = parent.ExpiresAt
		}
		// Parent links are immutable and point to an existing row, so a new ID
		// cannot form a cycle; self-links are already rejected by validation.
	}
	record := CheckpointRecord{Metadata: metadata, Artifact: request.Artifact, Status: "submitted", CreatedAt: now, ExpiresAt: expiry}
	_, err = tx.Exec(ctx, `INSERT INTO checkpoints(id,task_id,task_version,contract_hash,lease_id,user_id,request_key,request_hash,parent_id,base_commit,metadata,artifact_id,artifact_sha256,artifact_size_bytes,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)`, metadata.CheckpointId, metadata.TaskId, metadata.TaskVersion, metadata.ContractHash, metadata.LeaseId, request.UserID, request.RequestKey, fingerprint, metadata.ParentCheckpointId, metadata.BaseCommit, string(canonical), request.Artifact.ID, request.Artifact.SHA256, request.Artifact.SizeBytes, record.CreatedAt, record.ExpiresAt)
	if err != nil {
		return CheckpointRecord{}, err
	}
	if err = emitCheckpoint(ctx, tx, "checkpoint.submitted", record); err != nil {
		return CheckpointRecord{}, err
	}
	return record, tx.Commit(ctx)
}

// Checkpoint grants receipt access to its producer or project owner. New
// volunteers obtain only usable compatible metadata via LatestUsableCheckpoint.
func (s *Store) Checkpoint(ctx context.Context, userID, id string) (CheckpointRecord, error) {
	if !validID.MatchString(userID) || !validID.MatchString(id) {
		return CheckpointRecord{}, ErrInvalid
	}
	return scanCheckpoint(s.pool.QueryRow(ctx, "SELECT "+checkpointColumns+" FROM checkpoints WHERE id=$1 AND (user_id=$2 OR EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id JOIN task_versions v ON (v.task_id,v.version,v.contract_hash)=(checkpoints.task_id,checkpoints.task_version,checkpoints.contract_hash) WHERE t.id=checkpoints.task_id AND p.owner_id=$2 AND v.contract->'parallelism'->>'mode'='exclusive'))", id, userID))
}

func (s *Store) ClaimCheckpointVerification(ctx context.Context, id string, ttl time.Duration) (CheckpointVerificationClaim, error) {
	if !validID.MatchString(id) || ttl < time.Second || ttl > 5*time.Minute {
		return CheckpointVerificationClaim{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CheckpointVerificationClaim{}, err
	}
	defer rollback(tx)
	var taskID, userID, leaseID string
	if err = tx.QueryRow(ctx, "SELECT task_id,user_id,lease_id FROM checkpoints WHERE id=$1", id).Scan(&taskID, &userID, &leaseID); err != nil {
		if err == pgx.ErrNoRows {
			err = ErrNotFound
		}
		return CheckpointVerificationClaim{}, err
	}
	task, status, _, now, err := checkpointLocks(ctx, tx, taskID, userID, leaseID)
	if err != nil {
		return CheckpointVerificationClaim{}, err
	}
	record, err := scanCheckpoint(tx.QueryRow(ctx, "SELECT "+checkpointColumns+" FROM checkpoints WHERE id=$1 FOR UPDATE", id))
	if err != nil {
		return CheckpointVerificationClaim{}, err
	}
	if err = checkpointFence(task, record.Metadata); err != nil {
		return CheckpointVerificationClaim{}, err
	}
	if status == "accepted" || status == "archived" || !now.Before(record.ExpiresAt) || record.Status == "usable" || record.Status == "rejected" {
		return CheckpointVerificationClaim{}, ErrClosed
	}
	var until *time.Time
	if err = tx.QueryRow(ctx, "SELECT claim_until FROM checkpoints WHERE id=$1", id).Scan(&until); err != nil {
		return CheckpointVerificationClaim{}, err
	}
	if until != nil && now.Before(*until) {
		return CheckpointVerificationClaim{}, ErrClaimLost
	}
	claim := CheckpointVerificationClaim{Checkpoint: record, Token: newID("cpclaim-"), Deadline: now.Add(ttl)}
	if claim.Deadline.After(record.ExpiresAt) {
		claim.Deadline = record.ExpiresAt
	}
	claim.Checkpoint.Status = "verifying"
	if _, err = tx.Exec(ctx, "UPDATE checkpoints SET status='verifying',claim_token=$2,claim_until=$3 WHERE id=$1", id, claim.Token, claim.Deadline); err != nil {
		return CheckpointVerificationClaim{}, err
	}
	if err = emitCheckpoint(ctx, tx, "checkpoint.verification_started", claim.Checkpoint); err != nil {
		return CheckpointVerificationClaim{}, err
	}
	return claim, tx.Commit(ctx)
}

func validCheckpointVerdict(verdict CheckpointVerificationVerdict) bool {
	if !validID.MatchString(verdict.CheckpointID) || !validID.MatchString(verdict.Token) || !validHash.MatchString(verdict.ArtifactSHA256) {
		return false
	}
	if verdict.Status == "usable" {
		return verdict.ReasonCode == ""
	}
	if verdict.Status != "rejected" {
		return false
	}
	switch verdict.ReasonCode {
	case "artifact_invalid", "unsafe_paths", "secret_detected", "unsafe_text", "quick_check_failed", "incompatible_base":
		return true
	}
	return false
}

func (s *Store) FinishCheckpointVerification(ctx context.Context, verdict CheckpointVerificationVerdict) (CheckpointRecord, error) {
	if !validCheckpointVerdict(verdict) {
		return CheckpointRecord{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CheckpointRecord{}, err
	}
	defer rollback(tx)
	var taskID, userID, leaseID string
	if err = tx.QueryRow(ctx, "SELECT task_id,user_id,lease_id FROM checkpoints WHERE id=$1", verdict.CheckpointID).Scan(&taskID, &userID, &leaseID); err != nil {
		if err == pgx.ErrNoRows {
			err = ErrNotFound
		}
		return CheckpointRecord{}, err
	}
	task, status, _, now, err := checkpointLocks(ctx, tx, taskID, userID, leaseID)
	if err != nil {
		return CheckpointRecord{}, err
	}
	record, err := scanCheckpoint(tx.QueryRow(ctx, "SELECT "+checkpointColumns+" FROM checkpoints WHERE id=$1 FOR UPDATE", verdict.CheckpointID))
	if err != nil {
		return CheckpointRecord{}, err
	}
	if err = checkpointFence(task, record.Metadata); err != nil {
		return CheckpointRecord{}, err
	}
	var token *string
	var until *time.Time
	if err = tx.QueryRow(ctx, "SELECT claim_token,claim_until FROM checkpoints WHERE id=$1", verdict.CheckpointID).Scan(&token, &until); err != nil {
		return CheckpointRecord{}, err
	}
	if token == nil || until == nil || *token != verdict.Token {
		return CheckpointRecord{}, ErrClaimLost
	}
	if record.Status == "usable" || record.Status == "rejected" {
		if record.Artifact.SHA256 != verdict.ArtifactSHA256 || record.Status != verdict.Status || record.ReasonCode != verdict.ReasonCode {
			return CheckpointRecord{}, ErrConflict
		}
		return record, tx.Commit(ctx)
	}
	if status == "accepted" || status == "archived" || !now.Before(record.ExpiresAt) {
		return CheckpointRecord{}, ErrClosed
	}
	if !now.Before(*until) || record.Artifact.SHA256 != verdict.ArtifactSHA256 {
		return CheckpointRecord{}, ErrClaimLost
	}
	if record.Status != "verifying" {
		return CheckpointRecord{}, ErrConflict
	}
	record.Status = verdict.Status
	record.ReasonCode = verdict.ReasonCode
	record.VerifiedAt = &now
	var reason *string
	if record.ReasonCode != "" {
		reason = &record.ReasonCode
	}
	if _, err = tx.Exec(ctx, "UPDATE checkpoints SET status=$2,reason_code=$3,verified_at=$4 WHERE id=$1", verdict.CheckpointID, record.Status, reason, now); err != nil {
		return CheckpointRecord{}, err
	}
	if err = emitCheckpoint(ctx, tx, "checkpoint."+record.Status, record); err != nil {
		return CheckpointRecord{}, err
	}
	if err = reconcileTask(ctx, tx, taskID); err != nil {
		return CheckpointRecord{}, err
	}
	return record, tx.Commit(ctx)
}

func (s *Store) LatestUsableCheckpoint(ctx context.Context, request LatestCheckpointRequest) (CheckpointRecord, error) {
	if !validID.MatchString(request.UserID) || !validID.MatchString(request.TaskID) || !validID.MatchString(request.StrategyID) || request.TaskVersion < 1 || !validHash.MatchString(request.ContractHash) || !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(request.BaseCommit) {
		return CheckpointRecord{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CheckpointRecord{}, err
	}
	defer rollback(tx)
	var project, node string
	if err = tx.QueryRow(ctx, "SELECT project_id,node_id FROM tasks WHERE id=$1", request.TaskID).Scan(&project, &node); err != nil {
		if err == pgx.ErrNoRows {
			err = ErrNotFound
		}
		return CheckpointRecord{}, err
	}
	if _, err = lockScopes(ctx, tx, project, node); err != nil {
		return CheckpointRecord{}, err
	}
	task, _, status, _, err := lockTaskUser(ctx, tx, request.TaskID, request.UserID)
	if err != nil {
		return CheckpointRecord{}, err
	}
	if task.TaskVersion != request.TaskVersion || task.ContractHash != request.ContractHash || task.Workspace.Commit != request.BaseCommit {
		return CheckpointRecord{}, ErrStale
	}
	if status == "accepted" || status == "archived" || !task.Handoff.Enabled || !task.Handoff.ResumeFromLatest {
		return CheckpointRecord{}, ErrClosed
	}
	strategyFound := false
	for _, strategy := range task.Strategies {
		if strategy.Id == request.StrategyID {
			strategyFound = true
		}
	}
	if !strategyFound {
		return CheckpointRecord{}, ErrInvalid
	}
	record, err := scanCheckpoint(tx.QueryRow(ctx, "SELECT "+checkpointColumns+" FROM checkpoints WHERE task_id=$1 AND task_version=$2 AND contract_hash=$3 AND base_commit=$4 AND status='usable' AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM leases l WHERE l.id=checkpoints.lease_id AND l.strategy_id=$5) AND ($6='exclusive' OR user_id=$7) ORDER BY created_at DESC,id DESC LIMIT 1", request.TaskID, request.TaskVersion, request.ContractHash, request.BaseCommit, request.StrategyID, task.Parallelism.Mode, request.UserID))
	if err != nil {
		return CheckpointRecord{}, err
	}
	return record, tx.Commit(ctx)
}

// No untrusted summary/instructions or artifact content enters workflow events.
func emitCheckpoint(ctx context.Context, tx pgx.Tx, kind string, record CheckpointRecord) error {
	return emitDomain(ctx, tx, kind, record.Metadata.LeaseId, record.Metadata.CheckpointId, struct {
		TaskID         string `json:"task_id"`
		TaskVersion    int64  `json:"task_version"`
		ContractHash   string `json:"contract_hash"`
		ArtifactSHA256 string `json:"artifact_sha256"`
		Status         string `json:"status"`
		ReasonCode     string `json:"reason_code,omitempty"`
	}{record.Metadata.TaskId, record.Metadata.TaskVersion, record.Metadata.ContractHash, record.Artifact.SHA256, record.Status, record.ReasonCode})
}
