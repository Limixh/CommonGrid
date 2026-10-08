package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func vaultDigest(raw []byte) string { hash := sha256.Sum256(raw); return hex.EncodeToString(hash[:]) }
func vaultFixture(t *testing.T) (*Vault, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "vault")
	v, err := NewVault(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := v.Close(); err != nil {
			t.Error(err)
		}
	})
	return v, root
}
func TestVaultImmutableIntegrityAndPrivacy(t *testing.T) {
	v, root := vaultFixture(t)
	ctx := context.Background()
	id := "artifact-" + strings.Repeat("a", 32)
	raw := []byte("immutable private bytes")
	digest := vaultDigest(raw)
	if err := v.Put(ctx, id, raw, digest); err != nil {
		t.Fatal(err)
	}
	if err := v.Put(ctx, id, raw, digest); err != nil {
		t.Fatal("exact retry", err)
	}
	if err := v.Put(ctx, id, []byte("changed"), vaultDigest([]byte("changed"))); err == nil {
		t.Fatal("overwritten")
	}
	actual, err := v.Read(ctx, id, digest, int64(len(raw)))
	if err != nil || string(actual) != string(raw) {
		t.Fatal("read", err)
	}
	if _, err = v.Read(ctx, id, strings.Repeat("b", 64), int64(len(raw))); !errors.Is(err, ErrVaultIntegrity) {
		t.Fatal("digest", err)
	}
	if _, err = v.Read(ctx, id, digest, int64(len(raw)+1)); !errors.Is(err, ErrVaultIntegrity) {
		t.Fatal("size", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary file leak", entries, err)
	}
	if runtime.GOOS != "windows" {
		fileInfo, _ := os.Stat(filepath.Join(root, id))
		dirInfo, _ := os.Stat(root)
		if fileInfo.Mode().Perm() != 0600 || dirInfo.Mode().Perm() != 0700 {
			t.Fatal("public permissions")
		}
	}
	// Out-of-band corruption is caught on every read, never cached as trusted.
	if err = os.WriteFile(filepath.Join(root, id), []byte("corrupted private bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = v.Read(ctx, id, digest, int64(len(raw))); !errors.Is(err, ErrVaultIntegrity) {
		t.Fatal("corruption accepted", err)
	}
}
func TestVaultRejectsCallerPathsAndCanceledWrites(t *testing.T) {
	if runtime.GOOS == "windows" {
		if v, err := NewVault(`\\server\share\vault`); !errors.Is(err, ErrVaultInvalid) {
			if v != nil {
				v.Close()
			}
			t.Fatal("network vault root accepted", err)
		}
	}
	v, _ := vaultFixture(t)
	raw := []byte("bytes")
	for _, id := range []string{"../outside", "artifact/relative", `C:\outside`, "artifact-" + strings.Repeat("a", 64), "CON", "artifact-" + strings.Repeat("A", 32)} {
		if err := v.Put(context.Background(), id, raw, vaultDigest(raw)); !errors.Is(err, ErrVaultInvalid) {
			t.Fatalf("path %q accepted: %v", id, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	id := "artifact-" + strings.Repeat("c", 32)
	if err := v.Put(ctx, id, raw, vaultDigest(raw)); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := v.Read(context.Background(), id, vaultDigest(raw), int64(len(raw))); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("canceled bytes published", err)
	}
}
func TestVaultRejectsHardLinksAndSpecialFiles(t *testing.T) {
	v, root := vaultFixture(t)
	id := "artifact-" + strings.Repeat("d", 32)
	raw := []byte("outside bytes")
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, id)); err != nil {
		t.Skip("filesystem hardlinks unavailable", err)
	}
	if _, err := v.Read(context.Background(), id, vaultDigest(raw), int64(len(raw))); !errors.Is(err, ErrVaultUnsafe) {
		t.Fatal("hardlink read", err)
	}
	if err := v.Put(context.Background(), id, raw, vaultDigest(raw)); !errors.Is(err, ErrVaultUnsafe) {
		t.Fatal("hardlink write", err)
	}
	dirID := "artifact-" + strings.Repeat("e", 32)
	if err := os.Mkdir(filepath.Join(root, dirID), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Read(context.Background(), dirID, vaultDigest(raw), int64(len(raw))); !errors.Is(err, ErrVaultUnsafe) {
		t.Fatal("directory read", err)
	}
}
func TestVaultRejectsSymlinkRootAndObjects(t *testing.T) {
	outside := t.TempDir()
	link := filepath.Join(t.TempDir(), "linked-vault")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("symlinks unavailable", err)
	}
	if v, err := NewVault(link); !errors.Is(err, ErrVaultUnsafe) {
		if v != nil {
			v.Close()
		}
		t.Fatal("linked root", err)
	}
	v, root := vaultFixture(t)
	raw := []byte("untrusted outside")
	target := filepath.Join(outside, "bytes")
	if err := os.WriteFile(target, raw, 0600); err != nil {
		t.Fatal(err)
	}
	id := "artifact-" + strings.Repeat("f", 32)
	if err := os.Symlink(target, filepath.Join(root, id)); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Read(context.Background(), id, vaultDigest(raw), int64(len(raw))); !errors.Is(err, ErrVaultUnsafe) {
		t.Fatal("linked object", err)
	}
}
func TestVaultConcurrentExactPublicationAndBoundedTempCleanup(t *testing.T) {
	root := filepath.Join(t.TempDir(), "vault")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(root, ".upload-"+strings.Repeat("1", 32))
	recent := filepath.Join(root, ".upload-"+strings.Repeat("2", 32))
	for _, file := range []string{old, recent} {
		if err := os.WriteFile(file, []byte("temp"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	timestamp := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(old, timestamp, timestamp); err != nil {
		t.Fatal(err)
	}
	v, err := NewVault(root)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	if _, err = os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old temp retained", err)
	}
	if _, err = os.Stat(recent); err != nil {
		t.Fatal("recent temp removed", err)
	}
	raw := []byte("concurrent publication")
	id := "artifact-" + strings.Repeat("3", 32)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := v.Put(context.Background(), id, raw, vaultDigest(raw)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	actual, err := v.Read(context.Background(), id, vaultDigest(raw), int64(len(raw)))
	if err != nil || string(actual) != string(raw) {
		t.Fatal(err)
	}
}
