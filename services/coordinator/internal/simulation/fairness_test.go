package simulation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

// Variates are pure functions of their keys: asking in another order, or
// asking for unrelated things in between, never changes an answer. This is
// what makes every policy face the same world.
func TestWorldVariatesAreOrderIndependent(t *testing.T) {
	type key struct {
		task string
		idx  int
	}
	keys := []key{{"sim-a", 0}, {"sim-a", 1}, {"sim-b", 0}, {"sim-c", 7}, {"sim-trap", 3}, {"sim-a", 2}}
	forward := map[key]AttemptVariates{}
	w := NewWorld(42, 3)
	for _, k := range keys {
		forward[k] = w.Attempt(k.task, k.idx)
	}
	other := NewWorld(42, 3)
	for i := len(keys) - 1; i >= 0; i-- {
		// A policy that burns arbitrary extra randomness first must not matter.
		for j := 0; j < 5*i; j++ {
			other.U("noise", fmt.Sprint(j))
			other.Attempt("sim-unrelated", j)
		}
		if got := other.Attempt(keys[i].task, keys[i].idx); got != forward[keys[i]] {
			t.Fatalf("variates for %v depend on call order", keys[i])
		}
	}
	for _, k := range keys[1:] {
		if forward[k] == forward[keys[0]] {
			t.Fatalf("distinct keys %v and %v share variates", k, keys[0])
		}
	}
	for _, v := range []AttemptVariates{NewWorld(43, 3).Attempt("sim-a", 0), NewWorld(42, 4).Attempt("sim-a", 0)} {
		if v == forward[key{"sim-a", 0}] {
			t.Fatal("seed and run index must change the world")
		}
	}
	for _, v := range forward {
		for _, u := range []float64{v.Work, v.Success, v.Artifact, v.VerifySvc, v.ReviewSvc, v.ReviewAccept} {
			if u < 0 || u >= 1 {
				t.Fatalf("variate %v outside [0,1)", u)
			}
		}
	}
}

func TestPickCoversTheRangeAndStaysInside(t *testing.T) {
	r := Range{Min: 10, Max: 13}
	seen := map[int64]bool{}
	for i := 0; i < 400; i++ {
		v := pick(NewWorld(1, i).U("x"), r)
		if v < r.Min || v > r.Max {
			t.Fatalf("pick escaped the range: %d", v)
		}
		seen[v] = true
	}
	if len(seen) != 4 {
		t.Fatalf("all four values should occur: %v", seen)
	}
	if pick(0.9999999999999999, r) != 13 || pick(0, r) != 10 {
		t.Fatal("range edges wrong")
	}
}

// Two policies attempting the same (task, attempt index) face identical
// durations and outcome draws, whichever volunteer, time or order.
func TestPoliciesSeeIdenticalOutcomesForTheSameAttemptKey(t *testing.T) {
	type key struct {
		task string
		idx  int
	}
	for _, path := range fixtureNames(t) {
		sc, err := LoadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for run := 0; run < 8; run++ {
			world := NewWorld(21, run)
			seen := map[key]AttemptTrace{}
			sharedKeys := 0
			for _, spec := range allPolicies(t) {
				res := RunOnce(sc, spec, world, run)
				if res.WorldDigest != world.Digest(sc) {
					t.Fatalf("%s %s: digest differs", sc.ID, spec.ID)
				}
				for _, tr := range res.Trace {
					if tr.Vars != world.Attempt(tr.Task, tr.Index) {
						t.Fatalf("%s %s: %s#%d does not match the world", sc.ID, spec.ID, tr.Task, tr.Index)
					}
					k := key{tr.Task, tr.Index}
					if prev, ok := seen[k]; ok {
						sharedKeys++
						if prev != tr {
							t.Fatalf("%s: policies disagree on %v: %+v vs %+v", sc.ID, k, prev, tr)
						}
					}
					seen[k] = tr
				}
			}
			if sharedKeys == 0 {
				t.Fatalf("%s run %d: policies share no attempt key, comparison would be vacuous", sc.ID, run)
			}
		}
	}
}

// A policy's result must not depend on which other policies ran before it.
func TestPolicyResultIsIndependentOfCompanions(t *testing.T) {
	sc := loadFixture(t, "trap-branch")
	alone, err := Simulate(sc, Options{Seed: 5, Samples: 10, Policies: []PolicySpec{policy(t, "least-attempted")}})
	if err != nil {
		t.Fatal(err)
	}
	together, err := Simulate(sc, Options{Seed: 5, Samples: 10, Policies: allPolicies(t)})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(alone.Policies[0])
	b, _ := json.Marshal(together.Policies[3])
	if !bytes.Equal(a, b) {
		t.Fatal("least-attempted changed when run beside other policies")
	}
}

func TestEveryPolicyGetsTheSameProblemAndBudget(t *testing.T) {
	sc := loadFixture(t, "and-all-children")
	rep, err := Simulate(sc, Options{Seed: 9, Samples: 5, Policies: allPolicies(t)})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Budget.TotalAgentSec != sc.Budget.TotalAgentSec || rep.Scenario.ID != sc.ID || len(rep.Worlds) != 5 || len(rep.Policies) != 4 {
		t.Fatalf("report header: %+v", rep)
	}
	for _, p := range rep.Policies {
		if p.Samples != 5 || len(p.Runs) != 5 {
			t.Fatalf("%s sampled %d worlds", p.Policy, p.Samples)
		}
		for i, r := range p.Runs {
			if r.Sample != i {
				t.Fatalf("%s: run %d reported as sample %d", p.Policy, i, r.Sample)
			}
			if r.AgentSec > sc.Budget.TotalAgentSec {
				t.Fatalf("%s: budget exceeded", p.Policy)
			}
		}
	}
	seen := map[string]bool{}
	for _, w := range rep.Worlds {
		if seen[w.Digest] {
			t.Fatal("different samples must be different worlds")
		}
		seen[w.Digest] = true
	}
}

func TestRandomOutagesArePreSampledPerWorld(t *testing.T) {
	sc := loadFixture(t, "provider-outage")
	w := NewWorld(1, 0)
	a := w.RandomOutageWindows(0, sc.RandomOutages[0])
	b := NewWorld(1, 0).RandomOutageWindows(0, sc.RandomOutages[0])
	if len(a) != 1 || a[0] != b[0] {
		t.Fatalf("windows must be reproducible: %v %v", a, b)
	}
	if c := NewWorld(1, 1).RandomOutageWindows(0, sc.RandomOutages[0]); c[0] == a[0] {
		t.Log("two worlds drew the same window; acceptable but unlikely")
	}
	if a[0].Start < sc.RandomOutages[0].StartSec.Min || a[0].End <= a[0].Start {
		t.Fatalf("window outside the rule: %v", a[0])
	}
}
