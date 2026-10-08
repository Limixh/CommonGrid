package store

import (
	"context"

	"commongrid/coordinator/internal/contract"
	"github.com/jackc/pgx/v5"
)

type ProjectSummary struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Type        string `json:"type"`
	Description string `json:"description"`
}

type TaskRecord struct {
	Contract contract.TaskContract `json:"contract"`
	Status   string                `json:"status"`
}

func (s *Store) ListProjects(ctx context.Context, limit int, after string) ([]ProjectSummary, error) {
	if err := listBounds(limit, after); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT p.id,p.id,CASE WHEN count(DISTINCT v.contract->>'type')>1 THEN 'mixed'
        ELSE COALESCE(min(v.contract->>'type'),'software') END,'' FROM projects p
        LEFT JOIN tasks t ON t.project_id=p.id LEFT JOIN task_versions v ON (v.task_id,v.version,v.contract_hash)=(t.id,t.current_version,t.current_hash)
        WHERE p.id>$1 GROUP BY p.id ORDER BY p.id LIMIT $2`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ProjectSummary, 0)
	for rows.Next() {
		var item ProjectSummary
		if err = rows.Scan(&item.ID, &item.Title, &item.Type, &item.Description); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListTasks(ctx context.Context, projectID string, limit int, after string) ([]TaskRecord, error) {
	if err := listBounds(limit, after); err != nil {
		return nil, err
	}
	if projectID != "" && !validID.MatchString(projectID) {
		return nil, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT v.contract,t.status FROM tasks t JOIN task_versions v
        ON (v.task_id,v.version,v.contract_hash)=(t.id,t.current_version,t.current_hash)
        WHERE ($1='' OR t.project_id=$1) AND t.id>$2 ORDER BY t.id LIMIT $3`, projectID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]TaskRecord, 0)
	for rows.Next() {
		var raw []byte
		var item TaskRecord
		if err = rows.Scan(&raw, &item.Status); err != nil {
			return nil, err
		}
		if item.Contract, err = s.validator.Task(raw); err != nil {
			return nil, ErrInvariant
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) Task(ctx context.Context, id string) (TaskRecord, error) {
	if !validID.MatchString(id) {
		return TaskRecord{}, ErrInvalid
	}
	var raw []byte
	var item TaskRecord
	err := s.pool.QueryRow(ctx, `SELECT v.contract,t.status FROM tasks t JOIN task_versions v
        ON (v.task_id,v.version,v.contract_hash)=(t.id,t.current_version,t.current_hash) WHERE t.id=$1`, id).Scan(&raw, &item.Status)
	if err == pgx.ErrNoRows {
		return item, ErrNotFound
	}
	if err != nil {
		return item, err
	}
	if item.Contract, err = s.validator.Task(raw); err != nil {
		return TaskRecord{}, ErrInvariant
	}
	return item, nil
}

func (s *Store) ListUserLeases(ctx context.Context, userID string, limit int, after string) ([]Lease, error) {
	if !validID.MatchString(userID) {
		return nil, ErrInvalid
	}
	if err := listBounds(limit, after); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, "SELECT "+leaseColumns+" FROM leases WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT $3", userID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Lease, 0)
	for rows.Next() {
		item, err := scanLease(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListUserSubmissions(ctx context.Context, userID string, limit int, after string) ([]Submission, error) {
	if !validID.MatchString(userID) {
		return nil, ErrInvalid
	}
	if err := listBounds(limit, after); err != nil {
		return nil, err
	}
	return s.submissionList(ctx, "SELECT "+submissionColumns+" FROM submissions WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT $3", userID, after, limit)
}

func (s *Store) submissionList(ctx context.Context, query string, args ...any) ([]Submission, error) {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Submission, 0)
	for rows.Next() {
		item, err := scanSubmission(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListUserCheckpoints(ctx context.Context, userID string, limit int, after string) ([]CheckpointRecord, error) {
	if !validID.MatchString(userID) {
		return nil, ErrInvalid
	}
	if err := listBounds(limit, after); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, "SELECT "+checkpointColumns+" FROM checkpoints WHERE user_id=$1 AND id>$2 ORDER BY id LIMIT $3", userID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]CheckpointRecord, 0)
	for rows.Next() {
		item, err := scanCheckpoint(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListReviews(ctx context.Context, userID string, limit int, after string) ([]Submission, error) {
	if !validID.MatchString(userID) {
		return nil, ErrInvalid
	}
	if err := listBounds(limit, after); err != nil {
		return nil, err
	}
	// Subquery avoids ambiguous column names and preserves the shared scanner.
	return s.submissionList(ctx, `SELECT `+submissionColumns+` FROM submissions s WHERE id>$2 AND s.user_id<>$1
        AND s.status IN ('verified_candidate','in_review')
        AND EXISTS (SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id JOIN task_versions v
            ON (v.task_id,v.version,v.contract_hash)=(t.id,t.current_version,t.current_hash)
            WHERE (t.id,t.current_version,t.current_hash)=(s.task_id,s.task_version,s.contract_hash)
              AND t.status='awaiting_review' AND ((v.contract->'review'->>'policy'='maintainer' AND p.owner_id=$1)
                OR EXISTS (SELECT 1 FROM reviewer_grants g WHERE g.project_id=t.project_id AND g.user_id=$1
                    AND g.role=v.contract->'review'->>'policy')))
        ORDER BY id LIMIT $3`, userID, after, limit)
}
