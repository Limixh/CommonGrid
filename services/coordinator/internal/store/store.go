// Package store implements durable domain primitives. It is not connected to
// unauthenticated development HTTP writes; the CLI isolation gate stays closed.
package store

import (
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"commongrid/coordinator/internal/contract"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct {
	pool      *pgxpool.Pool
	schema    string
	validator *contract.Validator
}

func Open(ctx context.Context, dsn, schema string) (*Store, error) {
	if !regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`).MatchString(schema) || strings.HasPrefix(schema, "pg_") || schema == "information_schema" || schema == "public" {
		return nil, ErrInvalid
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	config.MaxConns = 24
	config.ConnConfig.RuntimeParams["search_path"] = "pg_catalog," + pgx.Identifier{schema}.Sanitize()
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	config.ConnConfig.RuntimeParams["lock_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	validator, err := contract.NewValidator()
	if err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool, schema: schema, validator: validator}, nil
}
func (s *Store) Close() { s.pool.Close() }

func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

// Migration changes are rejected by hash; concurrent migrators share a
// transaction-scoped lock. No automatic destructive down migration is exposed.
func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(714831920)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE SCHEMA IF NOT EXISTS "+pgx.Identifier{s.schema}.Sanitize()); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SET LOCAL search_path TO "+pgx.Identifier{s.schema}.Sanitize()+",pg_catalog"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`); err != nil {
		return err
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		raw, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		hash := fmt.Sprintf("%x", sha256.Sum256(raw))
		var recorded string
		err = tx.QueryRow(ctx, "SELECT sha256 FROM schema_migrations WHERE name=$1", entry.Name()).Scan(&recorded)
		if err == nil {
			if recorded != hash {
				return fmt.Errorf("migration changed: %s", entry.Name())
			}
			continue
		}
		if err != pgx.ErrNoRows {
			return err
		}
		if _, err = tx.Exec(ctx, string(raw)); err != nil {
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		if _, err = tx.Exec(ctx, "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)", entry.Name(), hash); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) CreateUser(ctx context.Context, id string, maxConcurrent int) error {
	if !validID.MatchString(id) || maxConcurrent < 1 || maxConcurrent > 64 {
		return ErrInvalid
	}
	_, err := s.pool.Exec(ctx, "INSERT INTO users(id,max_concurrent) VALUES($1,$2)", id, maxConcurrent)
	return err
}
func (s *Store) CreateProject(ctx context.Context, id, owner string, limitMs, maxAttemptSec int64) error {
	if !validID.MatchString(id) || !validID.MatchString(owner) || limitMs < 1 || limitMs > 9000000000000 || maxAttemptSec < 1 || maxAttemptSec > 86400 {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "INSERT INTO projects(id,owner_id,max_attempt_sec) VALUES($1,$2,$3)", id, owner, maxAttemptSec); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO budget_accounts(id,project_id,scope,limit_ms) VALUES($1,$2,'project',$3)", "project:"+id, id, limitMs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) CreateNode(ctx context.Context, id, project string, parent *string, limitMs int64) error {
	if !validID.MatchString(id) || !validID.MatchString(project) || limitMs < 1 || limitMs > 9000000000000 || (parent != nil && !validID.MatchString(*parent)) {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "INSERT INTO nodes(id,project_id,parent_id) VALUES($1,$2,$3)", id, project, parent); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO budget_accounts(id,project_id,scope,node_id,limit_ms) VALUES($1,$2,'node',$3,$4)", "node:"+id, project, id, limitMs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Publish validates the immutable contract before it reaches persistence.
// Live leases and pending/accepted submissions fence a new contract version.
func (s *Store) Publish(ctx context.Context, raw []byte) error {
	task, err := s.validator.Task(raw)
	if err != nil {
		return fmt.Errorf("contract: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Lock the project budget first, matching lease mutations' lock order.
	var account string
	if err = tx.QueryRow(ctx, "SELECT id FROM budget_accounts WHERE project_id=$1 AND scope='project' FOR UPDATE", task.ProjectId).Scan(&account); err == pgx.ErrNoRows {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	var version int64
	var hash, project, node string
	err = tx.QueryRow(ctx, "SELECT current_version,current_hash,project_id,node_id FROM tasks WHERE id=$1 FOR UPDATE", task.Id).Scan(&version, &hash, &project, &node)
	if err == nil {
		if project != task.ProjectId || node != task.NodeId {
			return ErrConflict
		}
		if version == task.TaskVersion && hash == task.ContractHash {
			return tx.Commit(ctx)
		}
		if task.TaskVersion != version+1 {
			return ErrStale
		}
		var pending bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM submissions WHERE task_id=$1
            AND status IN ('submitted','verifying','verified_candidate','in_review','accepted'))
            OR EXISTS (SELECT 1 FROM tasks WHERE id=$1 AND status IN ('accepted','archived'))`, task.Id).Scan(&pending); err != nil {
			return err
		}
		if pending {
			return ErrClosed
		}
		var active int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM leases WHERE task_id=$1 AND state IN ('reserved','active','stop_requested')", task.Id).Scan(&active); err != nil {
			return err
		}
		if active != 0 {
			return ErrCapacity
		}
		if _, err = tx.Exec(ctx, "UPDATE tasks SET current_version=$2,current_hash=$3,status='open' WHERE id=$1", task.Id, task.TaskVersion, task.ContractHash); err != nil {
			return err
		}
	} else if err == pgx.ErrNoRows {
		if task.TaskVersion != 1 {
			return ErrStale
		}
		if _, err = tx.Exec(ctx, "INSERT INTO tasks(id,project_id,node_id,current_version,current_hash) VALUES($1,$2,$3,$4,$5)", task.Id, task.ProjectId, task.NodeId, task.TaskVersion, task.ContractHash); err != nil {
			return err
		}
	} else {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO task_versions(task_id,version,contract_hash,contract) VALUES($1,$2,$3,$4::jsonb)", task.Id, task.TaskVersion, task.ContractHash, string(raw)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
