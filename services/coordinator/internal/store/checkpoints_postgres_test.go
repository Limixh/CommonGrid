package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"commongrid/coordinator/internal/contract"
)

func checkpointFixture(t *testing.T, max int64, exclusive bool) (*Store, contract.TaskContract, Lease) {
	t.Helper()
	db, task := databaseFixture(t, 10000000, 10000000, 20)
	task.TaskVersion++
	task.Handoff = contract.Handoff{Enabled: true, CheckpointIntervalSec: 60, MaxCheckpoints: max, AllowWorkspaceSnapshot: true, ResumeFromLatest: true}
	if exclusive {
		task.Parallelism = contract.Parallelism{Mode: "exclusive", Initial: 1, Cap: 1}
	}
	publishTestTask(t, db, &task)
	user(t, db, "worker", 2)
	request := requestFor(task, "worker", "checkpoint-lease")
	request.LimitSec = 20
	lease, err := db.Reserve(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	lease, err = db.Start(context.Background(), "worker", lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	return db, task, lease
}

func checkpointRequest(t *testing.T, task contract.TaskContract, lease Lease, id string, parent *string) SubmitCheckpointRequest {
	t.Helper()
	metadata := contract.Checkpoint{SchemaVersion: "1.0", CheckpointId: id, TaskId: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, LeaseId: lease.ID, ParentCheckpointId: parent, Type: "hard", BaseCommit: task.Workspace.Commit, Summary: "PRIVATE_UNTRUSTED_CHECKPOINT_TEXT", ContinuationInstructions: "PRIVATE_UNTRUSTED_CONTINUATION", ArtifactSha256: strings.Repeat("a", 64)}
	raw, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	return SubmitCheckpointRequest{UserID: lease.UserID, RequestKey: id, RawCheckpoint: raw, Artifact: ArtifactRef{ID: "artifact-" + id, SHA256: metadata.ArtifactSha256, SizeBytes: 1024}}
}

func checkpointVerdict(t *testing.T, db *Store, id, status string) CheckpointRecord {
	t.Helper()
	claim, err := db.ClaimCheckpointVerification(context.Background(), id, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	verdict := CheckpointVerificationVerdict{CheckpointID: id, Token: claim.Token, ArtifactSHA256: claim.Checkpoint.Artifact.SHA256, Status: status}
	if status == "rejected" {
		verdict.ReasonCode = "quick_check_failed"
	}
	record, err := db.FinishCheckpointVerification(context.Background(), verdict)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func latestRequest(task contract.TaskContract, lease Lease) LatestCheckpointRequest {
	return LatestCheckpointRequest{UserID: lease.UserID, TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, BaseCommit: task.Workspace.Commit, StrategyID: lease.StrategyID}
}

func checkpointCount(t *testing.T, db *Store) int {
	t.Helper()
	var count int
	if err := db.pool.QueryRow(context.Background(), "SELECT count(*) FROM checkpoints").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestPostgresCheckpointOwnershipFencesAndReceipts(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, false)
	ctx := context.Background()
	request := checkpointRequest(t, task, lease, "cp-first", nil)
	forged := request
	forged.UserID = "owner"
	if _, err := db.SubmitCheckpoint(ctx, forged); !errors.Is(err, ErrNotFound) {
		t.Fatal("other user submitted", err)
	}
	stale := request
	var metadata contract.Checkpoint
	_ = json.Unmarshal(stale.RawCheckpoint, &metadata)
	metadata.BaseCommit = strings.Repeat("f", 40)
	stale.RawCheckpoint, _ = json.Marshal(metadata)
	if _, err := db.SubmitCheckpoint(ctx, stale); !errors.Is(err, ErrStale) {
		t.Fatal("wrong base accepted", err)
	}
	submitted, err := db.SubmitCheckpoint(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := db.SubmitCheckpoint(ctx, request)
	if err != nil || replay.Metadata.CheckpointId != submitted.Metadata.CheckpointId || checkpointCount(t, db) != 1 {
		t.Fatal("receipt replay", err)
	}
	altered := request
	altered.Artifact.SizeBytes++
	if _, err := db.SubmitCheckpoint(ctx, altered); !errors.Is(err, ErrConflict) {
		t.Fatal("altered receipt accepted", err)
	}
	if _, err := db.End(ctx, lease.UserID, lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SubmitCheckpoint(ctx, request); err != nil {
		t.Fatal("lost-ack receipt replay after release", err)
	}
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-late", nil)); !errors.Is(err, ErrClosed) {
		t.Fatal("late new receipt", err)
	}
	checkpointVerdict(t, db, "cp-first", "usable") // Verifier continues after creator release.
	var status string
	if err := db.pool.QueryRow(ctx, "SELECT status FROM tasks WHERE id=$1", task.Id).Scan(&status); err != nil || status != "resumable" {
		t.Fatal("late verification did not reconcile task", status, err)
	}
	if _, err := db.Checkpoint(ctx, "owner", "cp-first"); !errors.Is(err, ErrNotFound) {
		t.Fatal("independent private checkpoint exposed", err)
	}
	latest := latestRequest(task, lease)
	latest.UserID = "owner"
	if _, err := db.LatestUsableCheckpoint(ctx, latest); !errors.Is(err, ErrNotFound) {
		t.Fatal("independent cross-user resume", err)
	}
	task.TaskVersion++
	task.Parallelism = contract.Parallelism{Mode: "exclusive", Initial: 1, Cap: 1}
	publishTestTask(t, db, &task)
	if _, err := db.Checkpoint(ctx, "owner", "cp-first"); !errors.Is(err, ErrNotFound) {
		t.Fatal("historical independent context leaked after mode change", err)
	}
	if _, err := db.LatestUsableCheckpoint(ctx, latestRequest(task, lease)); !errors.Is(err, ErrNotFound) {
		t.Fatal("old version resumed", err)
	}
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-old-lease", nil)); !errors.Is(err, ErrStale) {
		t.Fatal("old lease current contract submit", err)
	}
}

func TestPostgresCheckpointFallbackParentAndPrivacy(t *testing.T) {
	db, task, lease := checkpointFixture(t, 6, true)
	ctx := context.Background()
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-parent", nil)); err != nil {
		t.Fatal(err)
	}
	parent := checkpointVerdict(t, db, "cp-parent", "usable")
	parentID := parent.Metadata.CheckpointId
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-child", &parentID)); err != nil {
		t.Fatal(err)
	}
	child := checkpointVerdict(t, db, "cp-child", "rejected")
	if child.ExpiresAt.After(parent.ExpiresAt) {
		t.Fatal("child outlives ancestry")
	}
	latest := latestRequest(task, lease)
	latest.UserID = "owner"
	record, err := db.LatestUsableCheckpoint(ctx, latest)
	if err != nil || record.Metadata.CheckpointId != "cp-parent" {
		t.Fatal("rejected newest failed fallback", err)
	}
	rejected := child.Metadata.CheckpointId
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-rejected-parent", &rejected)); !errors.Is(err, ErrClosed) {
		t.Fatal("rejected parent adopted", err)
	}
	other := task
	other.Id = "other-task"
	other.TaskVersion = 1
	publishTestTask(t, db, &other)
	badParent := checkpointRequest(t, other, lease, "cp-cross-task", &parentID)
	// Give another valid lease for the other task, so failure isolates parent identity.
	req := requestFor(other, "worker", "other-lease")
	req.LimitSec = 20
	otherLease, err := db.Reserve(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	otherLease, err = db.Start(ctx, "worker", otherLease.ID)
	if err != nil {
		t.Fatal(err)
	}
	badParent = checkpointRequest(t, other, otherLease, "cp-cross-task", &parentID)
	if _, err := db.SubmitCheckpoint(ctx, badParent); !errors.Is(err, ErrStale) {
		t.Fatal("cross-task parent adopted", err)
	}
	var events string
	if err = db.pool.QueryRow(ctx, "SELECT string_agg(payload::text,' ') FROM outbox WHERE kind LIKE 'checkpoint.%'").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(events, "PRIVATE_UNTRUSTED") || strings.Contains(events, "cpclaim-") {
		t.Fatal("private text or claim token leaked to events")
	}
}

func TestPostgresCheckpointClaimFencingAndReplay(t *testing.T) {
	db, task, lease := checkpointFixture(t, 4, false)
	ctx := context.Background()
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-claim", nil)); err != nil {
		t.Fatal(err)
	}
	claim, err := db.ClaimCheckpointVerification(ctx, "cp-claim", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(claim)
	if strings.Contains(string(encoded), claim.Token) {
		t.Fatal("claim token serialized")
	}
	if _, err = db.ClaimCheckpointVerification(ctx, "cp-claim", time.Minute); !errors.Is(err, ErrClaimLost) {
		t.Fatal("duplicate active claim", err)
	}
	verdict := CheckpointVerificationVerdict{CheckpointID: "cp-claim", Token: claim.Token, ArtifactSHA256: strings.Repeat("b", 64), Status: "usable"}
	if _, err = db.FinishCheckpointVerification(ctx, verdict); !errors.Is(err, ErrClaimLost) {
		t.Fatal("digest fence", err)
	}
	if _, err = db.pool.Exec(ctx, "UPDATE checkpoints SET claim_until=clock_timestamp()-interval '1 second' WHERE id='cp-claim'"); err != nil {
		t.Fatal(err)
	}
	next, err := db.ClaimCheckpointVerification(ctx, "cp-claim", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	verdict.ArtifactSHA256 = claim.Checkpoint.Artifact.SHA256
	if _, err = db.FinishCheckpointVerification(ctx, verdict); !errors.Is(err, ErrClaimLost) {
		t.Fatal("old token adopted", err)
	}
	verdict.Token = next.Token
	record, err := db.FinishCheckpointVerification(ctx, verdict)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.pool.Exec(ctx, "UPDATE checkpoints SET claim_until=clock_timestamp()-interval '1 second' WHERE id='cp-claim'"); err != nil {
		t.Fatal(err)
	}
	replay, err := db.FinishCheckpointVerification(ctx, verdict)
	if err != nil || !replay.VerifiedAt.Equal(*record.VerifiedAt) {
		t.Fatal("completed verdict replay after claim TTL", err)
	}
	verdict.Status = "rejected"
	verdict.ReasonCode = "secret_detected"
	if _, err = db.FinishCheckpointVerification(ctx, verdict); !errors.Is(err, ErrConflict) {
		t.Fatal("changed final verdict", err)
	}
	verdict.Status = "usable"
	verdict.ReasonCode = ""
	verdict.ArtifactSHA256 = strings.Repeat("b", 64)
	if _, err = db.FinishCheckpointVerification(ctx, verdict); !errors.Is(err, ErrConflict) {
		t.Fatal("changed completed digest", err)
	}
}

func TestPostgresCheckpointConcurrentLimit(t *testing.T) {
	db, task, lease := checkpointFixture(t, 1, false)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make(chan error, 12)
	requests := make([]SubmitCheckpointRequest, 12)
	for index := range requests {
		requests[index] = checkpointRequest(t, task, lease, fmt.Sprintf("cp-concurrent-%d", index), nil)
	}
	for _, request := range requests {
		wg.Add(1)
		go func(request SubmitCheckpointRequest) {
			defer wg.Done()
			_, err := db.SubmitCheckpoint(ctx, request)
			results <- err
		}(request)
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrCapacity) {
			t.Fatal(err)
		}
	}
	if success != 1 || checkpointCount(t, db) != 1 {
		t.Fatal("checkpoint limit oversubscribed", success)
	}
}

func TestPostgresCheckpointAtomicOutboxFailure(t *testing.T) {
	db, task, lease := checkpointFixture(t, 4, false)
	ctx := context.Background()
	if _, err := db.pool.Exec(ctx, `CREATE FUNCTION checkpoint_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='checkpoint.submitted' THEN RAISE EXCEPTION 'fixture event failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER checkpoint_event_failure BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION checkpoint_event_failure()`); err != nil {
		t.Fatal(err)
	}
	request := checkpointRequest(t, task, lease, "cp-rollback", nil)
	if _, err := db.SubmitCheckpoint(ctx, request); err == nil {
		t.Fatal("injected outbox failure ignored")
	}
	if checkpointCount(t, db) != 0 {
		t.Fatal("metadata committed without event")
	}
	if _, err := db.pool.Exec(ctx, "DROP TRIGGER checkpoint_event_failure ON outbox"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SubmitCheckpoint(ctx, request); err != nil {
		t.Fatal("receipt not retryable after rollback", err)
	}
	claim, err := db.ClaimCheckpointVerification(ctx, "cp-rollback", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.pool.Exec(ctx, `CREATE OR REPLACE FUNCTION checkpoint_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='checkpoint.usable' THEN RAISE EXCEPTION 'fixture event failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER checkpoint_event_failure BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION checkpoint_event_failure()`); err != nil {
		t.Fatal(err)
	}
	verdict := CheckpointVerificationVerdict{CheckpointID: "cp-rollback", Token: claim.Token, ArtifactSHA256: claim.Checkpoint.Artifact.SHA256, Status: "usable"}
	if _, err := db.FinishCheckpointVerification(ctx, verdict); err == nil {
		t.Fatal("verdict outbox failure ignored")
	}
	record, err := db.Checkpoint(ctx, "worker", "cp-rollback")
	if err != nil || record.Status != "verifying" {
		t.Fatal("verdict escaped failed transaction", err)
	}
}

// Historic expiry fixture is inserted directly rather than waiting or changing
// immutable metadata. It contains no model calls or real artifact bytes.
func expiredCheckpointFixture(t *testing.T, db *Store, id string) {
	t.Helper()
	_, err := db.pool.Exec(context.Background(), `INSERT INTO checkpoints(id,task_id,task_version,contract_hash,lease_id,user_id,request_key,request_hash,parent_id,base_commit,metadata,artifact_id,artifact_sha256,artifact_size_bytes,status,created_at,expires_at,verified_at)
      SELECT $1,task_id,task_version,contract_hash,lease_id,user_id,$1,request_hash,NULL,base_commit,jsonb_set(metadata-'parent_checkpoint_id','{checkpoint_id}',to_jsonb($1::text)),artifact_id,artifact_sha256,artifact_size_bytes,'usable',clock_timestamp()-interval '8 days',clock_timestamp()-interval '1 day',clock_timestamp()-interval '8 days' FROM checkpoints ORDER BY created_at LIMIT 1`, id)
	if err != nil {
		t.Fatal(err)
	}
}

func TestPostgresCheckpointExpiryAndStaleVerification(t *testing.T) {
	db, task, lease := checkpointFixture(t, 6, false)
	ctx := context.Background()
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-live", nil)); err != nil {
		t.Fatal(err)
	}
	expiredCheckpointFixture(t, db, "cp-expired")
	// Newest usable metadata is expired; an older usable row is still valid.
	// The live submitted row is deliberately not a usable candidate.
	if _, err := db.pool.Exec(ctx, `INSERT INTO checkpoints(id,task_id,task_version,contract_hash,lease_id,user_id,request_key,request_hash,parent_id,base_commit,metadata,artifact_id,artifact_sha256,artifact_size_bytes,status,created_at,expires_at,verified_at)
      SELECT 'cp-historic-live',task_id,task_version,contract_hash,lease_id,user_id,'cp-historic-live',request_hash,NULL,base_commit,jsonb_set(metadata-'parent_checkpoint_id','{checkpoint_id}','"cp-historic-live"'),artifact_id,artifact_sha256,artifact_size_bytes,'usable',clock_timestamp()-interval '9 days',clock_timestamp()+interval '1 day',clock_timestamp()-interval '9 days' FROM checkpoints WHERE id='cp-live'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ClaimCheckpointVerification(ctx, "cp-expired", time.Minute); !errors.Is(err, ErrClosed) {
		t.Fatal("expired verification allowed", err)
	}
	parent := "cp-expired"
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-expired-child", &parent)); !errors.Is(err, ErrClosed) {
		t.Fatal("expired parent adopted", err)
	}
	record, err := db.LatestUsableCheckpoint(ctx, latestRequest(task, lease))
	if err != nil || record.Metadata.CheckpointId != "cp-historic-live" {
		t.Fatal("expired selected", err)
	}
	if _, err = db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-pending", nil)); err != nil {
		t.Fatal(err)
	}
	claim, err := db.ClaimCheckpointVerification(ctx, "cp-pending", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.End(ctx, "worker", lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	task.TaskVersion++
	publishTestTask(t, db, &task)
	if _, err = db.FinishCheckpointVerification(ctx, CheckpointVerificationVerdict{CheckpointID: "cp-pending", Token: claim.Token, ArtifactSHA256: claim.Checkpoint.Artifact.SHA256, Status: "usable"}); !errors.Is(err, ErrStale) {
		t.Fatal("stale version verifier accepted", err)
	}
}

func TestPostgresCheckpointStopAndTaskStateGates(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, false)
	ctx := context.Background()
	if _, err := db.pool.Exec(ctx, "UPDATE tasks SET status='awaiting_review' WHERE id=$1", task.Id); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-review-active", nil)); !errors.Is(err, ErrClosed) {
		t.Fatal("active submission during review", err)
	}
	if _, err := db.RequestStop(ctx, "worker", lease.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-review-stop", nil)); err != nil {
		t.Fatal("stop checkpoint blocked", err)
	}
	for _, status := range []string{"accepted", "archived"} {
		if _, err := db.pool.Exec(ctx, "UPDATE tasks SET status=$2 WHERE id=$1", task.Id, status); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-"+status, nil)); !errors.Is(err, ErrClosed) {
			t.Fatal("terminal task checkpoint", status, err)
		}
	}
}

func TestPostgresCheckpointLeaseStateAndHandoffPolicy(t *testing.T) {
	for _, policy := range []string{"disabled", "snapshot-disabled"} {
		t.Run(policy, func(t *testing.T) {
			db, task := databaseFixture(t, 10000000, 10000000, 2)
			ctx := context.Background()
			task.TaskVersion++
			task.Handoff.Enabled = policy != "disabled"
			task.Handoff.ResumeFromLatest = policy != "disabled"
			task.Handoff.AllowWorkspaceSnapshot = false
			publishTestTask(t, db, &task)
			user(t, db, "worker", 1)
			reserve := requestFor(task, "worker", "policy-lease")
			reserve.LimitSec = 20
			lease, err := db.Reserve(ctx, reserve)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-reserved", nil)); !errors.Is(err, ErrClosed) {
				t.Fatal("reserved producer accepted", err)
			}
			lease, err = db.Start(ctx, "worker", lease.ID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-policy", nil)); !errors.Is(err, ErrInvalid) {
				t.Fatal("handoff policy ignored", err)
			}
			if policy == "snapshot-disabled" {
				request := checkpointRequest(t, task, lease, "cp-soft", nil)
				var metadata contract.Checkpoint
				_ = json.Unmarshal(request.RawCheckpoint, &metadata)
				metadata.Type = "soft"
				request.RawCheckpoint, _ = json.Marshal(metadata)
				if _, err = db.SubmitCheckpoint(ctx, request); err != nil {
					t.Fatal("soft checkpoint incorrectly needs snapshot permission", err)
				}
			}
		})
	}
	t.Run("expired lease", func(t *testing.T) {
		db, task, lease := checkpointFixture(t, 4, false)
		ctx := context.Background()
		// Fixture clock is advanced by shortening the live lease while
		// preserving its created_at/expires_at SQL invariant.
		if _, err := db.pool.Exec(ctx, "UPDATE leases SET created_at=clock_timestamp()-interval '2 hours',started_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", lease.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-expired-producer", nil)); !errors.Is(err, ErrClosed) {
			t.Fatal("expired live producer accepted", err)
		}
	})
}

func TestPostgresCheckpointIndependentParentAndMetadataImmutability(t *testing.T) {
	db, task, lease := checkpointFixture(t, 5, false)
	ctx := context.Background()
	if _, err := db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-private-parent", nil)); err != nil {
		t.Fatal(err)
	}
	checkpointVerdict(t, db, "cp-private-parent", "usable")
	user(t, db, "worker2", 1)
	reserve := requestFor(task, "worker2", "other-private-lease")
	reserve.LimitSec = 20
	other, err := db.Reserve(ctx, reserve)
	if err != nil {
		t.Fatal(err)
	}
	other, err = db.Start(ctx, "worker2", other.ID)
	if err != nil {
		t.Fatal(err)
	}
	parent := "cp-private-parent"
	if _, err = db.SubmitCheckpoint(ctx, checkpointRequest(t, task, other, "cp-private-child", &parent)); !errors.Is(err, ErrInvalid) {
		t.Fatal("independent cross-user parent adopted", err)
	}
	if _, err = db.pool.Exec(ctx, "UPDATE checkpoints SET parent_id=id,metadata=jsonb_set(metadata,'{parent_checkpoint_id}',to_jsonb(id)) WHERE id='cp-private-parent'"); err == nil {
		t.Fatal("ancestry can mutate into cycle")
	}
	if _, err = db.pool.Exec(ctx, "UPDATE checkpoints SET expires_at=expires_at+interval '1 day' WHERE id='cp-private-parent'"); err == nil {
		t.Fatal("server retention mutable")
	}
	if _, err = db.pool.Exec(ctx, `INSERT INTO checkpoints(id,task_id,task_version,contract_hash,lease_id,user_id,request_key,request_hash,base_commit,metadata,artifact_id,artifact_sha256,artifact_size_bytes,created_at,expires_at)
      SELECT 'cp-forged-user',task_id,task_version,contract_hash,lease_id,'worker2','cp-forged-user',request_hash,base_commit,jsonb_set(metadata,'{checkpoint_id}','"cp-forged-user"'),artifact_id,artifact_sha256,artifact_size_bytes,created_at,expires_at FROM checkpoints WHERE id='cp-private-parent'`); err == nil {
		t.Fatal("SQL accepts forged lease/user identity")
	}
}

func TestPostgresCheckpointStrategyCompatibilityAndRetainedLimit(t *testing.T) {
	db, task := databaseFixture(t, 10000000, 10000000, 2)
	ctx := context.Background()
	task.TaskVersion++
	task.Parallelism = contract.Parallelism{Mode: "exclusive", Initial: 1, Cap: 1}
	alternate := task.Strategies[0]
	alternate.Id = "alternate"
	task.Strategies = append(task.Strategies, alternate)
	task.Handoff = contract.Handoff{Enabled: true, CheckpointIntervalSec: 60, MaxCheckpoints: 3, AllowWorkspaceSnapshot: true, ResumeFromLatest: true}
	publishTestTask(t, db, &task)
	user(t, db, "worker", 1)
	req := requestFor(task, "worker", "first-strategy")
	req.LimitSec = 20
	lease, err := db.Reserve(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	lease, err = db.Start(ctx, "worker", lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.SubmitCheckpoint(ctx, checkpointRequest(t, task, lease, "cp-strategy-parent", nil)); err != nil {
		t.Fatal(err)
	}
	checkpointVerdict(t, db, "cp-strategy-parent", "usable")
	if _, err = db.End(ctx, "worker", lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	req.RequestKey = "second-strategy"
	req.StrategyID = "alternate"
	next, err := db.Reserve(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	next, err = db.Start(ctx, "worker", next.ID)
	if err != nil {
		t.Fatal(err)
	}
	parent := "cp-strategy-parent"
	if _, err = db.SubmitCheckpoint(ctx, checkpointRequest(t, task, next, "cp-other-strategy", &parent)); !errors.Is(err, ErrInvalid) {
		t.Fatal("different strategy parent adopted", err)
	}
	if _, err = db.LatestUsableCheckpoint(ctx, latestRequest(task, next)); !errors.Is(err, ErrNotFound) {
		t.Fatal("different strategy resumed", err)
	}
	expiredCheckpointFixture(t, db, "cp-retained-expired-one")
	expiredCheckpointFixture(t, db, "cp-retained-expired-two")
	if _, err = db.SubmitCheckpoint(ctx, checkpointRequest(t, task, next, "cp-over-retained-limit", nil)); !errors.Is(err, ErrCapacity) {
		t.Fatal("expired retained rows bypass contract limit", err)
	}
}
