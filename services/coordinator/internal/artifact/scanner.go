package artifact

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

var ErrScannerUnavailable = errors.New("artifact_scanner_unavailable")

const TrivyVersion = "0.75.0"
const TrivyScanPolicy = "trivy-secret"
const TrivyScanPolicyVersion = "v0-75-0-neutral-v1"
const scannerOutputLimit = 1 << 20

// Server-owned policy disables built-in path/example allowlists and skipping.
// Client files cannot add rules, allowlists, exclusions or scanner settings.
const trivySecretConfig = "skip-patterns: []\ndisable-allow-rules:\n  - dist-info\n  - tests\n  - examples\n  - vendor\n  - usr-dirs\n  - locale-dir\n  - markdown\n  - node.js\n  - golang\n  - python\n  - rubygems\n  - wordpress\n  - anaconda-log\n"

// TrivyScanner is a development-local adapter. Only inert, validated source
// bytes are staged under server-generated neutral names. It is not a production
// OS sandbox; production needs a separate isolated scanner adapter.
type TrivyScanner struct{ binary, digest, scratch string }

func NewTrivyScanner(binary, digest, scratch string) (*TrivyScanner, error) {
	if !filepath.IsAbs(binary) || !filepath.IsAbs(scratch) || !vaultSHA.MatchString(digest) {
		return nil, ErrScannerUnavailable
	}
	s := &TrivyScanner{binary: binary, digest: digest, scratch: scratch}
	if err := s.checkBinary(); err != nil {
		return nil, err
	}
	if err := checkVaultAncestors(scratch); err != nil {
		return nil, ErrScannerUnavailable
	}
	if err := os.MkdirAll(scratch, 0700); err != nil {
		return nil, ErrScannerUnavailable
	}
	if err := checkVaultAncestors(scratch); err != nil {
		return nil, ErrScannerUnavailable
	}
	info, err := os.Lstat(scratch)
	if err != nil || !info.IsDir() || unsafeVaultInfo(info) {
		return nil, ErrScannerUnavailable
	}
	return s, nil
}

