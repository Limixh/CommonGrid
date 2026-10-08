package artifact

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"commongrid/coordinator/internal/contract"
)

func bundleFixture() (Binding, contract.TaskContract) {
	b := Binding{Purpose: "result", TaskID: "task-1", TaskVersion: 1, ContractHash: strings.Repeat("a", 64), LeaseID: "lease-1", BaseCommit: strings.Repeat("b", 40), StrategyID: "strategy-1"}
	task := contract.TaskContract{Id: b.TaskID, TaskVersion: b.TaskVersion, ContractHash: b.ContractHash, Strategies: []contract.Strategy{{Id: b.StrategyID}}, Workspace: contract.Workspace{Commit: b.BaseCommit, WritablePaths: []string{"src/a.ts", "src/b.ts"}}}
	return b, task
}

func mustBundle(t *testing.T, binding Binding, files map[string][]byte) []byte {
	t.Helper()
	raw, err := Encode(binding, files)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// This helper intentionally bypasses source safety to produce adversarial input.
func unsafeBundle(t *testing.T, binding Binding, files []zipEntry) []byte {
	t.Helper()
	m := manifest{Format: "cg-artifact/1", Binding: binding, Files: []File{}}
	for _, f := range files {
		digest := sha256.Sum256(f.data)
		m.Files = append(m.Files, File{Path: f.name, SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(f.data))})
	}
	metadata, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	entries := []zipEntry{{name: "manifest.json", data: metadata}}
	for _, f := range files {
		entries = append(entries, zipEntry{name: "files/" + f.name, data: f.data})
	}
	raw, err := encodeZIP(entries)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func mutateManifest(t *testing.T, raw []byte, change func([]byte) []byte) []byte {
	t.Helper()
	entries, err := parseZIP(raw)
	if err != nil {
		t.Fatal(err)
	}
	entries[0].data = change(bytes.Clone(entries[0].data))
	result, err := encodeZIP(entries)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func requireRejection(t *testing.T, raw []byte, task contract.TaskContract, b Binding) {
	t.Helper()
	bundle, err := Validate(raw, task, b)
	if err == nil || (!errors.Is(err, ErrInvalid) && !errors.Is(err, ErrUnsafe)) {
		t.Fatalf("expected fixed rejection, got %v", err)
	}
	if bundle.Files != nil || bundle.TaskID != "" {
		t.Fatal("rejected artifact exposed partial content")
	}
	if err.Error() != "artifact_invalid" && err.Error() != "artifact_unsafe" {
		t.Fatalf("rejection exposed detail: %q", err.Error())
	}
}

func TestBundleDeterministicAndZIPCompatible(t *testing.T) {
	b, task := bundleFixture()
	files := map[string][]byte{"src/b.ts": []byte("export const b = 2;\n"), "src/a.ts": []byte("export const a = 1;\n")}
	raw := mustBundle(t, b, files)
	if !bytes.Equal(raw, mustBundle(t, b, files)) {
		t.Fatal("encoding is not deterministic")
	}
	got, err := Validate(raw, task, b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 2 || got.Files[0].Path != "src/a.ts" || !bytes.Equal(got.Files[1].Bytes, files["src/b.ts"]) {
		t.Fatal("file inventory changed")
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 3 || zr.File[0].Name != "manifest.json" {
		t.Fatal("invalid ZIP inventory")
	}
	for _, f := range zr.File {
		if f.Method != zip.Store || f.Mode().Perm() != 0644 || !f.Mode().IsRegular() {
			t.Fatalf("invalid ZIP member mode/method: %v", f)
		}
	}
	// The returned sources own their bytes: later caller mutation cannot change them.
	for i := range raw {
		raw[i] = 0
	}
	if string(got.Files[0].Bytes) != "export const a = 1;\n" {
		t.Fatal("returned source aliases input")
	}
}

func TestBundleHeaderTampering(t *testing.T) {
	b, task := bundleFixture()
	original := mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("a\n")})
	central := int(u32(original[len(original)-22:], 16))
	mutations := map[string]func([]byte){
		"local_compression":    func(raw []byte) { put16(raw, 8, 8) },
		"central_compression":  func(raw []byte) { put16(raw, central+10, 8) },
		"encryption":           func(raw []byte) { put16(raw, 6, 0x0801); put16(raw, central+8, 0x0801) },
		"data_descriptor":      func(raw []byte) { put16(raw, 6, 0x0808); put16(raw, central+8, 0x0808) },
		"local_extra":          func(raw []byte) { put16(raw, 28, 1) },
		"central_extra":        func(raw []byte) { put16(raw, central+30, 1) },
		"central_comment":      func(raw []byte) { put16(raw, central+32, 1) },
		"archive_comment":      func(raw []byte) { put16(raw, len(raw)-2, 1) },
		"ZIP64":                func(raw []byte) { put32(raw, central+24, 0xffffffff) },
		"local_size":           func(raw []byte) { put32(raw, 22, 1) },
		"central_size":         func(raw []byte) { put32(raw, central+24, 1) },
		"CRC":                  func(raw []byte) { put32(raw, 14, 0); put32(raw, central+16, 0) },
		"local_name":           func(raw []byte) { raw[30] = 'x' },
		"noncontiguous_offset": func(raw []byte) { put32(raw, central+42, 1) },
		"executable":           func(raw []byte) { put32(raw, central+38, 0100755<<16) },
		"symlink":              func(raw []byte) { put32(raw, central+38, 0120644<<16) },
		"directory":            func(raw []byte) { put32(raw, central+38, 0040644<<16) },
		"special_mode":         func(raw []byte) { put32(raw, central+38, 0104644<<16) },
		"DOS_directory":        func(raw []byte) { put32(raw, central+38, 0100644<<16|16) },
		"multidisk":            func(raw []byte) { put16(raw, len(raw)-18, 1) },
		"local_datetime":       func(raw []byte) { put16(raw, 12, 34) },
		"version":              func(raw []byte) { put16(raw, central+6, 45) },
	}
	for name, mutation := range mutations {
		t.Run(name, func(t *testing.T) { raw := bytes.Clone(original); mutation(raw); requireRejection(t, raw, task, b) })
	}
	for _, raw := range [][]byte{append([]byte("hidden"), original...), append(bytes.Clone(original), []byte("hidden")...), original[:len(original)-1], make([]byte, MaxArchiveBytes+1)} {
		requireRejection(t, raw, task, b)
	}
	// Hidden bytes between local payloads and the central directory, with otherwise
	// corrected offsets, are also forbidden.
	raw := append(bytes.Clone(original[:central]), 0)
	raw = append(raw, original[central:]...)
	put32(raw, len(raw)-6, uint32(central+1))
	requireRejection(t, raw, task, b)
}

func TestBundleManifestStrictnessAndBinding(t *testing.T) {
	b, task := bundleFixture()
	raw := mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("a\n")})
	mutations := map[string]func([]byte) []byte{
		"unknown": func(m []byte) []byte {
			return bytes.Replace(m, []byte(`"format":`), []byte(`"unknown":0,"format":`), 1)
		},
		"duplicate": func(m []byte) []byte {
			return bytes.Replace(m, []byte(`"purpose":`), []byte(`"purpose":"checkpoint","purpose":`), 1)
		},
		"case_alias": func(m []byte) []byte { return bytes.Replace(m, []byte(`"purpose":`), []byte(`"Purpose":`), 1) },
		"missing":    func(m []byte) []byte { return bytes.Replace(m, []byte(`"purpose":"result",`), nil, 1) },
		"null": func(m []byte) []byte {
			return bytes.Replace(m, []byte(`"files":[`), []byte(`"files":null,"other":[`), 1)
		},
		"fractional_version": func(m []byte) []byte {
			return bytes.Replace(m, []byte(`"task_version":1`), []byte(`"task_version":1.5`), 1)
		},
		"overflow_version": func(m []byte) []byte {
			return bytes.Replace(m, []byte(`"task_version":1`), []byte(`"task_version":9223372036854775808`), 1)
		},
		"format": func(m []byte) []byte { return bytes.Replace(m, []byte("cg-artifact/1"), []byte("cg-artifact/2"), 1) },
		"digest": func(m []byte) []byte {
			var x manifest
			_ = json.Unmarshal(m, &x)
			x.Files[0].SHA256 = strings.Repeat("0", 64)
			result, _ := json.Marshal(x)
			return result
		},
		"size": func(m []byte) []byte { return bytes.Replace(m, []byte(`"size_bytes":2`), []byte(`"size_bytes":3`), 1) },
		"file_duplicate": func(m []byte) []byte {
			return bytes.Replace(m, []byte(`"path":`), []byte(`"path":"ignored","path":`), 1)
		},
		"file_unknown":  func(m []byte) []byte { return bytes.Replace(m, []byte(`"path":`), []byte(`"mode":0,"path":`), 1) },
		"trailing_json": func(m []byte) []byte { return append(m, []byte(`{}`)...) },
	}
	for name, change := range mutations {
		t.Run(name, func(t *testing.T) { requireRejection(t, mutateManifest(t, raw, change), task, b) })
	}
	for _, change := range []func(*Binding){
		func(x *Binding) { x.Purpose = "checkpoint" }, func(x *Binding) { x.TaskID = "task-2" }, func(x *Binding) { x.TaskVersion++ }, func(x *Binding) { x.ContractHash = strings.Repeat("d", 64) }, func(x *Binding) { x.LeaseID = "lease-2" }, func(x *Binding) { x.BaseCommit = strings.Repeat("c", 40) }, func(x *Binding) { x.StrategyID = "other" },
	} {
		changed := b
		change(&changed)
		requireRejection(t, raw, task, changed)
	}
	task.Workspace.Commit = "other"
	requireRejection(t, raw, task, b)
	task.Workspace.Commit = b.BaseCommit
	task.Strategies = nil
	requireRejection(t, raw, task, b)
}

