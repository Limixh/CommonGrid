//go:build windows

package artifact

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Directory junctions do not need the file-symlink privilege. This exercises
// actual Windows reparse rejection even when file symlinks are unavailable.
func TestVaultRejectsWindowsJunctionRoot(t *testing.T) {
	outside := t.TempDir()
	link := filepath.Join(t.TempDir(), "junction")
	for _, path := range []string{link, outside} {
		if !filepath.IsAbs(path) || strings.ContainsAny(path, "\"%&|^<>!\r\n") {
			t.Fatal("test paths unsuitable for junction creation")
		}
	}
	if err := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"), "/d", "/c", "mklink", "/J", link, outside).Run(); err != nil {
		t.Fatal("owned test junction creation failed", err)
	}
	t.Cleanup(func() {
		if err := os.Remove(link); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Error("owned junction cleanup", err)
		}
	})
	v, err := NewVault(link)
	if !errors.Is(err, ErrVaultUnsafe) {
		if v != nil {
			v.Close()
		}
		t.Fatal("junction root accepted", err)
	}
}
