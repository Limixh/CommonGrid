package store

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const MaxRetainedArtifactBytes int64 = 256 * 1024 * 1024
const MaxRetainedArtifacts = 100

var opaqueArtifactID = regexp.MustCompile(`^artifact-[a-f0-9]{32}$`)

// ArtifactRegistration is a trusted server boundary: the scanner and vault,
// never request JSON, supply the artifact digest, size and scan receipt.
type ArtifactRegistration struct {
	UserID            string      `json:"user_id"`
	LeaseID           string      `json:"lease_id"`
	TaskID            string      `json:"task_id"`
	TaskVersion       int64       `json:"task_version"`
	ContractHash      string      `json:"contract_hash"`
	BaseCommit        string      `json:"base_commit"`
	StrategyID        string      `json:"strategy_id"`
	Purpose           string      `json:"purpose"`
	RequestKey        string      `json:"request_key"`
	ScanPolicy        string      `json:"scan_policy"`
	ScanPolicyVersion string      `json:"scan_policy_version"`
	Artifact          ArtifactRef `json:"artifact"`
}

type ArtifactRecord struct {
	ArtifactRegistration
	State     string    `json:"state"`
	CreatedAt time.Time `json:"created_at"`
}

func (r ArtifactRegistration) validate() error {
	if !validID.MatchString(r.UserID) || !validID.MatchString(r.LeaseID) || !validID.MatchString(r.TaskID) || !validID.MatchString(r.StrategyID) || !validID.MatchString(r.RequestKey) || !validID.MatchString(r.ScanPolicy) || !validID.MatchString(r.ScanPolicyVersion) || r.TaskVersion < 1 || !validHash.MatchString(r.ContractHash) || !validBaseCommit.MatchString(r.BaseCommit) || (r.Purpose != "result" && r.Purpose != "checkpoint") || !opaqueArtifactID.MatchString(r.Artifact.ID) {
		return ErrInvalid
	}
	return r.Artifact.validate()
}

const artifactColumns = `a.id,a.user_id,a.lease_id,a.task_id,a.task_version,a.contract_hash,a.base_commit,a.strategy_id,a.purpose,a.request_key,a.sha256,a.size_bytes,a.scan_policy,a.scan_policy_version,a.state,a.created_at`

func scanArtifact(row pgx.Row) (ArtifactRecord, error) {
	var r ArtifactRecord
	err := row.Scan(&r.Artifact.ID, &r.UserID, &r.LeaseID, &r.TaskID, &r.TaskVersion, &r.ContractHash, &r.BaseCommit, &r.StrategyID, &r.Purpose, &r.RequestKey, &r.Artifact.SHA256, &r.Artifact.SizeBytes, &r.ScanPolicy, &r.ScanPolicyVersion, &r.State, &r.CreatedAt)
	if err == pgx.ErrNoRows {
		err = ErrNotFound
	}
	return r, err
}