func TestBundlePathInventoryAndAuthorization(t *testing.T) {
	b, task := bundleFixture()
	paths := []string{"../a.ts", "/src/a.ts", "src\\a.ts", "src/a:stream", "src//a.ts", "src/./a.ts", "src/../a.ts", "src/a.ts.", "src/a.ts ", "src/CON.ts", "src/lpt1.ts", "src/.GiT/config", ".codex/config", ".claude/config", "src/.env", "src/.env.local", ".aws/credentials", ".ssh/id_rsa", "src/credentials.json", "src/*.ts", "src/a\u202ets", "src/ı.ts", "src/a\x00.ts", "src/" + strings.Repeat("a", 512)}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			task.Workspace.WritablePaths = []string{path}
			raw := unsafeBundle(t, b, []zipEntry{{name: path, data: []byte("x")}})
			requireRejection(t, raw, task, b)
		})
	}
	task.Workspace.WritablePaths = []string{"src"}
	requireRejection(t, unsafeBundle(t, b, []zipEntry{{name: "src/a.ts", data: []byte("x")}}), task, b)
	task.Workspace.WritablePaths = []string{"src/a.ts"}
	requireRejection(t, unsafeBundle(t, b, []zipEntry{{name: "src/b.ts", data: []byte("x")}}), task, b)
	for _, entries := range [][]zipEntry{
		{{name: "src/a.ts", data: []byte("x")}, {name: "src/a.ts", data: []byte("y")}},
		{{name: "src/A.ts", data: []byte("x")}, {name: "src/a.ts", data: []byte("y")}},
		{{name: "src/b.ts", data: []byte("x")}, {name: "src/a.ts", data: []byte("y")}},
	} {
		requireRejection(t, unsafeBundle(t, b, entries), task, b)
	}
	raw := mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("x")})
	entries, _ := parseZIP(raw)
	entries = append(entries, zipEntry{name: "files/src/b.ts", data: []byte("extra")})
	extra, _ := encodeZIP(entries)
	requireRejection(t, extra, task, b)
}

