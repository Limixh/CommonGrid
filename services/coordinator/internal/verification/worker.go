// Package verification connects immutable uploaded bytes to a trusted harness
// and a fenced domain verdict. It never executes commands from task JSON.
package verification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"time"

	"commongrid/coordinator/internal/artifact"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
)

var ErrUnavailable = errors.New("verification_unavailable")
var ErrBinding = errors.New("verification_binding_mismatch")
var ErrHarness = errors.New("verification_harness_unavailable")

type Repository interface {
	Task(context.Context, string) (store.TaskRecord, error)
	ArtifactForSubmission(context.Context, string) (store.ArtifactRecord, error)
	ArtifactForCheckpoint(context.Context, string) (store.ArtifactRecord, error)
	ClaimVerification(context.Context, string, time.Duration) (store.VerificationClaim, error)
	CompleteVerification(context.Context, store.VerificationClaim, store.VerificationResult) (store.Submission, error)
	ClaimCheckpointVerification(context.Context, string, time.Duration) (store.CheckpointVerificationClaim, error)
	FinishCheckpointVerification(context.Context, store.CheckpointVerificationVerdict) (store.CheckpointRecord, error)
}
type Reader interface {
	Read(context.Context, string, string, int64) ([]byte, error)
}
type Scanner interface {
	Scan(context.Context, *artifact.Bundle) error
}
type Request struct {
	Task           contract.TaskContract
	Bundle         artifact.Bundle
	ArtifactSHA256 string
	Purpose        string
}
type Outcome struct {
	Pass          bool
	CheckedSHA256 string
}
type Harness interface {
	Verify(context.Context, Request) (Outcome, error)
}

// Resolver is a trusted server registry of pinned harnesses. Implementations
// select approved task/profile/base/image combinations, never a caller's shell
// command, executable path, URL or client-reported test result.
type Resolver interface {
	Resolve(contract.TaskContract, string) (Harness, error)
}
type Config struct{ ScanPolicy, ScanPolicyVersion string }
type Worker struct {
	repo     Repository
	reader   Reader
	scanner  Scanner
	resolver Resolver
	config   Config
}

