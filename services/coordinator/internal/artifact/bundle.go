// Package artifact parses inert, bounded cg-artifact/1 source bundles. It never
// extracts files or executes their contents. Baseline credential checks here are
// not a production secret scanner: delivery must additionally require Scanner.
package artifact

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"commongrid/coordinator/internal/contract"
)

const (
	MaxArchiveBytes  = 64 << 20
	MaxFileBytes     = 4 << 20
	MaxFiles         = 256
	MaxManifestBytes = 64 << 10
	maxPathBytes     = 512
)

// Errors are intentionally fixed and never include rejected source or metadata.
var (
	ErrInvalid = errors.New("artifact_invalid")
	ErrUnsafe  = errors.New("artifact_unsafe")
)

type Binding struct {
	Purpose      string `json:"purpose"`
	TaskID       string `json:"task_id"`
	TaskVersion  int64  `json:"task_version"`
	ContractHash string `json:"contract_hash"`
	LeaseID      string `json:"lease_id"`
	BaseCommit   string `json:"base_commit"`
	StrategyID   string `json:"strategy_id"`
}

type File struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
	Bytes     []byte `json:"-"`
}

type Bundle struct {
	Binding
	Files []File `json:"files"`
}

type manifest struct {
	Format string `json:"format"`
	Binding
	Files []File `json:"files"`
}

type zipEntry struct {
	name string
	data []byte
}

// Validate performs strict structural, authorization and baseline content checks.
// It makes no claim that unknown or encoded credentials can be detected.
func Validate(raw []byte, task contract.TaskContract, expected Binding) (Bundle, error) {
	entries, err := parseZIP(raw)
	if err != nil {
		return Bundle{}, err
	}
	m, err := parseManifest(entries[0].data)
	if err != nil || !validBinding(m.Binding) || m.Binding != expected || m.Format != "cg-artifact/1" {
		return Bundle{}, ErrInvalid
	}
	if expected.TaskID != task.Id || expected.TaskVersion != task.TaskVersion || expected.ContractHash != task.ContractHash || expected.BaseCommit != task.Workspace.Commit {
		return Bundle{}, ErrInvalid
	}
	if expected.Purpose == "checkpoint" && (!task.Handoff.Enabled || !task.Handoff.AllowWorkspaceSnapshot) {
		return Bundle{}, ErrUnsafe
	}
	strategyFound := false
	for _, s := range task.Strategies {
		if s.Id == expected.StrategyID {
			strategyFound = true
		}
	}
	if !strategyFound || len(m.Files) == 0 || len(m.Files) != len(entries)-1 || len(m.Files) > MaxFiles {
		return Bundle{}, ErrInvalid
	}
	allowed := make(map[string]bool, len(task.Workspace.WritablePaths))
	for _, path := range task.Workspace.WritablePaths {
		if !safePath(path) {
			return Bundle{}, ErrUnsafe
		}
		allowed[path] = true // The schema specifies exact paths, never globs or directories.
	}
	if len(task.Verification.ForbiddenPatterns) > 256 {
		return Bundle{}, ErrInvalid
	}
	for _, pattern := range task.Verification.ForbiddenPatterns {
		if len(pattern) == 0 || len(pattern) > 4096 || !utf8.ValidString(pattern) {
			return Bundle{}, ErrInvalid
		}
	}
	seen := make(map[string]bool, len(m.Files))
	previous := ""
	for i := range m.Files {
		file := &m.Files[i]
		if !safePath(file.Path) || !allowed[file.Path] {
			return Bundle{}, ErrUnsafe
		}
		if !claimPath(seen, file.Path) || (i > 0 && file.Path <= previous) {
			return Bundle{}, ErrInvalid
		}
		previous = file.Path
		entry := entries[i+1]
		if entry.name != "files/"+file.Path || file.SizeBytes < 0 || file.SizeBytes > MaxFileBytes || int64(len(entry.data)) != file.SizeBytes || !lowerHash(file.SHA256) {
			return Bundle{}, ErrInvalid
		}
		digest := sha256.Sum256(entry.data)
		if file.SHA256 != hex.EncodeToString(digest[:]) {
			return Bundle{}, ErrInvalid
		}
		if err := checkText(entry.data); err != nil {
			return Bundle{}, err
		}
		for _, pattern := range task.Verification.ForbiddenPatterns {
			if bytes.Contains(entry.data, []byte(pattern)) {
				return Bundle{}, ErrUnsafe
			}
		}
		file.Bytes = bytes.Clone(entry.data)
	}
	return Bundle{Binding: m.Binding, Files: m.Files}, nil
}

