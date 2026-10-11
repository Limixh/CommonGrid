package simulation

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestFixtureScenariosLoadAndValidateContracts(t *testing.T) {
	names := fixtureNames(t)
	if len(names) < 7 {
		t.Fatalf("expected the seven fixture scenarios, found %d", len(names))
	}
	for _, path := range names {
		sc, err := LoadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if len(sc.TaskContracts) == 0 || sc.SourceSHA256 == "" {
			t.Fatalf("%s: contracts or hash missing", path)
		}
		for _, n := range sc.Nodes {
			if sc.TaskContracts[n.TaskID].NodeId != n.ID {
				t.Fatalf("%s: node %s not bound to its contract", path, n.ID)
			}
		}
	}
}

// The scenario holds AND/OR relations; the live task contracts must not.
func TestScenarioDataIsNotInTheLiveTaskSchema(t *testing.T) {
	raw := readFile(t, "testdata/contracts.json")
	for _, forbidden := range []string{`"relation"`, `"synthetic"`, `"success_probability"`, `"children"`} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("contracts carry simulation-only field %s", forbidden)
		}
	}
}

func scenarioDoc(t *testing.T, mutate func(obj)) []byte {
	t.Helper()
	var doc obj
	if err := json.Unmarshal(readFile(t, filepath.Join(scenarioDir, "easy-or.json")), &doc); err != nil {
		t.Fatal(err)
	}
	mutate(doc)
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func nodesOf(doc obj) []any { return doc["nodes"].([]any) }

func TestScenarioRejectsInvalidInput(t *testing.T) {
	cases := map[string]func(obj){
		"unknown top-level field": func(d obj) { d["gossip"] = 1 },
		"future format version":   func(d obj) { d["format_version"] = "2.0" },
		"wrong format":            func(d obj) { d["format"] = "commongrid.task" },
		"no budget":               func(d obj) { d["budget"] = obj{"total_agent_sec": 0} },
		"unknown relation":        func(d obj) { nodesOf(d)[0].(obj)["relation"] = "xor" },
		"leaf without synthetic":  func(d obj) { delete(nodesOf(d)[1].(obj), "synthetic") },
		"unknown contract":        func(d obj) { nodesOf(d)[1].(obj)["task_id"] = "does-not-exist" },
		"node id differs from contract node_id": func(d obj) {
			nodesOf(d)[1].(obj)["id"] = "renamed"
			nodesOf(d)[0].(obj)["children"] = []any{"renamed", "b", "c"}
		},
		"two parents": func(d obj) { nodesOf(d)[0].(obj)["children"] = []any{"a", "a", "b", "c"} },
		"unreachable node": func(d obj) {
			nodesOf(d)[0].(obj)["children"] = []any{"a", "b"}
		},
		"probability above one": func(d obj) {
			nodesOf(d)[1].(obj)["synthetic"].(obj)["profiles"].(obj)["default"] = obj{"success_probability": 1.5}
		},
		"missing default profile": func(d obj) {
			nodesOf(d)[1].(obj)["synthetic"].(obj)["profiles"] = obj{"alpha": obj{"success_probability": 0.5}}
		},
		"duplicate volunteer": func(d obj) {
			v := d["volunteers"].([]any)
			d["volunteers"] = append(v, v[0])
		},
		"no contracts source":               func(d obj) { delete(d, "contracts_file") },
		"absolute contracts file":           func(d obj) { d["contracts_file"] = "/etc/passwd" },
		"handoff overhead above time limit": func(d obj) { d["handoff"] = obj{"overhead_sec": 600} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(scenarioDoc(t, mutate), scenarioDir); err == nil {
				t.Fatal("scenario should be rejected")
			}
		})
	}
}

func TestScenarioRejectsTamperedContract(t *testing.T) {
	var file struct {
		Tasks []obj `json:"tasks"`
	}
	if err := json.Unmarshal(readFile(t, "testdata/contracts.json"), &file); err != nil {
		t.Fatal(err)
	}
	file.Tasks[1]["title"] = "tampered after hashing"
	inline := make([]json.RawMessage, len(file.Tasks))
	for i, task := range file.Tasks {
		inline[i], _ = json.Marshal(task)
	}
	raw := scenarioDoc(t, func(d obj) {
		delete(d, "contracts_file")
		d["contracts"] = inline
	})
	if _, err := Parse(raw, scenarioDir); err == nil || !strings.Contains(err.Error(), "contract") {
		t.Fatalf("a contract whose hash no longer matches must be rejected, got %v", err)
	}
}

func TestScenarioRejectsUnsatisfiableDependencies(t *testing.T) {
	// sim-dep needs sim-a. A sibling dependency is fine; depending on an
	// ancestor or on a task outside the scenario can never be satisfied.
	sc := miniScenario(t, "root", []obj{
		innerNode("root", "sim-root", "and", "a", "dep"),
		leafNode("a", "sim-a", 1, 100, 100, nil),
		leafNode("dep", "sim-dep", 1, 100, 100, nil),
	}, []obj{volunteer("v1", "alpha", "prov-x", nil)}, 3000, nil)
	if sc == nil {
		t.Fatal("dependency on a sibling must be accepted")
	}
	doc := obj{
		"format": ScenarioFormat, "format_version": ScenarioVersion, "id": "bad-dep", "title": "Bad",
		"contracts_file": "../contracts.json", "root": "dep",
		"nodes":      []obj{leafNode("dep", "sim-dep", 1, 100, 100, nil)},
		"volunteers": []obj{volunteer("v1", "alpha", "prov-x", nil)},
		"budget":     obj{"total_agent_sec": 3000},
	}
	raw, _ := json.Marshal(doc)
	if _, err := Parse(raw, scenarioDir); err == nil {
		t.Fatal("dependency outside the scenario must be rejected")
	}
	doc["root"] = "a"
	doc["nodes"] = []obj{innerNode("a", "sim-a", "and", "dep"), leafNode("dep", "sim-dep", 1, 100, 100, nil)}
	raw, _ = json.Marshal(doc)
	if _, err := Parse(raw, scenarioDir); err == nil {
		t.Fatal("dependency on an ancestor must be rejected")
	}
}

func TestParsePolicies(t *testing.T) {
	good := []string{"single", "fixed:3", "round-robin", "least-attempted"}
	specs, err := ParsePolicies(good)
	if err != nil {
		t.Fatal(err)
	}
	for i, spec := range specs {
		if spec.ID != good[i] || spec.New().ID() != good[i] {
			t.Fatalf("policy %d: %s", i, spec.ID)
		}
	}
	if specs[0].New().MaxParallel() != 1 || specs[1].New().MaxParallel() != 3 {
		t.Fatal("parallelism limits wrong")
	}
	for _, bad := range [][]string{{}, {"fixed"}, {"fixed:0"}, {"fixed:x"}, {"fixed:51"}, {"random"}, {"single:2"}, {"single", "single"}} {
		if _, err := ParsePolicies(bad); err == nil {
			t.Fatalf("%v should be rejected", bad)
		}
	}
}
