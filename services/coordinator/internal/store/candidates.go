package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"commongrid/coordinator/internal/contract"
	"github.com/jackc/pgx/v5"
)

var ErrReviewDenied = errors.New("review_not_authorized")
var validBaseCommit = regexp.MustCompile(`^[a-f0-9]{40}$`)

// SubmitRequest is the worker boundary. Verification verdicts and reviewer
// eligibility are deliberately absent; only trusted server services set them.
type SubmitRequest struct {
	UserID       string
	LeaseID      string
	TaskVersion  int64
	ContractHash string
	RequestKey   string
	BaseCommit   string
	Artifact     ArtifactRef
}

func (r SubmitRequest) validate() error {
	if !validID.MatchString(r.UserID) || !validID.MatchString(r.LeaseID) || !validID.MatchString(r.RequestKey) || r.TaskVersion < 1 || !validHash.MatchString(r.ContractHash) || !validBaseCommit.MatchString(r.BaseCommit) {
		return ErrInvalid
	}
	return r.Artifact.validate()
}
func candidateHash(value any) string {
	raw, _ := json.Marshal(value)
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

type Submission struct {
	ID           string      `json:"id"`
	LeaseID      string      `json:"lease_id"`
	UserID       string      `json:"user_id"`
	TaskID       string      `json:"task_id"`
	TaskVersion  int64       `json:"task_version"`
	ContractHash string      `json:"contract_hash"`
	BaseCommit   string      `json:"base_commit"`
	Artifact     ArtifactRef `json:"artifact"`
	Status       string      `json:"status"`
	CreatedAt    time.Time   `json:"created_at"`
	VerifiedAt   *time.Time  `json:"verified_at,omitempty"`
	AcceptedAt   *time.Time  `json:"accepted_at,omitempty"`
}

const submissionColumns = `id,lease_id,user_id,task_id,task_version,contract_hash,base_commit,artifact_id,artifact_sha256,artifact_size_bytes,status,created_at,verified_at,accepted_at`

func scanSubmission(row pgx.Row) (Submission, error) {
	var r Submission
	err := row.Scan(&r.ID, &r.LeaseID, &r.UserID, &r.TaskID, &r.TaskVersion, &r.ContractHash, &r.BaseCommit, &r.Artifact.ID, &r.Artifact.SHA256, &r.Artifact.SizeBytes, &r.Status, &r.CreatedAt, &r.VerifiedAt, &r.AcceptedAt)
	if err == pgx.ErrNoRows {
		err = ErrNotFound
	}
	return r, err
}

// Submission returns a receipt only to its submitting user.
func (s *Store) Submission(ctx context.Context, userID, id string) (Submission, error) {
	if !validID.MatchString(userID) || !validID.MatchString(id) {
		return Submission{}, ErrInvalid
	}
	return scanSubmission(s.pool.QueryRow(ctx, "SELECT "+submissionColumns+" FROM submissions WHERE id=$1 AND user_id=$2", id, userID))
}

// Submit inserts a receipt and completes its still-running lease atomically.
// A completed lease is valid only for a replay of the receipt already created.
func (s *Store) Submit(ctx context.Context, r SubmitRequest) (Submission, error) {
	return s.submit(ctx, r, false)
}

// SubmitUploaded is the public delivery boundary. Trusted legacy domain tests
// can use Submit; HTTP and verifier delivery require a ready uploaded object.
func (s *Store) SubmitUploaded(ctx context.Context, r SubmitRequest) (Submission, error) {
	return s.submit(ctx, r, true)
}

func (s *Store) submit(ctx context.Context, r SubmitRequest, uploaded bool) (Submission, error) {
	if err := r.validate(); err != nil {
		return Submission{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer rollback(tx)
	var taskID, project, node string
	err = tx.QueryRow(ctx, `SELECT l.task_id,t.project_id,t.node_id FROM leases l JOIN tasks t ON t.id=l.task_id WHERE l.id=$1 AND l.user_id=$2`, r.LeaseID, r.UserID).Scan(&taskID, &project, &node)
	if err == pgx.ErrNoRows {
		return Submission{}, ErrNotFound
	}
	if err != nil {
		return Submission{}, err
	}
	if _, err = lockScopes(ctx, tx, project, node); err != nil {
		return Submission{}, err
	}
	task, _, status, _, err := lockTaskUser(ctx, tx, taskID, r.UserID)
	if err != nil {
		return Submission{}, err
	}
	lease, err := scanLease(tx.QueryRow(ctx, "SELECT "+leaseColumns+" FROM leases WHERE id=$1 FOR UPDATE", r.LeaseID))
	if err != nil {
		return Submission{}, err
	}
	if uploaded {
		if err = validateArtifactReferenceTx(ctx, tx, r.UserID, r.LeaseID, "result", r.Artifact); err != nil {
			return Submission{}, err
		}
	}
	var existingID, hash string
	err = tx.QueryRow(ctx, "SELECT id,request_hash FROM submissions WHERE user_id=$1 AND request_key=$2 FOR UPDATE", r.UserID, r.RequestKey).Scan(&existingID, &hash)
	if err == nil {
		if hash != candidateHash(r) {
			return Submission{}, ErrConflict
		}
		result, err := scanSubmission(tx.QueryRow(ctx, "SELECT "+submissionColumns+" FROM submissions WHERE id=$1", existingID))
		if err != nil {
			return Submission{}, err
		}
		return result, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return Submission{}, err
	}
	var receiptExists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM submissions WHERE lease_id=$1)", r.LeaseID).Scan(&receiptExists); err != nil {
		return Submission{}, err
	}
	if receiptExists {
		return Submission{}, ErrConflict
	}
	if task.TaskVersion != r.TaskVersion || task.ContractHash != r.ContractHash || lease.TaskVersion != r.TaskVersion || lease.ContractHash != r.ContractHash || task.Workspace.Commit != r.BaseCommit {
		return Submission{}, ErrStale
	}
	if status == "accepted" || status == "archived" {
		return Submission{}, ErrClosed
	}
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return Submission{}, err
	}
	if lease.State != "active" || !now.Before(lease.ExpiresAt) {
		return Submission{}, ErrClosed
	}
	result := Submission{ID: newID("submission-"), LeaseID: lease.ID, UserID: r.UserID, TaskID: taskID, TaskVersion: r.TaskVersion, ContractHash: r.ContractHash, BaseCommit: r.BaseCommit, Artifact: r.Artifact, Status: "submitted", CreatedAt: now}
	_, err = tx.Exec(ctx, `INSERT INTO submissions(id,lease_id,user_id,task_id,task_version,contract_hash,request_key,request_hash,base_commit,artifact_id,artifact_sha256,artifact_size_bytes,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'submitted',$13)`, result.ID, lease.ID, r.UserID, taskID, r.TaskVersion, r.ContractHash, r.RequestKey, candidateHash(r), r.BaseCommit, r.Artifact.ID, r.Artifact.SHA256, r.Artifact.SizeBytes, now)
	if err != nil {
		return Submission{}, err
	}
	if _, err = finishLease(ctx, tx, lease, now, "completed"); err != nil {
		return Submission{}, err
	}
	if err = emitDomain(ctx, tx, "submission.submitted", lease.ID, result.ID, result); err != nil {
		return Submission{}, err
	}
	return result, tx.Commit(ctx)
}