func TestBundleBaselineSecretsAndUnsafeTextAreRedacted(t *testing.T) {
	b, task := bundleFixture()
	secrets := []string{
		"-----BEGIN PRIVATE KEY-----\nsynthetic\n", "AKIA" + strings.Repeat("C", 16), "sk-proj-" + strings.Repeat("x", 24), "ghp_" + strings.Repeat("x", 24), "github_pat_" + strings.Repeat("x", 24), "xoxb-" + strings.Repeat("x", 24), "Bearer synthetic_value_123", "eyJabcdefgh.abcdefghijk.abcdefghijk", "postgres://user:syntheticpassword@host", "const api_key = 'synthetic_canary_value';", "password: `synthetic_canary_value`", "const a = '\x00';", "const a = '\x85';", "const a = '\u202e';", "const a = '\u2066';", "const a = '\u061c';", string([]byte{0xff}),
	}
	for i, source := range secrets {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			raw := unsafeBundle(t, b, []zipEntry{{name: "src/a.ts", data: []byte(source)}})
			requireRejection(t, raw, task, b)
			if _, err := Encode(b, map[string][]byte{"src/a.ts": []byte(source)}); !errors.Is(err, ErrUnsafe) {
				t.Fatalf("encoder accepted unsafe text: %v", err)
			}
		})
	}
	// Literal policy: regex metacharacters have no executable or regex meaning.
	task.Verification.ForbiddenPatterns = []string{"danger.*call"}
	if _, err := Validate(mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("dangerABCcall")}), task, b); err != nil {
		t.Fatal(err)
	}
	requireRejection(t, mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("danger.*call")}), task, b)
	task.Verification.ForbiddenPatterns = []string{strings.Repeat("a", 4097)}
	requireRejection(t, mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("ok")}), task, b)
}

