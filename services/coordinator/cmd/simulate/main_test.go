package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fixtures = "../../internal/simulation/testdata/scenarios/"

func invoke(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestEveryFixtureRunsThroughTheCLI(t *testing.T) {
	files, err := filepath.Glob(fixtures + "*.json")
	if err != nil || len(files) < 7 {
		t.Fatalf("fixtures: %v %v", files, err)
	}
	for _, file := range files {
		code, out, errOut := invoke("--scenario", file, "--seed", "3", "--samples", "4")
		if code != 0 {
			t.Fatalf("%s: exit %d: %s", file, code, errOut)
		}
		var report struct {
			Format   string `json:"format"`
			Seed     int64  `json:"seed"`
			Samples  int    `json:"samples"`
			Policies []struct {
				Policy string `json:"policy"`
				Runs   []any  `json:"runs"`
			} `json:"policies"`
		}
		if err := json.Unmarshal([]byte(out), &report); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if report.Format != "commongrid.simulation.report" || report.Seed != 3 || report.Samples != 4 || len(report.Policies) != 4 {
			t.Fatalf("%s: %+v", file, report)
		}
		for _, p := range report.Policies {
			if len(p.Runs) != 4 {
				t.Fatalf("%s %s: %d runs", file, p.Policy, len(p.Runs))
			}
		}
	}
}

func TestCLIIsDeterministicAndHonoursPolicyList(t *testing.T) {
	args := []string{"--scenario", fixtures + "trap-branch.json", "--seed", "5", "--samples", "6", "--policies", "fixed:2,least-attempted"}
	_, first, _ := invoke(args...)
	_, second, _ := invoke(args...)
	if first == "" || first != second {
		t.Fatal("same flags must give byte-identical output")
	}
	var report struct {
		Policies []struct {
			Policy string `json:"policy"`
		} `json:"policies"`
	}
	if err := json.Unmarshal([]byte(first), &report); err != nil || len(report.Policies) != 2 || report.Policies[0].Policy != "fixed:2" || report.Policies[1].Policy != "least-attempted" {
		t.Fatalf("policy list not honoured: %v %+v", err, report)
	}
	_, other, _ := invoke("--scenario", fixtures+"trap-branch.json", "--seed", "6", "--samples", "6", "--policies", "fixed:2,least-attempted")
	if other == first {
		t.Fatal("seed ignored")
	}
}

func TestCLIWritesOutFile(t *testing.T) {
	out := filepath.Join(t.TempDir(), "report.json")
	code, stdout, errOut := invoke("--scenario", fixtures+"easy-or.json", "--seed", "1", "--samples", "2", "--out", out)
	if code != 0 || stdout != "" {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, errOut)
	}
	raw, err := os.ReadFile(out)
	if err != nil || !json.Valid(raw) {
		t.Fatalf("report file: %v", err)
	}
	_, direct, _ := invoke("--scenario", fixtures+"easy-or.json", "--seed", "1", "--samples", "2")
	if string(raw) != direct {
		t.Fatal("file and stdout reports differ")
	}
}

func TestCLIRejectsBadUsage(t *testing.T) {
	for name, args := range map[string][]string{
		"no arguments":     {},
		"missing seed":     {"--scenario", fixtures + "easy-or.json"},
		"missing scenario": {"--seed", "1"},
		"bad policy":       {"--scenario", fixtures + "easy-or.json", "--seed", "1", "--policies", "random"},
		"duplicate policy": {"--scenario", fixtures + "easy-or.json", "--seed", "1", "--policies", "single,single"},
		"negative samples": {"--scenario", fixtures + "easy-or.json", "--seed", "1", "--samples", "-1"},
		"extra positional": {"--scenario", fixtures + "easy-or.json", "--seed", "1", "extra"},
		"unknown flag":     {"--scenario", fixtures + "easy-or.json", "--seed", "1", "--model", "x"},
	} {
		if code, out, _ := invoke(args...); code != 2 || out != "" {
			t.Fatalf("%s: exit %d, stdout %q", name, code, out)
		}
	}
	for name, args := range map[string][]string{
		"missing file":     {"--scenario", fixtures + "nope.json", "--seed", "1"},
		"too many samples": {"--scenario", fixtures + "easy-or.json", "--seed", "1", "--samples", "10001"},
	} {
		code, out, errOut := invoke(args...)
		if code != 1 || out != "" || !strings.HasPrefix(errOut, "simulate:") {
			t.Fatalf("%s: exit %d, stdout %q, stderr %q", name, code, out, errOut)
		}
	}
}

func TestCLIRejectsAScenarioWithAnUnvalidatedContract(t *testing.T) {
	dir := t.TempDir()
	contracts, err := os.ReadFile(fixtures + "../contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	// Any byte change inside a contract breaks its contract_hash.
	tampered := strings.Replace(string(contracts), "Simulation branch A", "Simulation branch Z", 1)
	if tampered == string(contracts) {
		t.Fatal("tamper had no effect")
	}
	scenario, _ := os.ReadFile(fixtures + "easy-or.json")
	if err := os.WriteFile(filepath.Join(dir, "contracts.json"), []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "scenario.json")
	if err := os.WriteFile(path, []byte(strings.Replace(string(scenario), "../contracts.json", "contracts.json", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _, errOut := invoke("--scenario", path, "--seed", "1")
	if code != 1 || !strings.Contains(errOut, "contract") {
		t.Fatalf("exit %d: %s", code, errOut)
	}
}