type VerificationClaim struct {
	SubmissionID string
	Token        string `json:"-"`
	Until        time.Time
	TaskVersion  int64
	ContractHash string
	Artifact     ArtifactRef
}

// VerificationResult is accepted only through the trusted verifier interface.
// It asserts the digest actually checked, never a worker's verified flag.
type VerificationResult struct {
	ArtifactSHA256 string
	Pass           bool
}

// lockCandidate holds the scopes and task lock before lease/receipt locks.
// The project budget serializes candidate selection, review and grant changes.
func lockCandidate(ctx context.Context, tx pgx.Tx, id string) (Submission, contract.TaskContract, string, string, error) {
	var taskID, project, node string
	err := tx.QueryRow(ctx, `SELECT s.task_id,t.project_id,t.node_id FROM submissions s JOIN tasks t ON t.id=s.task_id WHERE s.id=$1`, id).Scan(&taskID, &project, &node)
	if err == pgx.ErrNoRows {
		return Submission{}, contract.TaskContract{}, "", "", ErrNotFound
	}
	if err != nil {
		return Submission{}, contract.TaskContract{}, "", "", err
	}
	if _, err = lockScopes(ctx, tx, project, node); err != nil {
		return Submission{}, contract.TaskContract{}, "", "", err
	}
	var raw []byte
	var status, owner string
	err = tx.QueryRow(ctx, `SELECT v.contract,t.status,p.owner_id FROM tasks t JOIN task_versions v ON (v.task_id,v.version,v.contract_hash)=(t.id,t.current_version,t.current_hash) JOIN projects p ON p.id=t.project_id WHERE t.id=$1 FOR UPDATE OF t`, taskID).Scan(&raw, &status, &owner)
	if err != nil {
		return Submission{}, contract.TaskContract{}, "", "", err
	}
	var task contract.TaskContract
	if err = json.Unmarshal(raw, &task); err != nil {
		return Submission{}, task, "", "", err
	}
	// Receipt transitions do not change user capacity or lease accounting.
	r, err := scanSubmission(tx.QueryRow(ctx, "SELECT "+submissionColumns+" FROM submissions WHERE id=$1 FOR UPDATE", id))
	return r, task, status, owner, err
}
func candidateCurrent(r Submission, t contract.TaskContract) bool {
	return r.TaskVersion == t.TaskVersion && r.ContractHash == t.ContractHash && r.BaseCommit == t.Workspace.Commit
}

