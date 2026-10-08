package main

import (
	"commongrid/coordinator/internal/artifact"
	"commongrid/coordinator/internal/auth"
	"commongrid/coordinator/internal/catalog"
	"commongrid/coordinator/internal/httpapi"
	"commongrid/coordinator/internal/store"
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	startup, cancelStartup := context.WithTimeout(context.Background(), 20*time.Second)
	handler, closeDatabase, mode, err := coordinatorHandler(startup)
	cancelStartup()
	if err != nil {
		log.Fatal(err)
	}
	defer closeDatabase()
	server := &http.Server{Addr: "127.0.0.1:8787", Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("CommonGrid coordinator: http://%s — %s mode; execution disabled", server.Addr, mode)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func coordinatorHandler(ctx context.Context) (http.Handler, func(), string, error) {
	mode := os.Getenv("CG_COORDINATOR_MODE")
	if mode == "" || mode == "fixture" {
		tasks, err := catalog.Load()
		if err != nil {
			return nil, func() {}, "", errors.New("fixture catalog failed validation")
		}
		return httpapi.New(tasks), func() {}, "fixture", nil
	}
	if mode != "authenticated" {
		return nil, func() {}, "", errors.New("unsupported coordinator mode")
	}
	if os.Getenv("DATABASE_URL") == "" {
		return nil, func() {}, "", errors.New("authenticated mode requires DATABASE_URL")
	}
	schema := os.Getenv("CG_DATABASE_SCHEMA")
	if schema == "" {
		schema = "commongrid"
	}
	database, err := store.Open(ctx, os.Getenv("DATABASE_URL"), schema)
	if err != nil {
		return nil, func() {}, "", errors.New("database connection failed; check access and configuration")
	}
	fail := func(message string) (http.Handler, func(), string, error) {
		database.Close()
		return nil, func() {}, "", errors.New(message)
	}
	if err = database.CheckMigrations(ctx); err != nil {
		return fail("database migrations missing or changed; run the explicit migration command")
	}
	publicURL, uiOrigin := os.Getenv("CG_PUBLIC_URL"), os.Getenv("CG_UI_ORIGIN")
	if publicURL == "" {
		publicURL = "http://127.0.0.1:8787"
	}
	if uiOrigin == "" {
		uiOrigin = "http://127.0.0.1:1420"
	}
	development := os.Getenv("CG_ALLOW_LOOPBACK_AUTH") == "true"
	providers := make(map[string]auth.Provider)
	for _, provider := range []string{"github", "google"} {
		idKey, secretKey := "CG_GITHUB_CLIENT_ID", "CG_GITHUB_CLIENT_SECRET"
		if provider == "google" {
			idKey, secretKey = "CG_GOOGLE_CLIENT_ID", "CG_GOOGLE_CLIENT_SECRET"
		}
		id, secret := os.Getenv(idKey), os.Getenv(secretKey)
		if id == "" && secret == "" {
			continue
		}
		if id == "" || secret == "" {
			return fail("OAuth provider configuration incomplete")
		}
		var implementation auth.Provider
		if provider == "github" {
			implementation, err = auth.NewGitHubProvider(id, secret, nil)
		} else {
			implementation, err = auth.NewGoogleProvider(id, secret, nil)
		}
		if err != nil {
			return fail("OAuth provider configuration invalid")
		}
		providers[provider] = implementation
	}
	manager, err := auth.NewManager(database, auth.Config{PublicURL: publicURL, UIOrigin: uiOrigin, Development: development, Providers: providers})
	if err != nil {
		return fail("account origin or provider configuration invalid")
	}
	artifacts, closeArtifacts, err := configuredArtifacts(development)
	if err != nil {
		return fail("artifact storage or scanner configuration invalid")
	}
	handler, err := httpapi.NewAuthenticated(database, manager, httpapi.Config{PublicURL: publicURL, UIOrigin: uiOrigin, Development: development, Artifacts: artifacts})
	if err != nil {
		closeArtifacts()
		return fail("authenticated API configuration invalid")
	}
	return handler, func() { closeArtifacts(); database.Close() }, mode, nil
}

func configuredArtifacts(development bool) (*httpapi.ArtifactService, func(), error) {
	root, binary, digest := os.Getenv("CG_ARTIFACT_ROOT"), os.Getenv("CG_TRIVY_BINARY"), os.Getenv("CG_TRIVY_SHA256")
	noop := func() {}
	if root == "" && binary == "" && digest == "" {
		return nil, noop, nil
	}
	if !development || !filepath.IsAbs(root) || !filepath.IsAbs(binary) || digest == "" {
		return nil, noop, artifact.ErrScannerUnavailable
	}
	vault, err := artifact.NewVault(root)
	if err != nil {
		return nil, noop, artifact.ErrScannerUnavailable
	}
	scanner, err := artifact.NewTrivyScanner(binary, digest, filepath.Join(root, ".scanner"))
	if err != nil {
		vault.Close()
		return nil, noop, artifact.ErrScannerUnavailable
	}
	service := &httpapi.ArtifactService{Vault: vault, Scanner: scanner, ScanPolicy: artifact.TrivyScanPolicy, ScanPolicyVersion: artifact.TrivyScanPolicyVersion, DevelopmentOnly: true}
	return service, func() { _ = vault.Close() }, nil
}
