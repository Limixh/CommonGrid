package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"commongrid/coordinator/internal/contract"
	"github.com/jackc/pgx/v5"
)

// Upgrade a populated original schema, rather than only exercising fresh DDL.
func TestPostgresDomainMigrationPreservesExistingLeaseEvents(t *testing.T) {
	db, task := databaseFixture(t, 1000000, 1000000, 1)
	ctx := context.Background()
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{db.schema}.Sanitize()+" CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{db.schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "SET LOCAL search_path TO "+pgx.Identifier{db.schema}.Sanitize()+",pg_catalog"); err != nil {
		t.Fatal(err)
	}
	raw, err := migrations.ReadFile("migrations/0001_domain.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, string(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)", "0001_domain.sql", fmt.Sprintf("%x", sha256.Sum256(raw))); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	user(t, db, "owner", 1)
	user(t, db, "worker", 1)
	if err = db.CreateProject(ctx, "project", "owner", 1000000, 30); err != nil {
		t.Fatal(err)
	}
	if err = db.CreateNode(ctx, "leaf", "project", nil, 1000000); err != nil {
		t.Fatal(err)
	}
	contractRaw, _ := json.Marshal(task)
	if err = db.Publish(ctx, contractRaw); err != nil {
		t.Fatal(err)
	}
	request := requestFor(task, "worker", "legacy-reserve")
	request.LimitSec = 20
	lease, err := db.Reserve(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Start(ctx, "worker", lease.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.RequestStop(ctx, "worker", lease.ID); err != nil {
		t.Fatal(err)
	}
	if countRows(t, db, "outbox") != 3 {
		t.Fatal("legacy lease events missing")
	}
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = db.End(ctx, "worker", lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	if countRows(t, db, "outbox") != 4 || countRows(t, db, "leases") != 1 {
		t.Fatal("upgrade lost or duplicated durable lease data")
	}
	var withEntity int
	if err = db.pool.QueryRow(ctx, "SELECT count(*) FROM outbox WHERE entity_id IS NOT NULL").Scan(&withEntity); err != nil || withEntity != 0 {
		t.Fatalf("legacy lifecycle event shape changed: %d, %v", withEntity, err)
	}
	if _, err = db.pool.Exec(ctx, `INSERT INTO outbox(event_id,aggregate_id,kind,payload) VALUES('duplicate-start',$1,'lease.started','{}')`, lease.ID); err == nil {
		t.Fatal("lease event uniqueness weakened by domain migration")
	}
}

func TestPostgresReviewChangesRestoreCheckpointWithoutAutomaticRestart(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, true)
	ctx := context.Background()
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-review-resume", nil)); err != nil {
		t.Fatal(err)
	}
	checkpointVerdict(t, db, "cp-review-resume", "usable")
	request := SubmitRequest{UserID: lease.UserID, LeaseID: lease.ID, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash,
		RequestKey: "submit-for-review", BaseCommit: task.Workspace.Commit,
		Artifact: ArtifactRef{ID: "candidate-artifact", SHA256: task.ContractHash, SizeBytes: 1024}}
	submission, err := db.Submit(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	// There is no live lease now, but a pending result still fences publication.
	replacement := task
	replacement.TaskVersion++
	raw, _ := json.Marshal(replacement)
	replacement.ContractHash, _ = contract.ComputeHash(raw)
	raw, _ = json.Marshal(replacement)
	if err = db.Publish(ctx, raw); !errors.Is(err, ErrClosed) {
		t.Fatal("pending result lost its immutable contract", err)
	}
	claim, err := db.ClaimVerification(ctx, submission.ID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Publish(ctx, raw); !errors.Is(err, ErrClosed) {
		t.Fatal("verification in progress lost its immutable contract", err)
	}
	if _, err = db.CompleteVerification(ctx, claim, VerificationResult{ArtifactSHA256: submission.Artifact.SHA256, Pass: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: submission.ID, ReviewerID: "owner", Decision: "request_changes", Comments: "Continue from checkpoint"}); err != nil {
		t.Fatal(err)
	}
	var status string
	if err = db.pool.QueryRow(ctx, "SELECT status FROM tasks WHERE id=$1", task.Id).Scan(&status); err != nil || status != "resumable" {
		t.Fatalf("review changes did not restore continuation: %s, %v", status, err)
	}
	if countRows(t, db, "leases") != 1 {
		t.Fatal("review changes automatically created an attempt")
	}
	user(t, db, "next-worker", 1)
	latest := latestRequest(task, lease)
	latest.UserID = "next-worker"
	if _, err = db.LatestUsableCheckpoint(ctx, latest); err != nil {
		t.Fatal("exclusive handoff not readable", err)
	}
	resume := requestFor(task, "next-worker", "explicit-resume")
	resume.LimitSec = 20
	if _, err = db.Reserve(ctx, resume); err != nil {
		t.Fatal("explicit continuation lease failed", err)
	}
}

func TestPostgresAcceptedWinnerCannotBeReopenedByPublish(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, true)
	ctx := context.Background()
	submission, err := db.Submit(ctx, SubmitRequest{UserID: lease.UserID, LeaseID: lease.ID, TaskVersion: task.TaskVersion,
		ContractHash: task.ContractHash, RequestKey: "winner-submit", BaseCommit: task.Workspace.Commit,
		Artifact: ArtifactRef{ID: "winner-artifact", SHA256: task.ContractHash, SizeBytes: 1024}})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := db.ClaimVerification(ctx, submission.ID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteVerification(ctx, claim, VerificationResult{ArtifactSHA256: submission.Artifact.SHA256, Pass: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: submission.ID, ReviewerID: "owner", Decision: "approve"}); err != nil {
		t.Fatal(err)
	}
	task.TaskVersion++
	raw, _ := json.Marshal(task)
	task.ContractHash, _ = contract.ComputeHash(raw)
	raw, _ = json.Marshal(task)
	if err = db.Publish(ctx, raw); !errors.Is(err, ErrClosed) {
		t.Fatal("publication reopened an accepted task", err)
	}
}