// ClaimVerification replaces an expired claim with a fresh fencing token.
func (s *Store) ClaimVerification(ctx context.Context, id string, ttl time.Duration) (VerificationClaim, error) {
	if !validID.MatchString(id) || ttl < time.Millisecond || ttl > 5*time.Minute {
		return VerificationClaim{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VerificationClaim{}, err
	}
	defer rollback(tx)
	r, task, status, _, err := lockCandidate(ctx, tx, id)
	if err != nil {
		return VerificationClaim{}, err
	}
	if !candidateCurrent(r, task) {
		return VerificationClaim{}, ErrStale
	}
	if status == "accepted" || status == "archived" || (r.Status != "submitted" && r.Status != "verifying") {
		return VerificationClaim{}, ErrClosed
	}
	var now time.Time
	var until *time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp(),verification_until FROM submissions WHERE id=$1", id).Scan(&now, &until); err != nil {
		return VerificationClaim{}, err
	}
	if until != nil && now.Before(*until) {
		return VerificationClaim{}, ErrCapacity
	}
	claim := VerificationClaim{SubmissionID: id, Token: newID("verify-"), Until: now.Add(ttl).Truncate(time.Microsecond), TaskVersion: r.TaskVersion, ContractHash: r.ContractHash, Artifact: r.Artifact}
	if _, err = tx.Exec(ctx, `UPDATE submissions SET status='verifying',verification_token=$2,verification_until=$3,verification_attempts=verification_attempts+1 WHERE id=$1`, id, claim.Token, claim.Until); err != nil {
		return VerificationClaim{}, err
	}
	return claim, tx.Commit(ctx)
}

