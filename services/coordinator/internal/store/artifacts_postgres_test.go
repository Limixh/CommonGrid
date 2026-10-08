package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"commongrid/coordinator/internal/contract"
)

func artifactRegistration(task contract.TaskContract, lease Lease, key string, index int) ArtifactRegistration {
	return ArtifactRegistration{UserID: lease.UserID, LeaseID: lease.ID, TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, BaseCommit: task.Workspace.Commit, StrategyID: lease.StrategyID, Purpose: "result", RequestKey: key, ScanPolicy: "archive-safety", ScanPolicyVersion: "1", Artifact: ArtifactRef{ID: fmt.Sprintf("artifact-%032x", index), SHA256: strings.Repeat("a", 64), SizeBytes: 1024}}
}

func TestPostgresArtifactOwnershipPendingAndImmutableBinding(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, false)
	ctx := context.Background()
	request := artifactRegistration(task, lease, "upload", 1)
	pending, err := db.RegisterArtifact(ctx, request)
	if err != nil || pending.State != "pending" {
		t.Fatal("register", pending, err)
	}
	if _, err = db.ArtifactForOwner(ctx, "owner", request.Artifact.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross owner lookup", err)
	}
	if err = db.ValidateArtifactReference(ctx, lease.UserID, lease.ID, "result", request.Artifact); !errors.Is(err, ErrNotFound) {
		t.Fatal("pending usable", err)
	}
	if _, err = db.MarkArtifactStored(ctx, "owner", request.Artifact.ID, request.Artifact); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign completion", err)
	}
	forged := request.Artifact
	forged.SHA256 = strings.Repeat("b", 64)
	if _, err = db.MarkArtifactStored(ctx, lease.UserID, forged.ID, forged); !errors.Is(err, ErrConflict) {
		t.Fatal("wrong completion", err)
	}
	ready, err := db.MarkArtifactStored(ctx, lease.UserID, request.Artifact.ID, request.Artifact)
	if err != nil || ready.State != "ready" {
		t.Fatal("completion", ready, err)
	}
	if err = db.ValidateArtifactReference(ctx, lease.UserID, lease.ID, "result", request.Artifact); err != nil {
		t.Fatal("ready reference", err)
	}
	if err = db.ValidateArtifactReference(ctx, lease.UserID, lease.ID, "checkpoint", request.Artifact); !errors.Is(err, ErrNotFound) {
		t.Fatal("wrong purpose", err)
	}
	if _, err = db.pool.Exec(ctx, "UPDATE artifacts SET base_commit=$2 WHERE id=$1", request.Artifact.ID, strings.Repeat("f", 40)); err == nil {
		t.Fatal("binding mutable")
	}
	if _, err = db.pool.Exec(ctx, "UPDATE artifacts SET state='pending' WHERE id=$1", request.Artifact.ID); err == nil {
		t.Fatal("ready downgraded")
	}
	if _, err = db.pool.Exec(ctx, "DELETE FROM artifacts WHERE id=$1", request.Artifact.ID); err == nil {
		t.Fatal("identity deleted")
	}
	altered := request
	altered.ScanPolicyVersion = "2"
	if _, err = db.RegisterArtifact(ctx, altered); !errors.Is(err, ErrConflict) {
		t.Fatal("changed scan retry", err)
	}
	submissionRequest := candidateRequest(task, lease)
	submissionRequest.Artifact = request.Artifact
	submitted, err := db.SubmitUploaded(ctx, submissionRequest)
	if err != nil {
		t.Fatal("submit uploaded", err)
	}
	worker, err := db.ArtifactForSubmission(ctx, submitted.ID)
	if err != nil || worker.Artifact != request.Artifact || worker.LeaseID != lease.ID {
		t.Fatal("worker binding", worker, err)
	}
	// Both byte reservation and uploaded metadata replay remain idempotent
	// after their producer lease has completed.
	replay, err := db.RegisterArtifact(ctx, request)
	if err != nil || replay != ready {
		t.Fatal("closed exact retry", replay, err)
	}
	if _, err = db.SubmitUploaded(ctx, submissionRequest); err != nil {
		t.Fatal("metadata replay", err)
	}
	next := request
	next.RequestKey = "late"
	next.Artifact.ID = fmt.Sprintf("artifact-%032x", 2)
	if _, err = db.RegisterArtifact(ctx, next); !errors.Is(err, ErrClosed) {
		t.Fatal("late registration", err)
	}
}

