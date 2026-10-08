package artifact

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var ErrVaultInvalid = errors.New("artifact_vault_invalid")
var ErrVaultUnsafe = errors.New("artifact_vault_unsafe_file")
var ErrVaultIntegrity = errors.New("artifact_vault_integrity")
var ErrVaultConflict = errors.New("artifact_vault_conflict")
var vaultID = regexp.MustCompile(`^artifact-[a-f0-9]{32}$`)
var vaultSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)
var vaultTemp = regexp.MustCompile(`^\.upload-[a-f0-9]{32}$`)

const maxVaultBytes int64 = 64 * 1024 * 1024

// Vault is a development-local private immutable byte store. Its configured
// directory must be controlled by the server, outside producer workspaces.
// os.Root fences all object operations; callers can supply only opaque IDs.
type Vault struct {
	root *os.Root
	mu   sync.RWMutex
}

func NewVault(path string) (*Vault, error) {
	if path == "" {
		return nil, ErrVaultInvalid
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	// This adapter is explicitly local. Refuse UNC/device namespace roots
	// before touching them; deployment storage needs a separate adapter.
	if runtime.GOOS == "windows" && strings.HasPrefix(filepath.VolumeName(absolute), `\\`) {
		return nil, ErrVaultInvalid
	}
	if err = checkVaultAncestors(absolute); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(absolute, 0700); err != nil {
		return nil, err
	}
	if err = checkVaultAncestors(absolute); err != nil {
		return nil, err
	}
	before, err := os.Lstat(absolute)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || unsafeVaultInfo(before) {
		return nil, ErrVaultUnsafe
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, err
	}
	after, err := root.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		root.Close()
		return nil, ErrVaultUnsafe
	}
	if err = root.Chmod(".", 0700); err != nil {
		root.Close()
		return nil, err
	}
	v := &Vault{root: root}
	if err = v.cleanupTemps(); err != nil {
		root.Close()
		return nil, err
	}
	return v, nil
}

func checkVaultAncestors(path string) error {
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && (!info.IsDir() || unsafeVaultInfo(info)) {
			return ErrVaultUnsafe
		}
		if filepath.Dir(current) == current {
			return nil
		}
	}
}

// Startup work is bounded. Only old server-named temporary regular files are
// removed; recent uploads and arbitrary files are left untouched.
func (v *Vault) cleanupTemps() error {
	directory, err := v.root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	entries, err := directory.ReadDir(128)
	if err != nil && err != io.EOF {
		return err
	}
	for _, entry := range entries {
		if !vaultTemp.MatchString(entry.Name()) {
			continue
		}
		info, err := v.root.Lstat(entry.Name())
		if err != nil {
			continue
		}
		if !info.Mode().IsRegular() || unsafeVaultInfo(info) || time.Since(info.ModTime()) < time.Hour {
			continue
		}
		if err = v.root.Remove(entry.Name()); err != nil {
			return err
		}
	}
	return nil
}

func (v *Vault) Close() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.root.Close()
}

// Put never truncates or replaces an object. Exact retries verify the existing
// file. Publication uses an atomic exclusive hard-link then drops the temporary
// name; the fully synced bytes exist before the final opaque name appears.
func (v *Vault) Put(ctx context.Context, id string, raw []byte, expectedSHA string) error {
	if !vaultID.MatchString(id) || !vaultSHA.MatchString(expectedSHA) || len(raw) < 1 || int64(len(raw)) > maxVaultBytes {
		return ErrVaultInvalid
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != expectedSHA {
		return ErrVaultIntegrity
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := v.root.Lstat(id); err == nil {
		existing, err := v.read(id, expectedSHA, int64(len(raw)))
		if err != nil {
			return err
		}
		if !bytes.Equal(raw, existing) {
			return ErrVaultConflict
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return err
	}
	temp := ".upload-" + hex.EncodeToString(entropy[:])
	file, err := v.root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer v.root.Remove(temp)
	if _, err = file.Write(raw); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = v.root.Link(temp, id); err != nil {
		if errors.Is(err, os.ErrExist) {
			existing, readErr := v.read(id, expectedSHA, int64(len(raw)))
			if readErr != nil {
				return readErr
			}
			if !bytes.Equal(existing, raw) {
				return ErrVaultConflict
			}
			return nil
		}
		return err
	}
	if err = v.root.Remove(temp); err != nil {
		return err
	}
	if err = v.syncDirectory(); err != nil {
		return err
	}
	_, err = v.read(id, expectedSHA, int64(len(raw)))
	return err
}

func (v *Vault) syncDirectory() error {
	// Windows FlushFileBuffers does not support directory handles. The object
	// itself has already been flushed before the atomic name publication.
	if runtime.GOOS == "windows" {
		return nil
	}
	directory, err := v.root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (v *Vault) Read(ctx context.Context, id, expectedSHA string, size int64) ([]byte, error) {
	if !vaultID.MatchString(id) || !vaultSHA.MatchString(expectedSHA) || size < 1 || size > maxVaultBytes {
		return nil, ErrVaultInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	raw, err := v.read(id, expectedSHA, size)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return raw, nil
}

func (v *Vault) read(id, expectedSHA string, size int64) ([]byte, error) {
	before, err := v.root.Lstat(id)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || unsafeVaultInfo(before) {
		return nil, ErrVaultUnsafe
	}
	file, err := v.root.Open(id)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) || unsafeVaultInfo(after) {
		return nil, ErrVaultUnsafe
	}
	if err = checkVaultFile(file); err != nil {
		return nil, err
	}
	if after.Size() != size {
		return nil, ErrVaultIntegrity
	}
	raw, err := io.ReadAll(io.LimitReader(file, size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) != size {
		return nil, ErrVaultIntegrity
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != expectedSHA {
		return nil, ErrVaultIntegrity
	}
	final, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if final.Size() != size || !final.ModTime().Equal(after.ModTime()) {
		return nil, fmt.Errorf("%w: changed during read", ErrVaultIntegrity)
	}
	return raw, nil
}
