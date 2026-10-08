package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"commongrid/coordinator/internal/contract"
)

func candidateFixture(t *testing.T, policy string, required int64) (*Store, contract.TaskContract) {
	t.Helper()
	db, task := databaseFixture(t, 1000000, 1000000, 10)
	task.TaskVersion++
	task.Review = contract.Review{Policy: policy, RequiredApprovals: required}
	publishTestTask(t, db, &task)
	return db, task
}
func candidateLease(t *testing.T, db *Store, task contract.TaskContract, id string) Lease {
	t.Helper()
	user(t, db, id, 1)
	request := requestFor(task, id, "reserve")
	request.LimitSec = 20
	lease, err := db.Reserve(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	lease, err = db.Start(context.Background(), id, lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	return lease
}
func candidateRequest(task contract.TaskContract, lease Lease) SubmitRequest {
	return SubmitRequest{UserID: lease.UserID, LeaseID: lease.ID, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, RequestKey: "submit", BaseCommit: task.Workspace.Commit, Artifact: ArtifactRef{ID: "artifact-" + lease.UserID, SHA256: strings.Repeat("a", 64), SizeBytes: 1024}}
}
func submitCandidate(t *testing.T, db *Store, task contract.TaskContract, lease Lease) Submission {
	t.Helper()
	r, err := db.Submit(context.Background(), candidateRequest(task, lease))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func verifyCandidate(t *testing.T, db *Store, r Submission, pass bool) Submission {
	t.Helper()
	claim, err := db.ClaimVerification(context.Background(), r.ID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	r, err = db.CompleteVerification(context.Background(), claim, VerificationResult{ArtifactSHA256: r.Artifact.SHA256, Pass: pass})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func candidateStatus(t *testing.T, db *Store, id string) string {
	t.Helper()
	var status string
	if err := db.pool.QueryRow(context.Background(), "SELECT status FROM tasks WHERE id=$1", id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestPostgresSubmissionBoundToActiveLeaseAndImmutableReplay(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	lease := candidateLease(t, db, task, "worker")
	request := candidateRequest(task, lease)
	wrong := request
	wrong.UserID = "owner"
	if _, err := db.Submit(ctx, wrong); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-user receipt", err)
	}
	wrong = request
	wrong.TaskVersion++
	if _, err := db.Submit(ctx, wrong); !errors.Is(err, ErrStale) {
		t.Fatal("stale receipt", err)
	}
	wrong = request
	wrong.BaseCommit = strings.Repeat("f", 40)
	if _, err := db.Submit(ctx, wrong); !errors.Is(err, ErrStale) {
		t.Fatal("different base commit", err)
	}
	r, err := db.Submit(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := db.Submit(ctx, request)
	if err != nil || retry.ID != r.ID {
		t.Fatal("receipt replay", retry, err)
	}
	wrong = request
	wrong.Artifact.SizeBytes++
	if _, err = db.Submit(ctx, wrong); !errors.Is(err, ErrConflict) {
		t.Fatal("changed payload", err)
	}
	wrong = request
	wrong.RequestKey = "other-key"
	if _, err = db.Submit(ctx, wrong); !errors.Is(err, ErrConflict) {
		t.Fatal("second receipt on lease", err)
	}
	ended, err := db.Lease(ctx, "worker", lease.ID)
	if err != nil || ended.State != "completed" {
		t.Fatal("lease not completed atomically", ended, err)
	}
	reserved, spent := counters(t, db, "project:project")
	if reserved != 0 || spent != ended.SpentMs {
		t.Fatal("submission accounting", reserved, spent, ended)
	}
	if _, err = db.pool.Exec(ctx, "UPDATE submissions SET artifact_sha256=$2 WHERE id=$1", r.ID, strings.Repeat("b", 64)); err == nil {
		t.Fatal("receipt digest mutated")
	}
	if _, err = db.Submission(ctx, "owner", r.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-user read", err)
	}
	if _, err = db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "owner", Decision: "approve"}); !errors.Is(err, ErrClosed) {
		t.Fatal("unverified receipt reviewed", err)
	}
	if _, err = db.pool.Exec(ctx, "DELETE FROM submissions WHERE id=$1", r.ID); err == nil {
		t.Fatal("immutable receipt deleted")
	}
}

func TestPostgresSubmissionRequiresRunningUnexpiredLease(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	lease := candidateLease(t, db, task, "released")
	if _, err := db.End(ctx, lease.UserID, lease.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Submit(ctx, candidateRequest(task, lease)); !errors.Is(err, ErrClosed) {
		t.Fatal("released receipt accepted", err)
	}
	lease = candidateLease(t, db, task, "completed")
	if _, err := db.End(ctx, lease.UserID, lease.ID, "completed"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Submit(ctx, candidateRequest(task, lease)); !errors.Is(err, ErrClosed) {
		t.Fatal("receipt invented after completion", err)
	}
	lease = candidateLease(t, db, task, "expired")
	if _, err := db.pool.Exec(ctx, "UPDATE leases SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1", lease.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Submit(ctx, candidateRequest(task, lease)); !errors.Is(err, ErrClosed) {
		t.Fatal("expired receipt accepted", err)
	}
}

func TestPostgresVerifierFencingDigestAndCompletionReplay(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	r := submitCandidate(t, db, task, candidateLease(t, db, task, "worker"))
	old, err := db.ClaimVerification(ctx, r.ID, 15*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Until(old.Until) + 20*time.Millisecond)
	claim, err := db.ClaimVerification(ctx, r.ID, time.Minute+time.Nanosecond)
	if err != nil {
		t.Fatal(err)
	}
	result := VerificationResult{ArtifactSHA256: r.Artifact.SHA256, Pass: true}
	for _, field := range []string{"until", "token", "artifact_id", "artifact_size", "version", "hash"} {
		changed := claim
		expected := ErrConflict
		switch field {
		case "until":
			changed.Until = changed.Until.Add(time.Microsecond)
			expected = ErrClaimLost
		case "token":
			changed.Token = "foreign-token"
			expected = ErrClaimLost
		case "artifact_id":
			changed.Artifact.ID = "other-object"
		case "artifact_size":
			changed.Artifact.SizeBytes++
		case "version":
			changed.TaskVersion++
			expected = ErrStale
		case "hash":
			changed.ContractHash = strings.Repeat("f", 64)
			expected = ErrStale
		}
		if _, err = db.CompleteVerification(ctx, changed, result); !errors.Is(err, expected) {
			t.Fatal("claim binding failed", field, err)
		}
	}
	if _, err = db.CompleteVerification(ctx, old, result); !errors.Is(err, ErrClaimLost) {
		t.Fatal("stale verifier completed", err)
	}
	wrong := result
	wrong.ArtifactSHA256 = strings.Repeat("b", 64)
	if _, err = db.CompleteVerification(ctx, claim, wrong); !errors.Is(err, ErrConflict) {
		t.Fatal("different digest verified", err)
	}
	r, err = db.CompleteVerification(ctx, claim, result)
	if err != nil || r.Status != "verified_candidate" {
		t.Fatal(r, err)
	}
	retry, err := db.CompleteVerification(ctx, claim, result)
	if err != nil || retry.ID != r.ID {
		t.Fatal("verifier replay", retry, err)
	}
	wrong = result
	wrong.Pass = false
	if _, err = db.CompleteVerification(ctx, claim, wrong); !errors.Is(err, ErrConflict) {
		t.Fatal("changed verdict replay", err)
	}
	if _, err = db.CompleteVerification(ctx, old, result); !errors.Is(err, ErrClaimLost) {
		t.Fatal("superseded verifier replay", err)
	}
	if _, err = db.ClaimVerification(ctx, r.ID, time.Minute); !errors.Is(err, ErrClosed) {
		t.Fatal("candidate reverified without new receipt", err)
	}
	changedClaim := claim
	changedClaim.Until = changedClaim.Until.Add(time.Second)
	if _, err = db.CompleteVerification(ctx, changedClaim, result); !errors.Is(err, ErrConflict) {
		t.Fatal("changed completed claim", err)
	}
}

func TestPostgresCandidateStopRetainsSlotAndBudgetUntilAck(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	lease := candidateLease(t, db, task, "submitter")
	peer := candidateLease(t, db, task, "peer")
	r := submitCandidate(t, db, task, lease)
	r = verifyCandidate(t, db, r, true)
	stopped, err := db.Lease(ctx, "peer", peer.ID)
	if err != nil || stopped.State != "stop_requested" || stopped.EndedAt != nil {
		t.Fatal("peer was released", stopped, err)
	}
	reserved, _ := counters(t, db, "project:project")
	if reserved != peer.ReservedMs {
		t.Fatal("peer reservation prematurely released", reserved)
	}
	other := task
	other.Id = "other-task"
	other.TaskVersion = 1
	publishTestTask(t, db, &other)
	if _, err = db.Reserve(ctx, requestFor(other, "peer", "other")); !errors.Is(err, ErrCapacity) {
		t.Fatal("stop released user slot", err)
	}
	review, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "owner", Decision: "approve"})
	if err != nil || review.Status != "accepted" {
		t.Fatal(review, err)
	}
	reserved, _ = counters(t, db, "project:project")
	if reserved != peer.ReservedMs {
		t.Fatal("acceptance fabricated peer end", reserved)
	}
	if _, err = db.End(ctx, "peer", peer.ID, "stopped"); err != nil {
		t.Fatal(err)
	}
	reserved, _ = counters(t, db, "project:project")
	if reserved != 0 {
		t.Fatal("ACK did not settle", reserved)
	}
}

func TestPostgresCompetingCandidatesAtomicOneWinner(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	// Both receipts precede either trusted verification completion.
	first := submitCandidate(t, db, task, candidateLease(t, db, task, "worker-one"))
	second := submitCandidate(t, db, task, candidateLease(t, db, task, "worker-two"))
	first = verifyCandidate(t, db, first, true)
	second = verifyCandidate(t, db, second, true)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, r := range []Submission{first, second} {
		wg.Add(1)
		go func(r Submission) {
			defer wg.Done()
			_, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "owner", Decision: "approve"})
			results <- err
		}(r)
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrClosed) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal("winner race", success)
	}
	var winners int
	if err := db.pool.QueryRow(ctx, "SELECT count(*) FROM submissions WHERE task_id=$1 AND status='accepted'", task.Id).Scan(&winners); err != nil || winners != 1 {
		t.Fatal("atomic winner", winners, err)
	}
	if candidateStatus(t, db, task.Id) != "accepted" {
		t.Fatal("task not accepted")
	}
	loser := first
	var status string
	if err := db.pool.QueryRow(ctx, "SELECT status FROM submissions WHERE id=$1", first.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status == "accepted" {
		loser = second
	}
	if _, err := db.pool.Exec(ctx, "UPDATE submissions SET status='accepted',accepted_at=clock_timestamp() WHERE id=$1", loser.ID); err == nil {
		t.Fatal("SQL allowed second winner")
	}
	if _, err := db.pool.Exec(ctx, "UPDATE submissions SET status='rejected',accepted_at=NULL WHERE task_id=$1 AND status='accepted'", task.Id); err == nil {
		t.Fatal("accepted winner changed")
	}
}

func TestPostgresLeanAutoAcceptAndReplayAfterDeadline(t *testing.T) {
	db, task := candidateFixture(t, "auto", 0)
	ctx := context.Background()
	r := submitCandidate(t, db, task, candidateLease(t, db, task, "worker"))
	claim, err := db.ClaimVerification(ctx, r.ID, 150*time.Millisecond+time.Nanosecond)
	if err != nil {
		t.Fatal(err)
	}
	result := VerificationResult{ArtifactSHA256: r.Artifact.SHA256, Pass: true}
	r, err = db.CompleteVerification(ctx, claim, result)
	if err != nil || r.Status != "accepted" || r.VerifiedAt == nil || r.AcceptedAt == nil {
		t.Fatal("Lean auto flow", r, err)
	}
	before := countRows(t, db, "outbox")
	time.Sleep(time.Until(claim.Until) + 20*time.Millisecond)
	retry, err := db.CompleteVerification(ctx, claim, result)
	if err != nil || retry.ID != r.ID || retry.Status != "accepted" {
		t.Fatal("committed completion replay expired", retry, err)
	}
	if countRows(t, db, "outbox") != before {
		t.Fatal("replay emitted duplicate event")
	}
	if candidateStatus(t, db, task.Id) != "accepted" {
		t.Fatal("auto task not accepted")
	}
}

func TestPostgresReviewEligibilityDistinctApprovalsAndRevocation(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 2)
	ctx := context.Background()
	r := verifyCandidate(t, db, submitCandidate(t, db, task, candidateLease(t, db, task, "worker")), true)
	user(t, db, "maintainer", 1)
	user(t, db, "outsider", 1)
	user(t, db, "replacement", 1)
	if _, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "worker", Decision: "approve"}); !errors.Is(err, ErrReviewDenied) {
		t.Fatal("self review", err)
	}
	if _, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "outsider", Decision: "approve"}); !errors.Is(err, ErrReviewDenied) {
		t.Fatal("unassigned reviewer", err)
	}
	if err := db.SetReviewerGrant(ctx, task.ProjectId, "outsider", "outsider", "maintainer", true); !errors.Is(err, ErrReviewDenied) {
		t.Fatal("grant spoof", err)
	}
	if err := db.SetReviewerGrant(ctx, task.ProjectId, "owner", "maintainer", "maintainer", true); err != nil {
		t.Fatal(err)
	}
	request := ReviewRequest{SubmissionID: r.ID, ReviewerID: "maintainer", Decision: "approve"}
	r, err := db.ReviewCandidate(ctx, request)
	if err != nil || r.Status != "in_review" {
		t.Fatal(r, err)
	}
	if _, err = db.ReviewCandidate(ctx, request); err != nil {
		t.Fatal("review replay", err)
	}
	if err = db.SetReviewerGrant(ctx, task.ProjectId, "owner", "maintainer", "maintainer", false); err != nil {
		t.Fatal(err)
	}
	r, err = db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "owner", Decision: "approve"})
	if err != nil || r.Status != "in_review" {
		t.Fatal("revoked approval counted", r, err)
	}
	if err = db.SetReviewerGrant(ctx, task.ProjectId, "owner", "replacement", "maintainer", true); err != nil {
		t.Fatal(err)
	}
	r, err = db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "replacement", Decision: "approve"})
	if err != nil || r.Status != "accepted" {
		t.Fatal("eligible quorum failed", r, err)
	}
}