// Encode emits deterministic STORE entries with known sizes and CRCs, no data
// descriptors, extra fields, comments, prefixes, suffixes or ZIP64 extensions.
func Encode(binding Binding, files map[string][]byte) ([]byte, error) {
	if !validBinding(binding) || len(files) == 0 || len(files) > MaxFiles {
		return nil, ErrInvalid
	}
	paths := make([]string, 0, len(files))
	seen := make(map[string]bool, len(files))
	totalSource := 0
	for path, content := range files {
		if !safePath(path) {
			return nil, ErrUnsafe
		}
		if !claimPath(seen, path) {
			return nil, ErrInvalid
		}
		if len(content) > MaxFileBytes {
			return nil, ErrInvalid
		}
		totalSource += len(content)
		if totalSource > MaxArchiveBytes {
			return nil, ErrInvalid
		}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	m := manifest{Format: "cg-artifact/1", Binding: binding, Files: make([]File, 0, len(paths))}
	entries := make([]zipEntry, 1, len(paths)+1)
	for _, path := range paths {
		content := files[path]
		if err := checkText(content); err != nil {
			return nil, err
		}
		digest := sha256.Sum256(content)
		m.Files = append(m.Files, File{Path: path, SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(content))})
		entries = append(entries, zipEntry{name: "files/" + path, data: content})
	}
	metadata, err := json.Marshal(m)
	if err != nil || len(metadata) > MaxManifestBytes {
		return nil, ErrInvalid
	}
	entries[0] = zipEntry{name: "manifest.json", data: metadata}
	return encodeZIP(entries)
}

func validBinding(b Binding) bool {
	if (b.Purpose != "result" && b.Purpose != "checkpoint") || b.TaskVersion < 1 {
		return false
	}
	for _, value := range []string{b.TaskID, b.ContractHash, b.LeaseID, b.BaseCommit, b.StrategyID} {
		if len(value) == 0 || len(value) > 512 || !utf8.ValidString(value) {
			return false
		}
		for _, r := range value {
			if unicode.IsControl(r) || bidi(r) {
				return false
			}
		}
	}
	return true
}

func lowerHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// A regular file cannot also be an ancestor directory. Compare case-insensitively
// because bundles must remain unambiguous on Windows as well as Unix filesystems.
func claimPath(seen map[string]bool, path string) bool {
	fold := strings.ToLower(path)
	for existing := range seen {
		if fold == existing || strings.HasPrefix(fold, existing+"/") || strings.HasPrefix(existing, fold+"/") {
			return false
		}
	}
	seen[fold] = true
	return true
}

func safePath(path string) bool {
	if len(path) == 0 || len(path) > maxPathBytes {
		return false
	}
	for _, c := range path {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("_./-", c)) {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		lower := strings.ToLower(part)
		if lower == ".git" || lower == ".codex" || lower == ".claude" || lower == ".env" || strings.HasPrefix(lower, ".env.") || lower == ".ssh" || lower == ".aws" || lower == ".npmrc" || lower == ".netrc" || lower == "auth.json" || lower == "credentials" || lower == "credentials.json" || lower == "id_rsa" || lower == "id_ed25519" {
			return false
		}
		stem := strings.TrimRight(strings.SplitN(lower, ".", 2)[0], " ")
		if stem == "con" || stem == "prn" || stem == "aux" || stem == "nul" || stem == "conin$" || stem == "conout$" || stem == "clock$" || (len(stem) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) && stem[3] >= '0' && stem[3] <= '9') {
			return false
		}
	}
	return true
}

// bidi reports invisible or format characters that can conceal text from a
// reviewer: every Unicode Cf character (zero-width, bidi, BOM, soft hyphen,
// tags), U+2028/2029, variation selectors, the combining grapheme joiner and
// Hangul fillers. Keep in lockstep with the TypeScript validators.
func bidi(r rune) bool {
	if unicode.Is(unicode.Cf, r) {
		return true
	}
	switch {
	case r == 0x034f, r == 0x115f, r == 0x1160, r == 0x2028, r == 0x2029, r == 0x3164, r == 0xffa0, r == 0x180f:
		return true
	case r >= 0x180b && r <= 0x180d, r >= 0xfe00 && r <= 0xfe0f, r >= 0xe0100 && r <= 0xe01ef:
		return true
	}
	return false
}