func missing(value any) bool {
	if value == nil {
		return true
	}
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface, reflect.Func, reflect.Map, reflect.Slice, reflect.Chan:
		return v.IsNil()
	}
	return false
}
func New(repo Repository, reader Reader, scanner Scanner, resolver Resolver, config Config) (*Worker, error) {
	if missing(repo) || missing(reader) || missing(scanner) || missing(resolver) || config.ScanPolicy == "" || config.ScanPolicyVersion == "" {
		return nil, ErrUnavailable
	}
	return &Worker{repo: repo, reader: reader, scanner: scanner, resolver: resolver, config: config}, nil
}
func (w *Worker) prepare(ctx context.Context, record store.ArtifactRecord) (contract.TaskContract, Harness, error) {
	if record.State != "ready" || record.ScanPolicy != w.config.ScanPolicy || record.ScanPolicyVersion != w.config.ScanPolicyVersion {
		return contract.TaskContract{}, nil, ErrBinding
	}
	taskRecord, err := w.repo.Task(ctx, record.TaskID)
	if err != nil {
		return contract.TaskContract{}, nil, ErrUnavailable
	}
	task := taskRecord.Contract
	if task.Id != record.TaskID || task.TaskVersion != record.TaskVersion || task.ContractHash != record.ContractHash || task.Workspace.Commit != record.BaseCommit {
		return task, nil, ErrBinding
	}
	harness, err := w.resolver.Resolve(task, record.Purpose)
	if err != nil || missing(harness) {
		return task, nil, ErrHarness
	}
	return task, harness, nil
}
func (w *Worker) inspect(ctx context.Context, record store.ArtifactRecord, task contract.TaskContract, harness Harness) (Outcome, error) {
	if ctx.Err() != nil {
		return Outcome{}, ctx.Err()
	}
	if record.Artifact.SizeBytes <= 0 || record.Artifact.SizeBytes > artifact.MaxArchiveBytes {
		return Outcome{}, ErrBinding
	}
	raw, err := w.reader.Read(ctx, record.Artifact.ID, record.Artifact.SHA256, record.Artifact.SizeBytes)
	if err != nil {
		return Outcome{}, ErrUnavailable
	}
	sum := sha256.Sum256(raw)
	if int64(len(raw)) != record.Artifact.SizeBytes || hex.EncodeToString(sum[:]) != record.Artifact.SHA256 {
		return Outcome{}, ErrBinding
	}
	binding := artifact.Binding{Purpose: record.Purpose, TaskID: record.TaskID, TaskVersion: record.TaskVersion, ContractHash: record.ContractHash, LeaseID: record.LeaseID, BaseCommit: record.BaseCommit, StrategyID: record.StrategyID}
	bundle, err := artifact.Validate(raw, task, binding)
	if err != nil {
		return Outcome{}, ErrBinding
	}
	if err = w.scanner.Scan(ctx, &bundle); err != nil {
		return Outcome{}, ErrUnavailable
	}
	if ctx.Err() != nil {
		return Outcome{}, ctx.Err()
	}
	// A scanner never owns the immutable bytes. Reparse the retained archive so
	// its mutable inspection copies cannot alter what the trusted harness sees.
	bundle, err = artifact.Validate(raw, task, binding)
	if err != nil {
		return Outcome{}, ErrBinding
	}
	outcome, err := harness.Verify(ctx, Request{Task: task, Bundle: bundle, ArtifactSHA256: record.Artifact.SHA256, Purpose: record.Purpose})
	if err != nil {
		return Outcome{}, ErrHarness
	}
	if ctx.Err() != nil {
		return Outcome{}, ctx.Err()
	}
	if outcome.CheckedSHA256 != record.Artifact.SHA256 {
		return Outcome{}, ErrBinding
	}
	return outcome, nil
}
func (w *Worker) Submission(ctx context.Context, id string) (store.Submission, error) {
	record, err := w.repo.ArtifactForSubmission(ctx, id)
	if err != nil {
		return store.Submission{}, ErrUnavailable
	}
	if record.Purpose != "result" {
		return store.Submission{}, ErrBinding
	}
	task, harness, err := w.prepare(ctx, record)
	if err != nil {
		return store.Submission{}, err
	}
	claim, err := w.repo.ClaimVerification(ctx, id, time.Minute)
	if err != nil {
		return store.Submission{}, err
	}
	if claim.SubmissionID != id || claim.TaskVersion != record.TaskVersion || claim.ContractHash != record.ContractHash || claim.Artifact != record.Artifact {
		return store.Submission{}, ErrBinding
	}
	verification, cancel := context.WithDeadline(ctx, claim.Until)
	defer cancel()
	outcome, err := w.inspect(verification, record, task, harness)
	if err != nil {
		return store.Submission{}, err
	}
	return w.repo.CompleteVerification(verification, claim, store.VerificationResult{ArtifactSHA256: outcome.CheckedSHA256, Pass: outcome.Pass})
}
func (w *Worker) Checkpoint(ctx context.Context, id string) (store.CheckpointRecord, error) {
	record, err := w.repo.ArtifactForCheckpoint(ctx, id)
	if err != nil {
		return store.CheckpointRecord{}, ErrUnavailable
	}
	if record.Purpose != "checkpoint" {
		return store.CheckpointRecord{}, ErrBinding
	}
	task, harness, err := w.prepare(ctx, record)
	if err != nil {
		return store.CheckpointRecord{}, err
	}
	claim, err := w.repo.ClaimCheckpointVerification(ctx, id, time.Minute)
	if err != nil {
		return store.CheckpointRecord{}, err
	}
	metadata := claim.Checkpoint.Metadata
	if metadata.CheckpointId != id || metadata.TaskId != record.TaskID || metadata.TaskVersion != record.TaskVersion || metadata.ContractHash != record.ContractHash || metadata.LeaseId != record.LeaseID || metadata.BaseCommit != record.BaseCommit || claim.Checkpoint.Artifact != record.Artifact {
		return store.CheckpointRecord{}, ErrBinding
	}
	verification, cancel := context.WithDeadline(ctx, claim.Deadline)
	defer cancel()
	outcome, err := w.inspect(verification, record, task, harness)
	if err != nil {
		return store.CheckpointRecord{}, err
	}
	verdict := store.CheckpointVerificationVerdict{CheckpointID: id, Token: claim.Token, ArtifactSHA256: outcome.CheckedSHA256, Status: "usable"}
	if !outcome.Pass {
		verdict.Status = "rejected"
		verdict.ReasonCode = "quick_check_failed"
	}
	return w.repo.FinishCheckpointVerification(verification, verdict)
}