func (s *TrivyScanner) checkBinary() error {
	if err := checkVaultAncestors(filepath.Dir(s.binary)); err != nil {
		return ErrScannerUnavailable
	}
	before, err := os.Lstat(s.binary)
	if err != nil || !before.Mode().IsRegular() || unsafeVaultInfo(before) || before.Size() > 256<<20 {
		return ErrScannerUnavailable
	}
	f, err := os.Open(s.binary)
	if err != nil {
		return ErrScannerUnavailable
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !os.SameFile(before, info) || checkVaultFile(f) != nil {
		return ErrScannerUnavailable
	}
	h := sha256.New()
	if _, err = io.Copy(h, io.LimitReader(f, (256<<20)+1)); err != nil || hex.EncodeToString(h.Sum(nil)) != s.digest {
		return ErrScannerUnavailable
	}
	return nil
}

// limitedOutput discards excess output and never exposes source-bearing stdout
// or stderr to API errors, logs or durable workflow state.
type limitedOutput struct {
	buffer   bytes.Buffer
	overflow bool
}

func (b *limitedOutput) Len() int      { return b.buffer.Len() }
func (b *limitedOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *limitedOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := scannerOutputLimit - b.Len()
	if n > remaining {
		b.overflow = true
		p = p[:remaining]
	}
	_, _ = b.buffer.Write(p)
	return n, nil
}

func scannerEnvironment(dir string) []string {
	env := []string{"HOME=" + dir, "USERPROFILE=" + dir, "XDG_CONFIG_HOME=" + dir, "XDG_CACHE_HOME=" + dir, "APPDATA=" + dir, "LOCALAPPDATA=" + dir, "TMP=" + dir, "TEMP=" + dir, "TMPDIR=" + dir}
	// Windows process creation needs SystemRoot. No inherited provider tokens,
	// proxy configuration, TRIVY_* overrides, PATH or credential homes are copied.
	if value := os.Getenv("SystemRoot"); value != "" {
		env = append(env, "SystemRoot="+value)
	}
	return env
}

func (s *TrivyScanner) Scan(ctx context.Context, bundle *Bundle) error {
	if s == nil || bundle == nil || len(bundle.Files) == 0 || len(bundle.Files) > MaxFiles || ctx.Err() != nil {
		return ErrScannerUnavailable
	}
	if err := s.checkBinary(); err != nil {
		return err
	}
	if checkVaultAncestors(s.scratch) != nil {
		return ErrScannerUnavailable
	}
	dir, err := os.MkdirTemp(s.scratch, "scan-")
	if err != nil {
		return ErrScannerUnavailable
	}
	defer os.RemoveAll(dir) // generated child of the configured server-owned scratch directory
	root, err := os.OpenRoot(dir)
	if err != nil {
		return ErrScannerUnavailable
	}
	defer root.Close()
	for _, path := range []string{"source", "home", "cache", "modules"} {
		if err = root.Mkdir(path, 0700); err != nil {
			return ErrScannerUnavailable
		}
	}
	policy, err := root.OpenFile("secret-policy.yaml", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return ErrScannerUnavailable
	}
	_, policyErr := policy.WriteString(trivySecretConfig)
	closePolicyErr := policy.Close()
	if policyErr != nil || closePolicyErr != nil {
		return ErrScannerUnavailable
	}
	var total int64
	for i, file := range bundle.Files {
		total += int64(len(file.Bytes))
		if int64(len(file.Bytes)) != file.SizeBytes || len(file.Bytes) > MaxFileBytes || total > MaxArchiveBytes {
			return ErrUnsafe
		}
		sum := sha256.Sum256(file.Bytes)
		if hex.EncodeToString(sum[:]) != file.SHA256 || checkText(file.Bytes) != nil {
			return ErrUnsafe
		}
		// Never allow source annotations to suppress the required scanner.
		lower := bytes.ToLower(file.Bytes)
		if bytes.Contains(lower, []byte("trivy:ignore")) || bytes.Contains(lower, []byte("trivy:allow")) {
			return ErrUnsafe
		}
		// Neutral names avoid scanner exclusions based on client-chosen file names.
		f, err := root.OpenFile(fmt.Sprintf("source/source-%04d.txt", i), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return ErrScannerUnavailable
		}
		_, writeErr := f.Write(file.Bytes)
		closeErr := f.Close()
		if writeErr != nil || closeErr != nil {
			return ErrScannerUnavailable
		}
	}
	bounded, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args := []string{"fs", "--scanners", "secret", "--format", "json", "--exit-code", "0", "--quiet", "--config", "", "--secret-config", filepath.Join(dir, "secret-policy.yaml"), "--ignorefile", "", "--offline-scan", "--skip-db-update", "--skip-java-db-update", "--skip-check-update", "--skip-version-check", "--disable-telemetry", "--timeout", "20s", "--parallel", "1", "--cache-dir", filepath.Join(dir, "cache"), "--module-dir", filepath.Join(dir, "modules"), filepath.Join(dir, "source")}
	command := exec.CommandContext(bounded, s.binary, args...)
	command.Dir = dir
	command.Env = scannerEnvironment(filepath.Join(dir, "home"))
	command.WaitDelay = time.Second
	var stdout, stderr limitedOutput
	command.Stdout = &stdout
	command.Stderr = &stderr
	if command.Run() != nil || bounded.Err() != nil || stdout.overflow || stderr.overflow {
		return ErrScannerUnavailable
	}
	return parseTrivyReport(stdout.Bytes())
}

func parseTrivyReport(raw []byte) error {
	var report struct {
		SchemaVersion int
		ArtifactType  string
		Trivy         struct{ Version string }
		Results       []struct{ Secrets []json.RawMessage }
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if decoder.Decode(&report) != nil || report.SchemaVersion != 2 || report.ArtifactType != "filesystem" || report.Trivy.Version != TrivyVersion {
		return ErrScannerUnavailable
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrScannerUnavailable
	}
	for _, result := range report.Results {
		if len(result.Secrets) > 0 {
			return ErrUnsafe
		}
	}
	return nil
}