func TestPostgresArtifactFencesAndTrustedCheckpointLookup(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, false)
	ctx := context.Background()
	request := artifactRegistration(task, lease, "checkpoint-upload", 10)
	for _, mutate := range []func(*ArtifactRegistration){
		func(r *ArtifactRegistration) { r.UserID = "owner" },
		func(r *ArtifactRegistration) { r.BaseCommit = strings.Repeat("f", 40) },
		func(r *ArtifactRegistration) { r.StrategyID = "foreign-strategy" },
		func(r *ArtifactRegistration) { r.TaskVersion++ },
		func(r *ArtifactRegistration) { r.ContractHash = strings.Repeat("f", 64) },
	} {
		wrong := request
		mutate(&wrong)
		if _, err := db.RegisterArtifact(ctx, wrong); err == nil {
			t.Fatal("forged binding accepted", wrong)
		}
	}
	lease, err := db.RequestStop(ctx, lease.UserID, lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.RegisterArtifact(ctx, request); !errors.Is(err, ErrClosed) {
		t.Fatal("result from stop request", err)
	}
	request.Purpose = "checkpoint"
	if _, err = db.RegisterArtifact(ctx, request); err != nil {
		t.Fatal("checkpoint at stop", err)
	}
	cp := checkpointRequest(t, task, lease, "registered-checkpoint", nil)
	cp.Artifact = request.Artifact
	if _, err = db.SubmitUploadedCheckpoint(ctx, cp); !errors.Is(err, ErrNotFound) {
		t.Fatal("pending checkpoint submitted", err)
	}
	// Trusted legacy metadata may exist, but worker resolution must still fail
	// closed until the exact reservation has durable bytes.
	if _, err = db.SubmitCheckpoint(ctx, cp); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ArtifactForCheckpoint(ctx, "registered-checkpoint"); !errors.Is(err, ErrNotFound) {
		t.Fatal("pending worker read", err)
	}
	if _, err = db.MarkArtifactStored(ctx, lease.UserID, request.Artifact.ID, request.Artifact); err != nil {
		t.Fatal(err)
	}
	worker, err := db.ArtifactForCheckpoint(ctx, "registered-checkpoint")
	if err != nil || worker.Purpose != "checkpoint" || worker.Artifact != request.Artifact {
		t.Fatal("checkpoint binding", worker, err)
	}
	if _, err = db.ArtifactForSubmission(ctx, "registered-checkpoint"); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross receipt lookup", err)
	}
	// A result registry entry cannot vouch for checkpoint metadata, even when
	// a trusted fixture writes matching digest and size.
	other := cp
	other.RequestKey = "wrong-purpose"
	var metadata contract.Checkpoint
	if err = json.Unmarshal(other.RawCheckpoint, &metadata); err != nil {
		t.Fatal(err)
	}
	metadata.CheckpointId = "wrong-purpose"
	other.RawCheckpoint, _ = json.Marshal(metadata)
	other.Artifact.ID = fmt.Sprintf("artifact-%032x", 99)
	if _, err = db.SubmitCheckpoint(ctx, other); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ArtifactForCheckpoint(ctx, "wrong-purpose"); !errors.Is(err, ErrNotFound) {
		t.Fatal("unregistered trusted bytes accepted", err)
	}
}

func TestPostgresArtifactAtomicRetryAndRetainedByteCap(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, false)
	ctx := context.Background()
	request := artifactRegistration(task, lease, "concurrent-upload", 20)
	request.Artifact.SizeBytes = 64 * 1024 * 1024
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := db.RegisterArtifact(ctx, request); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var count int
	if err := db.pool.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE user_id=$1", lease.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate retry", count, err)
	}
	for i := 1; i < 4; i++ {
		r := request
		r.RequestKey = fmt.Sprintf("capacity-%d", i)
		r.Artifact.ID = fmt.Sprintf("artifact-%032x", 20+i)
		if _, err := db.RegisterArtifact(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	excess := request
	excess.RequestKey = "excess"
	excess.Artifact.ID = fmt.Sprintf("artifact-%032x", 30)
	excess.Artifact.SizeBytes = 1
	if _, err := db.RegisterArtifact(ctx, excess); !errors.Is(err, ErrCapacity) {
		t.Fatal("retained byte limit bypass", err)
	}
	// Parallel storage completion shares one immutable ready transition.
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r, err := db.MarkArtifactStored(ctx, lease.UserID, request.Artifact.ID, request.Artifact); err != nil || r.State != "ready" {
				t.Error("completion race", r.State, err)
			}
		}()
	}
	wg.Wait()
}

func TestPostgresArtifactRetainedRecordCapAndExpiry(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, false)
	ctx := context.Background()
	for i := 0; i < MaxRetainedArtifacts; i++ {
		r := artifactRegistration(task, lease, fmt.Sprintf("small-%d", i), 100+i)
		r.Artifact.SizeBytes = 1
		if _, err := db.RegisterArtifact(ctx, r); err != nil {
			t.Fatal(i, err)
		}
	}
	next := artifactRegistration(task, lease, "too-many", 200)
	if _, err := db.RegisterArtifact(ctx, next); !errors.Is(err, ErrCapacity) {
		t.Fatal("retained record cap bypass", err)
	}
	// Expiry uses the database clock and fences both purposes before any write.
	if _, err := db.pool.Exec(ctx, "UPDATE leases SET created_at=clock_timestamp()-interval '2 seconds',started_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", lease.ID); err != nil {
		t.Fatal(err)
	}
	next.Purpose = "checkpoint"
	if _, err := db.RegisterArtifact(ctx, next); !errors.Is(err, ErrClosed) {
		t.Fatal("expired lease accepted", err)
	}
}
