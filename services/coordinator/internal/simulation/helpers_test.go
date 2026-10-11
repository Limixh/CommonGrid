package simulation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const scenarioDir = "testdata/scenarios"

func fixtureNames(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(scenarioDir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no fixture scenarios: %v", err)
	}
	return files
}

func loadFixture(t *testing.T, name string) *Scenario {
	t.Helper()
	sc, err := LoadFile(filepath.Join(scenarioDir, name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

type obj = map[string]any

func leafNode(id, task string, p float64, workMin, workMax int64, extra obj) obj {
	syn := obj{"work_sec": obj{"min": workMin, "max": workMax}, "profiles": obj{"default": obj{"success_probability": p}}}
	for k, v := range extra {
		syn[k] = v
	}
	return obj{"id": id, "task_id": task, "relation": "leaf", "synthetic": syn}
}

func innerNode(id, task, relation string, children ...string) obj {
	return obj{"id": id, "task_id": task, "relation": relation, "children": children}
}

func volunteer(id, profile, provider string, extra obj) obj {
	v := obj{"id": id, "profile": profile, "provider": provider, "join_sec": 0, "slots": 1}
	for k, x := range extra {
		v[k] = x
	}
	return v
}

// miniScenario builds a scenario over the shared contract pool.
func miniScenario(t *testing.T, root string, nodes []obj, vols []obj, budget int64, extra obj) *Scenario {
	t.Helper()
	doc := obj{
		"format": ScenarioFormat, "format_version": ScenarioVersion, "id": "mini", "title": "Mini",
		"contracts_file": "../contracts.json", "root": root, "nodes": nodes, "volunteers": vols,
		"budget": obj{"total_agent_sec": budget},
	}
	for k, v := range extra {
		doc[k] = v
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	sc, err := Parse(raw, scenarioDir)
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

func policy(t *testing.T, id string) PolicySpec {
	t.Helper()
	specs, err := ParsePolicies([]string{id})
	if err != nil {
		t.Fatal(err)
	}
	return specs[0]
}

func runPolicy(t *testing.T, sc *Scenario, id string, seed int64, run int) *RunResult {
	t.Helper()
	return RunOnce(sc, policy(t, id), NewWorld(seed, run), run)
}

func allPolicies(t *testing.T) []PolicySpec {
	t.Helper()
	specs, err := ParsePolicies(DefaultPolicies())
	if err != nil {
		t.Fatal(err)
	}
	return specs
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