// RegisterArtifact serializes accounting with the same user lock used by lease
// mutations. Exact retries survive lease completion; changed retries conflict.
func (s *Store) RegisterArtifact(ctx context.Context, r ArtifactRegistration) (ArtifactRecord, error) {
	if err := r.validate(); err != nil {
		return ArtifactRecord{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArtifactRecord{}, err
	}
	defer rollback(tx)
	task, status, lease, now, err := checkpointLocks(ctx, tx, r.TaskID, r.UserID, r.LeaseID)
	if err != nil {
		return ArtifactRecord{}, err
	}
	existing, err := scanArtifact(tx.QueryRow(ctx, "SELECT "+artifactColumns+" FROM artifacts a WHERE a.user_id=$1 AND a.request_key=$2", r.UserID, r.RequestKey))
	if err == nil {
		if candidateHash(existing.ArtifactRegistration) != candidateHash(r) {
			return ArtifactRecord{}, ErrConflict
		}
		return existing, tx.Commit(ctx)
	}
	if err != ErrNotFound {
		return ArtifactRecord{}, err
	}
	if lease.TaskID != r.TaskID || lease.TaskVersion != r.TaskVersion || lease.ContractHash != r.ContractHash || lease.StrategyID != r.StrategyID || task.TaskVersion != r.TaskVersion || task.ContractHash != r.ContractHash || task.Workspace.Commit != r.BaseCommit {
		return ArtifactRecord{}, ErrStale
	}
	if !now.Before(lease.ExpiresAt) || (lease.State != "active" && !(r.Purpose == "checkpoint" && lease.State == "stop_requested")) || status == "accepted" || status == "archived" || (status == "awaiting_review" && !(r.Purpose == "checkpoint" && lease.State == "stop_requested")) {
		return ArtifactRecord{}, ErrClosed
	}
	if r.Purpose == "checkpoint" && !task.Handoff.Enabled {
		return ArtifactRecord{}, ErrInvalid
	}
	var count int
	var retained int64
	if err = tx.QueryRow(ctx, "SELECT count(*),coalesce(sum(size_bytes),0) FROM artifacts WHERE user_id=$1", r.UserID).Scan(&count, &retained); err != nil {
		return ArtifactRecord{}, err
	}
	if count >= MaxRetainedArtifacts || retained > MaxRetainedArtifactBytes-r.Artifact.SizeBytes {
		return ArtifactRecord{}, ErrCapacity
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=$1)", r.Artifact.ID).Scan(&exists); err != nil {
		return ArtifactRecord{}, err
	}
	if exists {
		return ArtifactRecord{}, ErrConflict
	}
	result := ArtifactRecord{ArtifactRegistration: r, State: "pending", CreatedAt: now}
	_, err = tx.Exec(ctx, `INSERT INTO artifacts(id,user_id,lease_id,task_id,task_version,contract_hash,base_commit,strategy_id,purpose,request_key,request_hash,sha256,size_bytes,scan_policy,scan_policy_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, r.Artifact.ID, r.UserID, r.LeaseID, r.TaskID, r.TaskVersion, r.ContractHash, r.BaseCommit, r.StrategyID, r.Purpose, r.RequestKey, candidateHash(r), r.Artifact.SHA256, r.Artifact.SizeBytes, r.ScanPolicy, r.ScanPolicyVersion, now)
	if err != nil {
		var databaseError *pgconn.PgError
		if errors.As(err, &databaseError) && databaseError.Code == "23505" {
			return ArtifactRecord{}, ErrConflict
		}
		return ArtifactRecord{}, err
	}
	return result, tx.Commit(ctx)
}

func (s *Store) ArtifactForOwner(ctx context.Context, userID, id string) (ArtifactRecord, error) {
	if !validID.MatchString(userID) || !opaqueArtifactID.MatchString(id) {
		return ArtifactRecord{}, ErrInvalid
	}
	return scanArtifact(s.pool.QueryRow(ctx, "SELECT "+artifactColumns+" FROM artifacts a WHERE a.id=$1 AND a.user_id=$2", id, userID))
}

// MarkArtifactStored is called only after the private vault has durably written
// and verified the exact bytes. A pending reservation is never a usable upload.
func (s *Store) MarkArtifactStored(ctx context.Context, userID, id string, ref ArtifactRef) (ArtifactRecord, error) {
	if !validID.MatchString(userID) || !opaqueArtifactID.MatchString(id) || id != ref.ID || ref.validate() != nil {
		return ArtifactRecord{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArtifactRecord{}, err
	}
	defer rollback(tx)
	r, err := scanArtifact(tx.QueryRow(ctx, "SELECT "+artifactColumns+" FROM artifacts a WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE", id, userID))
	if err != nil {
		return ArtifactRecord{}, err
	}
	if r.Artifact != ref {
		return ArtifactRecord{}, ErrConflict
	}
	if r.State == "pending" {
		if _, err = tx.Exec(ctx, "UPDATE artifacts SET state='ready' WHERE id=$1", id); err != nil {
			return ArtifactRecord{}, err
		}
		r.State = "ready"
	}
	return r, tx.Commit(ctx)
}

// These worker lookups require exact immutable receipt and lease binding, even
// after the producer lease has ended. Possession of an object ID is insufficient.
func (s *Store) ArtifactForSubmission(ctx context.Context, id string) (ArtifactRecord, error) {
	if !validID.MatchString(id) {
		return ArtifactRecord{}, ErrInvalid
	}
	return scanArtifact(s.pool.QueryRow(ctx, "SELECT "+artifactColumns+` FROM artifacts a JOIN submissions r ON a.id=r.artifact_id JOIN leases l ON l.id=r.lease_id WHERE r.id=$1 AND a.state='ready' AND a.purpose='result' AND (a.user_id,a.lease_id,a.task_id,a.task_version,a.contract_hash,a.base_commit,a.sha256,a.size_bytes,a.strategy_id)=(r.user_id,r.lease_id,r.task_id,r.task_version,r.contract_hash,r.base_commit,r.artifact_sha256,r.artifact_size_bytes,l.strategy_id)`, id))
}
func (s *Store) ArtifactForCheckpoint(ctx context.Context, id string) (ArtifactRecord, error) {
	if !validID.MatchString(id) {
		return ArtifactRecord{}, ErrInvalid
	}
	return scanArtifact(s.pool.QueryRow(ctx, "SELECT "+artifactColumns+` FROM artifacts a JOIN checkpoints r ON a.id=r.artifact_id JOIN leases l ON l.id=r.lease_id WHERE r.id=$1 AND a.state='ready' AND a.purpose='checkpoint' AND (a.user_id,a.lease_id,a.task_id,a.task_version,a.contract_hash,a.base_commit,a.sha256,a.size_bytes,a.strategy_id)=(r.user_id,r.lease_id,r.task_id,r.task_version,r.contract_hash,r.base_commit,r.artifact_sha256,r.artifact_size_bytes,l.strategy_id)`, id))
}

func validateArtifactReferenceTx(ctx context.Context, tx pgx.Tx, userID, leaseID, purpose string, ref ArtifactRef) error {
	if !validID.MatchString(userID) || !validID.MatchString(leaseID) || (purpose != "result" && purpose != "checkpoint") || !opaqueArtifactID.MatchString(ref.ID) || ref.validate() != nil {
		return ErrInvalid
	}
	var found bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM artifacts a JOIN leases l ON l.id=a.lease_id JOIN task_versions v ON (v.task_id,v.version,v.contract_hash)=(a.task_id,a.task_version,a.contract_hash) WHERE a.id=$1 AND a.state='ready' AND a.user_id=$2 AND a.lease_id=$3 AND a.purpose=$4 AND a.sha256=$5 AND a.size_bytes=$6 AND (a.user_id,a.task_id,a.task_version,a.contract_hash,a.strategy_id)=(l.user_id,l.task_id,l.task_version,l.contract_hash,l.strategy_id) AND a.base_commit=v.contract->'workspace'->>'commit')`, ref.ID, userID, leaseID, purpose, ref.SHA256, ref.SizeBytes).Scan(&found)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	return nil
}

// ValidateArtifactReference is a read-only preflight; public metadata writes
// additionally call the transaction helper in their receipt transaction.
func (s *Store) ValidateArtifactReference(ctx context.Context, userID, leaseID, purpose string, ref ArtifactRef) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = validateArtifactReferenceTx(ctx, tx, userID, leaseID, purpose, ref); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