func TestBundleLimits(t *testing.T) {
	b, task := bundleFixture()
	if _, err := Encode(b, map[string][]byte{"src/a.ts": bytes.Repeat([]byte("a"), MaxFileBytes+1)}); !errors.Is(err, ErrInvalid) {
		t.Fatal("oversized source accepted")
	}
	raw := unsafeBundle(t, b, []zipEntry{{name: "src/a.ts", data: bytes.Repeat([]byte("a"), MaxFileBytes+1)}})
	requireRejection(t, raw, task, b)
	files := map[string][]byte{}
	for i := 0; i < MaxFiles+1; i++ {
		files["src/"+strings.Repeat("a", i+1)+".ts"] = []byte("x")
	}
	if _, err := Encode(b, files); !errors.Is(err, ErrInvalid) {
		t.Fatal("oversized inventory accepted")
	}
	files = map[string][]byte{}
	content := bytes.Repeat([]byte("a"), MaxFileBytes)
	for i := 0; i < MaxArchiveBytes/MaxFileBytes+1; i++ {
		files["src/"+strings.Repeat("a", i+1)+".ts"] = content
	}
	if _, err := Encode(b, files); !errors.Is(err, ErrInvalid) {
		t.Fatal("oversized aggregate accepted")
	}
	raw = mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("x")})
	raw = mutateManifest(t, raw, func(m []byte) []byte { return append(m, bytes.Repeat([]byte(" "), MaxManifestBytes)...) })
	requireRejection(t, raw, task, b)
	// Exact numeric values must survive above JavaScript's float precision range.
	b.TaskVersion = 9007199254740993
	task.TaskVersion = b.TaskVersion
	if _, err := Validate(mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("x")}), task, b); err != nil {
		t.Fatal(err)
	}
}

func TestBundleClientGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/client-bundle.zip")
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := os.ReadFile("testdata/client-binding.json")
	if err != nil {
		t.Fatal(err)
	}
	var binding Binding
	if err = json.Unmarshal(metadata, &binding); err != nil {
		t.Fatal(err)
	}
	metadata, err = os.ReadFile("testdata/client-task.json")
	if err != nil {
		t.Fatal(err)
	}
	var task contract.TaskContract
	if err = json.Unmarshal(metadata, &task); err != nil {
		t.Fatal(err)
	}
	if _, err = Validate(raw, task, binding); err != nil {
		t.Fatalf("client output rejected: %v", err)
	}
}

func TestBundleRejectsAncestorCollisionsAndEmptyInventory(t *testing.T) {
	b, task := bundleFixture()
	for _, paths := range [][]string{{"src/a", "src/a/b.ts"}, {"src/A", "src/a/b.ts"}, {"src/A/b.ts", "src/a"}} {
		task.Workspace.WritablePaths = paths
		files := map[string][]byte{}
		entries := []zipEntry{}
		for _, path := range paths {
			files[path] = []byte("x")
			entries = append(entries, zipEntry{name: path, data: []byte("x")})
		}
		if _, err := Encode(b, files); !errors.Is(err, ErrInvalid) {
			t.Fatalf("encoder accepted ancestor collision: %v", err)
		}
		requireRejection(t, unsafeBundle(t, b, entries), task, b)
	}
	if _, err := Encode(b, map[string][]byte{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("encoder accepted empty inventory: %v", err)
	}
	requireRejection(t, unsafeBundle(t, b, nil), task, b)
}

func TestBundleCheckpointRequiresAuthorizedWorkspaceSnapshot(t *testing.T) {
	b, task := bundleFixture()
	b.Purpose = "checkpoint"
	raw := mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("x")})
	for _, handoff := range []contract.Handoff{{}, {Enabled: true}, {AllowWorkspaceSnapshot: true}} {
		task.Handoff = handoff
		requireRejection(t, raw, task, b)
	}
	task.Handoff = contract.Handoff{Enabled: true, AllowWorkspaceSnapshot: true}
	if _, err := Validate(raw, task, b); err != nil {
		t.Fatalf("authorized hard checkpoint rejected: %v", err)
	}
	// Result artifacts do not rely on checkpoint handoff permission.
	b.Purpose = "result"
	task.Handoff = contract.Handoff{}
	if _, err := Validate(mustBundle(t, b, map[string][]byte{"src/a.ts": []byte("x")}), task, b); err != nil {
		t.Fatalf("result artifact incorrectly requires checkpoint permission: %v", err)
	}
}
