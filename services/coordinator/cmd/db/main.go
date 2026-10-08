package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"commongrid/coordinator/internal/store"
)

func main() {
	schema := flag.String("schema", "commongrid", "managed PostgreSQL schema")
	flag.Parse()
	if len(flag.Args()) != 1 || flag.Args()[0] != "migrate" {
		fmt.Fprintln(os.Stderr, "Usage: db [--schema commongrid] migrate (DATABASE_URL required)")
		os.Exit(1)
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL required")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	database, err := store.Open(ctx, dsn, *schema)
	if err != nil {
		fmt.Fprintln(os.Stderr, "PostgreSQL connection failed; check database access and configuration.")
		os.Exit(1)
	}
	defer database.Close()
	if err = database.Migrate(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "Migration failed; check schema permissions and migration history.")
		os.Exit(1)
	}
	fmt.Println("CommonGrid migrations applied. Agent execution remains disabled.")
}