func TestPostgresRejectReopensOnlyWithoutPendingCandidates(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	first := submitCandidate(t, db, task, candidateLease(t, db, task, "worker-one"))
	second := submitCandidate(t, db, task, candidateLease(t, db, task, "worker-two"))
	first = verifyCandidate(t, db, first, true)
	if _, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: first.ID, ReviewerID: "owner", Decision: "reject"}); err != nil {
		t.Fatal(err)
	}
	if candidateStatus(t, db, task.Id) != "awaiting_review" {
		t.Fatal("pending receipt ignored")
	}
	second = verifyCandidate(t, db, second, false)
	if second.Status != "rejected" || candidateStatus(t, db, task.Id) != "open" {
		t.Fatal("last rejection failed to reopen", second)
	}
	if _, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: first.ID, ReviewerID: "owner", Decision: "approve"}); !errors.Is(err, ErrConflict) {
		t.Fatal("rejected receipt accepted", err)
	}
}

func TestPostgresChangesRequestedReopensWithNoOtherCandidate(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	r := verifyCandidate(t, db, submitCandidate(t, db, task, candidateLease(t, db, task, "worker")), true)
	r, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "owner", Decision: "request_changes", Comments: "revise the boundary"})
	if err != nil || r.Status != "changes_requested" {
		t.Fatal(r, err)
	}
	if candidateStatus(t, db, task.Id) != "open" {
		t.Fatal("changes did not reopen")
	}
}

