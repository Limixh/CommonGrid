package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDefaultModeDoesNotConnectDatabaseOrEnableAccounts(t *testing.T) {
	t.Setenv("CG_COORDINATOR_MODE", "")
	t.Setenv("DATABASE_URL", "invalid-private-database-setting")
	t.Setenv("CG_GITHUB_CLIENT_ID", "incomplete-fixture")
	handler, closeDatabase, mode, err := coordinatorHandler(context.Background())
	if err != nil || mode != "fixture" {
		t.Fatal("default fixture configuration failed", err)
	}
	defer closeDatabase()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1:8787/api/v1/auth/providers", nil))
	if response.Code != 200 || strings.Contains(response.Body.String(), `"enabled":true`) {
		t.Fatal("fixture configuration enabled login")
	}
}

func TestAuthenticatedStartupFailsClosedWithoutDatabase(t *testing.T) {
	t.Setenv("CG_COORDINATOR_MODE", "authenticated")
	t.Setenv("DATABASE_URL", "")
	handler, cleanup, _, err := coordinatorHandler(context.Background())
	cleanup()
	if err == nil || handler != nil {
		t.Fatal("authenticated startup silently fell back")
	}
}

func TestStartupDoesNotExposeDatabaseConfiguration(t *testing.T) {
	t.Setenv("CG_COORDINATOR_MODE", "authenticated")
	t.Setenv("DATABASE_URL", "private-secret-fixture://invalid%")
	handler, cleanup, _, err := coordinatorHandler(context.Background())
	cleanup()
	if err == nil || handler != nil || strings.Contains(err.Error(), "private-secret-fixture") {
		t.Fatal("startup exposes configuration or enables handler")
	}
	t.Setenv("CG_COORDINATOR_MODE", "unknown")
	if handler, _, _, err = coordinatorHandler(context.Background()); err == nil || handler != nil {
		t.Fatal("unknown mode accepted")
	}
}

func TestArtifactsRequireExplicitDevelopmentConfiguration(t *testing.T) {
	for _, key := range []string{"CG_ARTIFACT_ROOT", "CG_TRIVY_BINARY", "CG_TRIVY_SHA256"} {
		t.Setenv(key, "")
	}
	service, cleanup, err := configuredArtifacts(false)
	cleanup()
	if err != nil || service != nil {
		t.Fatal("absent artifact configuration enabled service")
	}
	t.Setenv("CG_ARTIFACT_ROOT", t.TempDir())
	for _, development := range []bool{false, true} {
		service, cleanup, err = configuredArtifacts(development)
		cleanup()
		if err == nil || service != nil {
			t.Fatal("incomplete or production local storage enabled")
		}
	}
}

func TestExecutionRequiresExplicitExactContractOptIn(t *testing.T) {
	for _, raw := range []string{"true", "*", "software-bounds,", "software-bounds,software-bounds", " software-bounds", "software-bounds,unknown"} {
		t.Setenv("CG_EXECUTION_CONTRACTS", raw)
		if _, err := configuredExecutionContracts(true); err == nil {
			t.Fatal("unsafe opt-in accepted", raw)
		}
	}
	t.Setenv("CG_EXECUTION_CONTRACTS", "software-bounds,software-intervals")
	if _, err := configuredExecutionContracts(false); err == nil {
		t.Fatal("production execution enabled")
	}
	contracts, err := configuredExecutionContracts(true)
	if err != nil || len(contracts) != 2 {
		t.Fatal(contracts, err)
	}
	t.Setenv("CG_EXECUTION_CONTRACTS", "")
	contracts, err = configuredExecutionContracts(false)
	if err != nil || len(contracts) != 0 {
		t.Fatal("default execution enabled")
	}
}
