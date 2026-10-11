package simulation

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func simulateJSON(t *testing.T, name string, seed int64, samples int) []byte {
	t.Helper()
	sc := loadFixture(t, name)
	rep, err := Simulate(sc, Options{Seed: seed, Samples: samples, Policies: allPolicies(t)})
	if err != nil {
		t.Fatal(err)
	}
	out, err := rep.JSON()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSameInputAndSeedGiveByteIdenticalJSON(t *testing.T) {
	for _, path := range fixtureNames(t) {
		name := strings.TrimSuffix(path[strings.LastIndex(path, "/")+1:], ".json")
		first := simulateJSON(t, name, 11, 6)
		if second := simulateJSON(t, name, 11, 6); !bytes.Equal(first, second) {
			t.Fatalf("%s: two runs differ", name)
		}
		if other := simulateJSON(t, name, 12, 6); bytes.Equal(first, other) {
			t.Fatalf("%s: the seed has no effect", name)
		}
		if !json.Valid(first) || first[len(first)-1] != '\n' {
			t.Fatalf("%s: malformed output", name)
		}
	}
}

func TestGoldenReport(t *testing.T) {
	got := simulateJSON(t, "easy-or", 7, 4)
	const golden = "testdata/golden/easy-or.seed7.samples4.json"
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll("testdata/golden", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if want := readFile(t, golden); !bytes.Equal(got, want) {
		t.Fatal("report differs from the golden file; if the change is intended run UPDATE_GOLDEN=1 go test ./internal/simulation -run TestGoldenReport")
	}
}

func TestReportSchemaFields(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(simulateJSON(t, "verification-review-queue", 2, 3), &doc); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"format", "report_version", "disclaimer", "seed", "scenario", "budget", "samples", "worlds", "policies"} {
		if _, ok := doc[k]; !ok {
			t.Fatalf("missing top-level %s", k)
		}
	}
	if !strings.Contains(doc["disclaimer"].(string), "not product acceptance") {
		t.Fatal("report must disclaim real-world meaning")
	}
	pol := doc["policies"].([]any)[0].(map[string]any)
	for _, k := range []string{"policy", "samples", "solved_runs", "unsolved_runs", "solve_rate", "end_reasons", "agent_hours_total",
		"agent_hours_per_solved", "wall_time_sec_solved_runs", "attempts", "queues", "correlation", "handoff", "runs"} {
		if _, ok := pol[k]; !ok {
			t.Fatalf("missing policy field %s", k)
		}
	}
	queues := pol["queues"].(map[string]any)
	if queues["verification_wait_sec"].(map[string]any)["count"].(float64) == 0 || queues["review_wait_sec"].(map[string]any)["count"].(float64) == 0 {
		t.Fatal("the queue fixture must measure verification and review waits")
	}
}

func TestSolveRateIsTheExactFraction(t *testing.T) {
	sc := miniScenario(t, "a", []obj{leafNode("a", "sim-a", 0.35, 100, 100, nil)}, []obj{volunteer("v1", "alpha", "prov-x", nil)}, 1250, nil)
	rep, err := Simulate(sc, Options{Seed: 17, Samples: 40, Policies: []PolicySpec{policy(t, "single")}})
	if err != nil {
		t.Fatal(err)
	}
	p := rep.Policies[0]
	if p.SolvedRuns == 0 || p.SolvedRuns == 40 {
		t.Fatalf("expected a mix of solved and unsolved runs, got %d/40", p.SolvedRuns)
	}
	if p.SolvedRuns+p.UnsolvedRuns != 40 || p.SolveRate.V != float64(p.SolvedRuns)/40 || len(p.Runs) != 40 {
		t.Fatalf("rate inconsistent: %+v", p)
	}
	solved, unsolved := 0, 0
	for _, r := range p.Runs {
		if r.Solved != r.WallTimeSec.OK {
			t.Fatalf("wall time must exist exactly for solved runs: %+v", r)
		}
		if r.Solved {
			solved++
		} else {
			unsolved++
		}
	}
	if solved != p.SolvedRuns || unsolved != p.UnsolvedRuns || p.WallTimeSec.Count != solved {
		t.Fatalf("per-run records disagree with the summary: %+v", p)
	}
	// Spend of unsolved runs is part of the per-solved cost.
	var all int64
	for _, r := range p.Runs {
		all += r.AgentSec
	}
	if want := float64(all) / 3600 / float64(p.SolvedRuns); p.AgentHoursPerSolved.V != want {
		t.Fatalf("agent-hours per solved %v, want %v", p.AgentHoursPerSolved.V, want)
	}
}

func TestMetricFormatting(t *testing.T) {
	for in, want := range map[float64]string{0: "0", 1: "1", 0.5: "0.5", 1.0 / 3: "0.333333", 2.0 / 3: "0.666667", 100: "100", -0.0000001: "0", 1234.5678914: "1234.567891"} {
		if got := formatNum(in); got != want {
			t.Fatalf("formatNum(%v) = %s, want %s", in, got, want)
		}
	}
	raw, _ := json.Marshal(struct {
		A Value
		B Value
		C Num
	}{measured(0), Value{}, Num(0.25)})
	if string(raw) != `{"A":0,"B":"not_measured","C":0.25}` {
		t.Fatalf("got %s", raw)
	}
	if ratio(3, 0).OK || !ratio(0, 5).OK {
		t.Fatal("a ratio over nothing is undefined, a measured zero numerator is not")
	}
	if summarize(nil).Mean.OK {
		t.Fatal("empty summary must be undefined")
	}
	if s := summarize([]int64{4, 1, 3, 2}); s.Median.V != 2.5 || s.Mean.V != 2.5 || s.Max.V != 4 || s.Count != 4 {
		t.Fatalf("%+v", s)
	}
}

func TestSimulateRejectsBadOptions(t *testing.T) {
	sc := loadFixture(t, "easy-or")
	if _, err := Simulate(sc, Options{Seed: 1, Samples: maxSamples + 1, Policies: allPolicies(t)}); err == nil {
		t.Fatal("too many samples")
	}
	if _, err := Simulate(sc, Options{Seed: 1}); err == nil {
		t.Fatal("no policies")
	}
	rep, err := Simulate(sc, Options{Seed: 1, Policies: allPolicies(t)})
	if err != nil || rep.Samples != sc.RecommendedSamples {
		t.Fatalf("default sample count: %v %v", rep, err)
	}
}