var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----`),
	regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
	regexp.MustCompile(`\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b`),
	regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/\-]{8,}={0,2}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`),
	regexp.MustCompile(`(?i)\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s/'"@:]+:[^\s/'"@]+@`),
	regexp.MustCompile("(?i)[\"'`]?" + `(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)` + "[\"'`]?\\s*[:=]\\s*[\"'`][^\"'`\\r\\n]{8,}[\"'`]"),
}

func checkText(raw []byte) error {
	if !utf8.Valid(raw) {
		return ErrUnsafe
	}
	for _, r := range string(raw) {
		if (unicode.IsControl(r) && r != '\t' && r != '\r' && r != '\n') || bidi(r) {
			return ErrUnsafe
		}
	}
	for _, pattern := range credentialPatterns {
		if pattern.Match(raw) {
			return ErrUnsafe
		}
	}
	return nil
}

// exactObject rejects duplicate and unknown fields before JSON decoding can
// discard information. It also requires every field, excluding null values.
func exactObject(raw []byte, fields []string) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, ErrInvalid
	}
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	result := make(map[string]json.RawMessage, len(fields))
	for d.More() {
		token, err := d.Token()
		key, ok := token.(string)
		if err != nil || !ok || !allowed[key] || result[key] != nil {
			return nil, ErrInvalid
		}
		var value json.RawMessage
		if d.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, ErrInvalid
		}
		result[key] = value
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') || len(result) != len(fields) {
		return nil, ErrInvalid
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, ErrInvalid
	}
	return result, nil
}

func parseManifest(raw []byte) (manifest, error) {
	var m manifest
	if len(raw) > MaxManifestBytes || !utf8.Valid(raw) {
		return m, ErrInvalid
	}
	fields, err := exactObject(raw, []string{"format", "purpose", "task_id", "task_version", "contract_hash", "lease_id", "base_commit", "strategy_id", "files"})
	if err != nil {
		return m, err
	}
	if json.Unmarshal(raw, &m) != nil {
		return m, ErrInvalid
	}
	var files []json.RawMessage
	if json.Unmarshal(fields["files"], &files) != nil || len(files) == 0 || len(files) > MaxFiles {
		return m, ErrInvalid
	}
	for _, file := range files {
		if _, err := exactObject(file, []string{"path", "sha256", "size_bytes"}); err != nil {
			return m, err
		}
	}
	return m, nil
}

func u16(b []byte, at int) uint16          { return binary.LittleEndian.Uint16(b[at : at+2]) }
func u32(b []byte, at int) uint32          { return binary.LittleEndian.Uint32(b[at : at+4]) }
func put16(b []byte, at int, value uint16) { binary.LittleEndian.PutUint16(b[at:at+2], value) }
func put32(b []byte, at int, value uint32) { binary.LittleEndian.PutUint32(b[at:at+4], value) }