func TestPostgresCommunityGrantRequired(t *testing.T) {
	db, task := candidateFixture(t, "community", 1)
	ctx := context.Background()
	r := verifyCandidate(t, db, submitCandidate(t, db, task, candidateLease(t, db, task, "worker")), true)
	if _, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "owner", Decision: "approve"}); !errors.Is(err, ErrReviewDenied) {
		t.Fatal("owner bypassed community eligibility", err)
	}
	user(t, db, "qualified", 1)
	if err := db.SetReviewerGrant(ctx, task.ProjectId, "owner", "qualified", "community", true); err != nil {
		t.Fatal(err)
	}
	r, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "qualified", Decision: "approve"})
	if err != nil || r.Status != "accepted" {
		t.Fatal(r, err)
	}
}

func TestPostgresCandidateEventFailureRollsBackReceiptAndLease(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	lease := candidateLease(t, db, task, "worker")
	if _, err := db.pool.Exec(ctx, `CREATE FUNCTION candidate_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='submission.submitted' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$; CREATE TRIGGER candidate_event_injection BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION candidate_event_failure()`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Submit(ctx, candidateRequest(task, lease)); err == nil {
		t.Fatal("event failure did not abort")
	}
	current, err := db.Lease(ctx, lease.UserID, lease.ID)
	if err != nil || current.State != "active" {
		t.Fatal("failed event settled lease", current, err)
	}
	reserved, spent := counters(t, db, "project:project")
	if reserved != lease.ReservedMs || spent != 0 {
		t.Fatal("failed event changed budget", reserved, spent)
	}
	var receipts int
	if err = db.pool.QueryRow(ctx, "SELECT count(*) FROM submissions").Scan(&receipts); err != nil || receipts != 0 {
		t.Fatal("partial receipt", receipts, err)
	}
}

func TestPostgresAcceptanceEventFailureRollsBackWinnerAndReview(t *testing.T) {
	db, task := candidateFixture(t, "maintainer", 1)
	ctx := context.Background()
	r := verifyCandidate(t, db, submitCandidate(t, db, task, candidateLease(t, db, task, "worker")), true)
	if _, err := db.pool.Exec(ctx, `CREATE FUNCTION acceptance_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='task.accepted' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$; CREATE TRIGGER acceptance_event_injection BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION acceptance_event_failure()`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ReviewCandidate(ctx, ReviewRequest{SubmissionID: r.ID, ReviewerID: "owner", Decision: "approve"}); err == nil {
		t.Fatal("accept event failure ignored")
	}
	current, err := db.Submission(ctx, r.UserID, r.ID)
	if err != nil || current.Status != "verified_candidate" {
		t.Fatal("partial winner", current, err)
	}
	if candidateStatus(t, db, task.Id) != "awaiting_review" {
		t.Fatal("partial task acceptance")
	}
	var reviews int
	if err = db.pool.QueryRow(ctx, "SELECT count(*) FROM candidate_reviews").Scan(&reviews); err != nil || reviews != 0 {
		t.Fatal("partial review", reviews, err)
	}
}

func TestSubmissionValidationBoundedArtifacts(t *testing.T) {
	r := SubmitRequest{UserID: "user", LeaseID: "lease", TaskVersion: 1, ContractHash: strings.Repeat("a", 64), RequestKey: "key", BaseCommit: strings.Repeat("b", 40), Artifact: ArtifactRef{ID: "artifact", SHA256: strings.Repeat("c", 64), SizeBytes: 67108864}}
	if err := r.validate(); err != nil {
		t.Fatal(err)
	}
	r.Artifact.SizeBytes++
	if !errors.Is(r.validate(), ErrInvalid) {
		t.Fatal("unbounded artifact accepted")
	}
	r.Artifact.SizeBytes = 1
	r.Artifact.ID = "../../secret"
	if !errors.Is(r.validate(), ErrInvalid) {
		t.Fatal("filesystem path accepted as opaque ref")
	}
}

func TestVerificationClaimTokenExcludedFromJSON(t *testing.T) {
	claim := VerificationClaim{SubmissionID: "receipt", Token: "private-verifier-token"}
	raw, err := json.Marshal(claim)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), claim.Token) || strings.Contains(string(raw), "Token") {
		t.Fatal("claim token serialized", string(raw))
	}
}
