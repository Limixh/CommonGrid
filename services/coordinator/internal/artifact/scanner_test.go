package artifact

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func scanBundle(source string) *Bundle {
	raw := []byte(source)
	sum := sha256.Sum256(raw)
	return &Bundle{Files: []File{{Path: "ignored/example.md", Bytes: raw, SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(raw))}}}
}

func TestScannerRequiresPinnedRegularBinary(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "scanner-fixture")
	if err := os.WriteFile(binary, []byte("inert fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("inert fixture"))
	digest := hex.EncodeToString(sum[:])
	s, err := NewTrivyScanner(binary, digest, filepath.Join(dir, "private"))
	if err != nil {
		t.Fatal("valid pinned file rejected", err)
	}
	if err = os.WriteFile(binary, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = s.Scan(context.Background(), scanBundle("const x=1;")); !errors.Is(err, ErrScannerUnavailable) {
		t.Fatal("tampered binary accepted", err)
	}
	for _, path := range []string{"relative", dir, filepath.Join(dir, "absent")} {
		if _, err = NewTrivyScanner(path, digest, filepath.Join(dir, "scratch")); !errors.Is(err, ErrScannerUnavailable) {
			t.Fatal("invalid binary accepted")
		}
	}
}

func TestScannerReportRejectsErrorsFindingsAndOutputOverflow(t *testing.T) {
	clean := `{"SchemaVersion":2,"ArtifactType":"filesystem","Trivy":{"Version":"0.75.0"}}`
	if err := parseTrivyReport([]byte(clean)); err != nil {
		t.Fatal("clean report", err)
	}
	for _, raw := range []string{`{}`, `not JSON`, clean + ` {}`, strings.Replace(clean, "0.75.0", "0.74.0", 1), strings.Replace(clean, "filesystem", "image", 1)} {
		if !errors.Is(parseTrivyReport([]byte(raw)), ErrScannerUnavailable) {
			t.Fatal("invalid scanner output accepted")
		}
	}
	found := `{"SchemaVersion":2,"ArtifactType":"filesystem","Trivy":{"Version":"0.75.0"},"Results":[{"Secrets":[{"Match":"PRIVATE_CANARY"}]}]}`
	if err := parseTrivyReport([]byte(found)); !errors.Is(err, ErrUnsafe) || strings.Contains(err.Error(), "PRIVATE_CANARY") {
		t.Fatal("finding leaked or accepted")
	}
	var output limitedOutput
	_, _ = io.Copy(&output, struct{ io.Reader }{bytes.NewReader(bytes.Repeat([]byte("x"), scannerOutputLimit+100))})
	if !output.overflow || output.Len() != scannerOutputLimit {
		t.Fatal("scanner output unbounded")
	}
}

func TestScannerEnvironmentDoesNotInheritCredentialsOrOverrides(t *testing.T) {
	for _, key := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_HOME", "TRIVY_SCANNERS", "TRIVY_SKIP_FILES", "HTTP_PROXY", "PATH"} {
		t.Setenv(key, "PRIVATE_CANARY")
	}
	env := scannerEnvironment("controlled-home")
	for _, entry := range env {
		if strings.Contains(entry, "PRIVATE_CANARY") {
			t.Fatal("host credentials/override inherited")
		}
	}
}

func TestTrivyRealAcceptance(t *testing.T) {
	binary, digest := os.Getenv("CG_TEST_TRIVY_BINARY"), os.Getenv("CG_TEST_TRIVY_SHA256")
	if binary == "" || digest == "" {
		if os.Getenv("CG_REQUIRE_TRIVY_TESTS") == "1" {
			t.Fatal("pinned Trivy required")
		}
		t.Skip("real scanner acceptance: npm run test:artifacts")
	}
	s, err := NewTrivyScanner(binary, digest, t.TempDir())
	if err != nil {
		t.Fatal("pinned scanner unavailable", err)
	}
	if err = s.Scan(context.Background(), scanBundle("export const value = 1;\n")); err != nil {
		t.Fatal("clean source rejected", err)
	}
	// This synthetic Stripe-shaped value passes the small baseline classifier.
	// The independent scanner must reject it, even under an example/markdown path.
	canary := scanBundle("const value = \"sk_live_J6yP0qA8cZ5vL2rE7sT9uW4x\";\n")
	if err = checkText(canary.Files[0].Bytes); err != nil {
		t.Fatal("canary did not reach independent scanner")
	}
	if err = s.Scan(context.Background(), canary); !errors.Is(err, ErrUnsafe) {
		t.Fatal("independent scanner missed synthetic canary", err)
	}
	annotated := scanBundle("// trivy:ignore\nconst value = 1;\n")
	if err = s.Scan(context.Background(), annotated); !errors.Is(err, ErrUnsafe) {
		t.Fatal("scanner suppression accepted")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err = s.Scan(cancelled, scanBundle("const value=1;")); !errors.Is(err, ErrScannerUnavailable) {
		t.Fatal("cancelled scanner succeeded")
	}
	entries, err := os.ReadDir(s.scratch)
	if err != nil || len(entries) != 0 {
		t.Fatal("source scratch not cleaned", err)
	}
}