func parseZIP(raw []byte) ([]zipEntry, error) {
	if len(raw) < 22 || len(raw) > MaxArchiveBytes {
		return nil, ErrInvalid
	}
	end := len(raw) - 22
	eocd := raw[end:]
	if u32(eocd, 0) != 0x06054b50 || u16(eocd, 4) != 0 || u16(eocd, 6) != 0 || u16(eocd, 20) != 0 {
		return nil, ErrInvalid
	}
	count := int(u16(eocd, 10))
	if count < 2 || count > MaxFiles+1 || int(u16(eocd, 8)) != count {
		return nil, ErrInvalid
	}
	central := int(u32(eocd, 16))
	if central > end || int(u32(eocd, 12)) != end-central {
		return nil, ErrInvalid
	}
	position, local := central, 0
	entries := make([]zipEntry, 0, count)
	seen := make(map[string]bool, count)
	for i := 0; i < count; i++ {
		if position+46 > end {
			return nil, ErrInvalid
		}
		h := raw[position : position+46]
		nameSize := int(u16(h, 28))
		flags, size := u16(h, 8), int(u32(h, 24))
		if u32(h, 0) != 0x02014b50 || u16(h, 4) != 0x0314 || u16(h, 6) != 20 || (flags != 0 && flags != 0x0800) || u16(h, 10) != 0 || u32(h, 20) != uint32(size) || u16(h, 30) != 0 || u16(h, 32) != 0 || u16(h, 34) != 0 || u16(h, 36) != 0 || u32(h, 42) != uint32(local) || nameSize == 0 || nameSize > maxPathBytes+6 || position+46+nameSize > end {
			return nil, ErrInvalid
		}
		mode, dosAttrs := u32(h, 38)>>16, u32(h, 38)&0xffff
		if mode&0170000 != 0100000 || mode&0111 != 0 || mode&07000 != 0 || dosAttrs != 0 {
			return nil, ErrUnsafe
		}
		name := string(raw[position+46 : position+46+nameSize])
		if i == 0 {
			if name != "manifest.json" || size > MaxManifestBytes {
				return nil, ErrInvalid
			}
		} else {
			if !strings.HasPrefix(name, "files/") || !safePath(strings.TrimPrefix(name, "files/")) || size > MaxFileBytes {
				return nil, ErrUnsafe
			}
			if i > 1 && name <= entries[i-1].name {
				return nil, ErrInvalid
			}
		}
		if !claimPath(seen, name) {
			return nil, ErrInvalid
		}
		if local+30 > central {
			return nil, ErrInvalid
		}
		lh := raw[local : local+30]
		if u32(lh, 0) != 0x04034b50 || u16(lh, 4) != u16(h, 6) || u16(lh, 6) != flags || u16(lh, 8) != 0 || u16(lh, 10) != u16(h, 12) || u16(lh, 12) != u16(h, 14) || u32(lh, 14) != u32(h, 16) || u32(lh, 18) != uint32(size) || u32(lh, 22) != uint32(size) || int(u16(lh, 26)) != nameSize || u16(lh, 28) != 0 {
			return nil, ErrInvalid
		}
		dataStart := local + 30 + nameSize
		if dataStart > central || size > central-dataStart || string(raw[local+30:dataStart]) != name {
			return nil, ErrInvalid
		}
		data := raw[dataStart : dataStart+size]
		if crc32.ChecksumIEEE(data) != u32(h, 16) {
			return nil, ErrInvalid
		}
		entries = append(entries, zipEntry{name: name, data: data})
		local = dataStart + size
		position += 46 + nameSize
	}
	if local != central || position != end {
		return nil, ErrInvalid
	}
	return entries, nil
}

func encodeZIP(entries []zipEntry) ([]byte, error) {
	total := 22
	for _, entry := range entries {
		total += 76 + 2*len(entry.name) + len(entry.data)
	}
	if total > MaxArchiveBytes {
		return nil, ErrInvalid
	}
	raw := make([]byte, 0, total)
	offsets := make([]uint32, len(entries))
	for i, entry := range entries {
		offsets[i] = uint32(len(raw))
		h := make([]byte, 30)
		put32(h, 0, 0x04034b50)
		put16(h, 4, 20)
		put16(h, 6, 0x0800)
		put16(h, 12, 33)
		put32(h, 14, crc32.ChecksumIEEE(entry.data))
		put32(h, 18, uint32(len(entry.data)))
		put32(h, 22, uint32(len(entry.data)))
		put16(h, 26, uint16(len(entry.name)))
		raw = append(raw, h...)
		raw = append(raw, entry.name...)
		raw = append(raw, entry.data...)
	}
	central := len(raw)
	for i, entry := range entries {
		h := make([]byte, 46)
		put32(h, 0, 0x02014b50)
		put16(h, 4, 0x0314)
		put16(h, 6, 20)
		put16(h, 8, 0x0800)
		put16(h, 14, 33)
		put32(h, 16, crc32.ChecksumIEEE(entry.data))
		put32(h, 20, uint32(len(entry.data)))
		put32(h, 24, uint32(len(entry.data)))
		put16(h, 28, uint16(len(entry.name)))
		put32(h, 38, 0100644<<16)
		put32(h, 42, offsets[i])
		raw = append(raw, h...)
		raw = append(raw, entry.name...)
	}
	eocd := make([]byte, 22)
	put32(eocd, 0, 0x06054b50)
	put16(eocd, 8, uint16(len(entries)))
	put16(eocd, 10, uint16(len(entries)))
	put32(eocd, 12, uint32(len(raw)-central))
	put32(eocd, 16, uint32(central))
	return append(raw, eocd...), nil
}