func (s *Store) CompleteVerification(ctx context.Context, claim VerificationClaim, result VerificationResult) (Submission, error) {
	if !validID.MatchString(claim.SubmissionID) || !validID.MatchString(claim.Token) || !validHash.MatchString(result.ArtifactSHA256) || claim.Artifact.validate() != nil {
		return Submission{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer rollback(tx)
	r, task, status, _, err := lockCandidate(ctx, tx, claim.SubmissionID)
	if err != nil {
		return Submission{}, err
	}
	if !candidateCurrent(r, task) || claim.TaskVersion != r.TaskVersion || claim.ContractHash != r.ContractHash {
		return Submission{}, ErrStale
	}
	if claim.Artifact != r.Artifact || result.ArtifactSHA256 != r.Artifact.SHA256 {
		return Submission{}, ErrConflict
	}
	var token, finishedToken, finishedHash *string
	var until *time.Time
	var now time.Time
	err = tx.QueryRow(ctx, `SELECT verification_token,verification_until,verification_result_token,verification_result_hash,clock_timestamp() FROM submissions WHERE id=$1`, r.ID).Scan(&token, &until, &finishedToken, &finishedHash, &now)
	if err != nil {
		return Submission{}, err
	}
	fingerprint := candidateHash(struct {
		Claim  VerificationClaim
		Result VerificationResult
	}{claim, result})
	if finishedToken != nil && *finishedToken == claim.Token {
		if finishedHash == nil || *finishedHash != fingerprint {
			return Submission{}, ErrConflict
		}
		return r, tx.Commit(ctx)
	}
	if r.Status != "verifying" || token == nil || *token != claim.Token || until == nil || !until.Equal(claim.Until) || !now.Before(*until) {
		return Submission{}, ErrClaimLost
	}
	if status == "accepted" || status == "archived" {
		return Submission{}, ErrClosed
	}
	if result.Pass && task.Review.Policy == "auto" && (task.Type != "lean" || task.Kind == "plan" || task.Verification.Profile != "lean-proof") {
		return Submission{}, ErrInvalid
	}
	r.Status = "rejected"
	event := "submission.rejected"
	if result.Pass {
		r.Status = "verified_candidate"
		r.VerifiedAt = &now
		event = "submission.verified"
	}
	_, err = tx.Exec(ctx, `UPDATE submissions SET status=$2,verification_token=NULL,verification_until=NULL,verified_at=$3,verification_result_token=$4,verification_result_hash=$5 WHERE id=$1`, r.ID, r.Status, r.VerifiedAt, claim.Token, fingerprint)
	if err != nil {
		return Submission{}, err
	}
	if err = emitDomain(ctx, tx, event, r.LeaseID, r.ID, r); err != nil {
		return Submission{}, err
	}
	if result.Pass {
		if _, err = tx.Exec(ctx, "UPDATE tasks SET status='awaiting_review' WHERE id=$1", r.TaskID); err != nil {
			return Submission{}, err
		}
		if err = requestCandidateStops(ctx, tx, r.TaskID, now); err != nil {
			return Submission{}, err
		}
		if task.Review.Policy == "auto" {
			if err = acceptCandidate(ctx, tx, &r, now); err != nil {
				return Submission{}, err
			}
		}
	} else if err = reconcileTask(ctx, tx, r.TaskID); err != nil {
		return Submission{}, err
	}
	return r, tx.Commit(ctx)
}

// Request stop never releases a slot or settles budget. The worker must ACK
// with End, or the durable lease reaper must observe the existing deadline.
func requestCandidateStops(ctx context.Context, tx pgx.Tx, taskID string, now time.Time) error {
	rows, err := tx.Query(ctx, "SELECT "+leaseColumns+" FROM leases WHERE task_id=$1 AND state IN ('reserved','active') ORDER BY id FOR UPDATE", taskID)
	if err != nil {
		return err
	}
	var leases []Lease
	for rows.Next() {
		l, err := scanLease(rows)
		if err != nil {
			rows.Close()
			return err
		}
		leases = append(leases, l)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, l := range leases {
		l.State = "stop_requested"
		l.StopRequestedAt = &now
		if _, err = tx.Exec(ctx, "UPDATE leases SET state='stop_requested',stop_requested_at=$2 WHERE id=$1", l.ID, now); err != nil {
			return err
		}
		if err = emit(ctx, tx, "lease.stop_requested", l); err != nil {
			return err
		}
	}
	return nil
}

func acceptCandidate(ctx context.Context, tx pgx.Tx, r *Submission, now time.Time) error {
	if r.VerifiedAt == nil || (r.Status != "verified_candidate" && r.Status != "in_review") {
		return ErrClosed
	}
	var winner bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM submissions WHERE task_id=$1 AND status='accepted')", r.TaskID).Scan(&winner); err != nil {
		return err
	}
	if winner {
		return ErrClosed
	}
	if _, err := tx.Exec(ctx, "UPDATE submissions SET status='accepted',accepted_at=$2 WHERE id=$1", r.ID, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE tasks SET status='accepted' WHERE id=$1", r.TaskID); err != nil {
		return err
	}
	r.Status = "accepted"
	r.AcceptedAt = &now
	if err := requestCandidateStops(ctx, tx, r.TaskID, now); err != nil {
		return err
	}
	return emitDomain(ctx, tx, "task.accepted", r.LeaseID, r.TaskID, r)
}

// SetReviewerGrant is a trusted project administration boundary. Community
// grants must be issued only after server-side reputation checks; this store
// persists that authorization and accepts no worker-supplied eligibility flag.
func (s *Store) SetReviewerGrant(ctx context.Context, projectID, ownerID, reviewerID, role string, enabled bool) error {
	if !validID.MatchString(projectID) || !validID.MatchString(ownerID) || !validID.MatchString(reviewerID) || (role != "maintainer" && role != "community") {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var owner string
	err = tx.QueryRow(ctx, `SELECT p.owner_id FROM projects p JOIN budget_accounts b ON b.project_id=p.id AND b.scope='project' WHERE p.id=$1 FOR UPDATE OF b`, projectID).Scan(&owner)
	if err == pgx.ErrNoRows {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if owner != ownerID {
		return ErrReviewDenied
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)", reviewerID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	if enabled {
		_, err = tx.Exec(ctx, "INSERT INTO reviewer_grants(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", projectID, reviewerID, role)
	} else {
		_, err = tx.Exec(ctx, "DELETE FROM reviewer_grants WHERE project_id=$1 AND user_id=$2 AND role=$3", projectID, reviewerID, role)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type ReviewRequest struct {
	SubmissionID string
	ReviewerID   string
	Decision     string
	Comments     string
}

func (s *Store) ReviewCandidate(ctx context.Context, request ReviewRequest) (Submission, error) {
	if !validID.MatchString(request.SubmissionID) || !validID.MatchString(request.ReviewerID) || len(request.Comments) > 2048 || (request.Decision != "approve" && request.Decision != "reject" && request.Decision != "request_changes") {
		return Submission{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Submission{}, err
	}
	defer rollback(tx)
	r, task, status, owner, err := lockCandidate(ctx, tx, request.SubmissionID)
	if err != nil {
		return Submission{}, err
	}
	if !candidateCurrent(r, task) {
		return Submission{}, ErrStale
	}
	if r.UserID == request.ReviewerID || task.Review.Policy == "auto" {
		return Submission{}, ErrReviewDenied
	}
	var eligible bool
	err = tx.QueryRow(ctx, `SELECT $1='maintainer' AND $2=$3 OR EXISTS (SELECT 1 FROM reviewer_grants WHERE project_id=$4 AND user_id=$2 AND role=$1)`, task.Review.Policy, request.ReviewerID, owner, task.ProjectId).Scan(&eligible)
	if err != nil {
		return Submission{}, err
	}
	if !eligible {
		return Submission{}, ErrReviewDenied
	}
	var decision, comments string
	err = tx.QueryRow(ctx, "SELECT decision,comments FROM candidate_reviews WHERE submission_id=$1 AND reviewer_id=$2", r.ID, request.ReviewerID).Scan(&decision, &comments)
	if err == nil {
		if decision != request.Decision || comments != request.Comments {
			return Submission{}, ErrConflict
		}
		return r, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return Submission{}, err
	}
	if status == "accepted" || status == "archived" || r.VerifiedAt == nil || (r.Status != "verified_candidate" && r.Status != "in_review") {
		return Submission{}, ErrClosed
	}
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		return Submission{}, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO candidate_reviews(submission_id,reviewer_id,decision,comments) VALUES($1,$2,$3,$4)", r.ID, request.ReviewerID, request.Decision, request.Comments); err != nil {
		return Submission{}, err
	}
	switch request.Decision {
	case "reject":
		r.Status = "rejected"
	case "request_changes":
		r.Status = "changes_requested"
	case "approve":
		r.Status = "in_review"
	}
	if _, err = tx.Exec(ctx, "UPDATE submissions SET status=$2 WHERE id=$1", r.ID, r.Status); err != nil {
		return Submission{}, err
	}
	if err = emitDomain(ctx, tx, "submission.reviewed", r.LeaseID, r.ID, struct {
		SubmissionID string `json:"submission_id"`
		ReviewerID   string `json:"reviewer_id"`
		Decision     string `json:"decision"`
	}{r.ID, request.ReviewerID, request.Decision}); err != nil {
		return Submission{}, err
	}
	if request.Decision == "approve" {
		var approvals int64
		err = tx.QueryRow(ctx, `SELECT count(*) FROM candidate_reviews cr WHERE cr.submission_id=$1 AND cr.decision='approve' AND cr.reviewer_id<>$2 AND (($3='maintainer' AND cr.reviewer_id=$4) OR EXISTS(SELECT 1 FROM reviewer_grants g WHERE g.project_id=$5 AND g.user_id=cr.reviewer_id AND g.role=$3))`, r.ID, r.UserID, task.Review.Policy, owner, task.ProjectId).Scan(&approvals)
		if err != nil {
			return Submission{}, err
		}
		if approvals >= task.Review.RequiredApprovals {
			if err = acceptCandidate(ctx, tx, &r, now); err != nil {
				return Submission{}, err
			}
		}
	} else if err = reconcileTask(ctx, tx, r.TaskID); err != nil {
		return Submission{}, err
	}
	return r, tx.Commit(ctx)
}
