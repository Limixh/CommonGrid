package store

import (
	"context"
	"crypto/sha256"
	"fmt"
)

// CheckMigrations is read-only. Production API startup does not create a schema
// or silently accept edited/missing migrations.
func (s *Store) CheckMigrations(ctx context.Context) error {
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	var count int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != len(entries) {
		return ErrInvariant
	}
	for _, entry := range entries {
		raw, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		var hash string
		if err = s.pool.QueryRow(ctx, "SELECT sha256 FROM schema_migrations WHERE name=$1", entry.Name()).Scan(&hash); err != nil {
			return ErrInvariant
		}
		if hash != fmt.Sprintf("%x", sha256.Sum256(raw)) {
			return ErrInvariant
		}
	}
	return nil
}
