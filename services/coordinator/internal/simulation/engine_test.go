package simulation

import (
	"bytes"
	"sort"
	"testing"
)

// auditRun checks the invariants every run must satisfy, whatever the policy.
func auditRun(t *testing.T, sc *Scenario, res *RunResult) {
	t.Helper()
	budget := sc.Budget.TotalAgentSec
	if res.AgentSec > budget || res.MaxCommittedSec > budget {
		t.Fatalf("budget %d exceeded: spent %d, peak committed %d", budget, res.AgentSec, res.MaxCommittedSec)
	}
	var total int64
	byAttempt := map[int][]LedgerEntry{}
	for _, e := range res.Ledger {
		if e.End < e.Start {
			t.Fatalf("negative interval %+v", e)
		}
		total += e.End - e.Start
		byAttempt[e.Attempt] = append(byAttempt[e.Attempt], e)
		if res.Solved && e.End > res.WallSec {
			t.Fatalf("compute after the root was solved: %+v, solved at %d", e, res.WallSec)
		}
	}
	if total != res.AgentSec {
		t.Fatalf("ledger sums to %d, report says %d agent seconds", total, res.AgentSec)
	}
	// One attempt is never computed by two slots at the same moment.
	for id, entries := range byAttempt {
		sort.Slice(entries, func(i, j int) bool { return entries[i].Start < entries[j].Start })
		for i := 1; i < len(entries); i++ {
			if entries[i].Start < entries[i-1].End {
				t.Fatalf("attempt %d computed twice at once: %+v and %+v", id, entries[i-1], entries[i])
			}
		}
	}
	// A volunteer never exceeds its slot count.
	slots := map[string]int{}
	for _, v := range sc.Volunteers {
		slots[v.ID] = v.Slots
	}
	for id, limit := range slots {
		if peak := peakConcurrency(res.Ledger, func(e LedgerEntry) bool { return e.Volunteer == id }); peak > limit {
			t.Fatalf("volunteer %s ran %d concurrent attempts, slots %d", id, peak, limit)
		}
	}
	failed := 0
	for _, n := range res.Failed {
		failed += n
	}
	if got := res.Useful + res.Duplicate + res.Superseded + res.Cancelled + failed; got != res.AttemptsStarted {
		t.Fatalf("attempt accounting: %d classified of %d started (%+v)", got, res.AttemptsStarted, res)
	}
}

func peakConcurrency(ledger []LedgerEntry, keep func(LedgerEntry) bool) int {
	type edge struct {
		at    int64
		delta int
	}
	var edges []edge
	for _, e := range ledger {
		if keep(e) && e.End > e.Start {
			edges = append(edges, edge{e.Start, 1}, edge{e.End, -1})
		}
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].at != edges[j].at {
			return edges[i].at < edges[j].at
		}
		return edges[i].delta < edges[j].delta // releases before acquisitions
	})
	peak, cur := 0, 0
	for _, e := range edges {
		cur += e.delta
		if cur > peak {
			peak = cur
		}
	}
	return peak
}

func TestInvariantsHoldForEveryFixtureAndPolicy(t *testing.T) {
	for _, path := range fixtureNames(t) {
		sc, err := LoadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, seed := range []int64{1, 99} {
			for run := 0; run < 12; run++ {
				for _, spec := range allPolicies(t) {
					res := RunOnce(sc, spec, NewWorld(seed, run), run)
					auditRun(t, sc, res)
				}
			}
		}
	}
}

func TestPolicyParallelismLimits(t *testing.T) {
	sc := loadFixture(t, "easy-or")
	wide := *sc
	wide.Volunteers = append([]Volunteer(nil), sc.Volunteers...)
	for i := range wide.Volunteers {
		wide.Volunteers[i].Slots = 4
	}
	for _, c := range []struct {
		policy string
		limit  int
	}{{"single", 1}, {"fixed:2", 2}, {"fixed:3", 3}} {
		for run := 0; run < 10; run++ {
			res := runPolicy(t, &wide, c.policy, 5, run)
			if peak := peakConcurrency(res.Ledger, func(LedgerEntry) bool { return true }); peak > c.limit {
				t.Fatalf("%s ran %d attempts at once", c.policy, peak)
			}
		}
	}
	if peak := peakConcurrency(runPolicy(t, &wide, "round-robin", 5, 0).Ledger, func(LedgerEntry) bool { return true }); peak < 2 {
		t.Fatal("round-robin should use the free slots")
	}
}

func twoLeafVolunteers() []obj {
	return []obj{volunteer("v1", "alpha", "prov-x", nil), volunteer("v2", "beta", "prov-y", nil), volunteer("v3", "gamma", "prov-z", nil)}
}

func TestANDNeedsAllChildren(t *testing.T) {
	build := func(pc float64) *Scenario {
		return miniScenario(t, "root", []obj{
			innerNode("root", "sim-root", "and", "a", "b", "c"),
			leafNode("a", "sim-a", 1, 100, 100, nil),
			leafNode("b", "sim-b", 1, 100, 100, nil),
			leafNode("c", "sim-c", pc, 100, 100, nil),
		}, twoLeafVolunteers(), 3000, nil)
	}
	solved := runPolicy(t, build(1), "round-robin", 1, 0)
	if !solved.Solved {
		t.Fatal("AND with every child solvable must be solved")
	}
	// Two of three children solve, the third never does: the root stays open.
	stuck := build(0)
	for _, id := range DefaultPolicies() {
		res := runPolicy(t, stuck, id, 1, 0)
		if res.Solved || res.Useful != 2 {
			t.Fatalf("%s: AND solved by %d children (solved=%v)", id, res.Useful, res.Solved)
		}
		if res.EndReason != "budget_exhausted" {
			t.Fatalf("%s: end reason %s", id, res.EndReason)
		}
		auditRun(t, stuck, res)
	}
}

func TestORNeedsOnlyOneChildAndClosesTheRest(t *testing.T) {
	sc := miniScenario(t, "root", []obj{
		innerNode("root", "sim-root", "or", "a", "b"),
		leafNode("a", "sim-a", 0, 100, 100, nil),
		leafNode("b", "sim-b", 1, 100, 100, nil),
	}, twoLeafVolunteers(), 3000, nil)
	for _, id := range DefaultPolicies() {
		res := runPolicy(t, sc, id, 1, 0)
		if !res.Solved || res.Useful != 1 {
			t.Fatalf("%s: OR not solved by its working child (%+v)", id, res)
		}
		auditRun(t, sc, res) // also proves no compute continues after the solve
	}
}

func TestUnsolvedRunsStayInTheReportWithoutFabricatedZeros(t *testing.T) {
	sc := miniScenario(t, "root", []obj{
		innerNode("root", "sim-root", "and", "a", "c"),
		leafNode("a", "sim-a", 1, 100, 100, nil),
		leafNode("c", "sim-c", 0, 100, 100, nil),
	}, twoLeafVolunteers(), 3000, nil)
	rep, err := Simulate(sc, Options{Seed: 3, Samples: 6, Policies: allPolicies(t)})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range rep.Policies {
		if p.Samples != 6 || len(p.Runs) != 6 || p.SolvedRuns != 0 || p.UnsolvedRuns != 6 {
			t.Fatalf("%s: unsolved runs dropped: %+v", p.Policy, p)
		}
		if !p.SolveRate.OK || p.SolveRate.V != 0 {
			t.Fatalf("%s: solve rate must be a measured 0, got %+v", p.Policy, p.SolveRate)
		}
		if p.AgentHoursPerSolved.OK || p.WallTimeSec.Mean.OK || p.WallTimeSec.Median.OK || p.WallTimeSec.Max.OK || p.WallTimeSec.Count != 0 {
			t.Fatalf("%s: per-solved metrics must be not_measured: %+v", p.Policy, p)
		}
		if p.AgentHoursTotal == 0 {
			t.Fatalf("%s: spend on unsolved runs must still be counted", p.Policy)
		}
		for _, r := range p.Runs {
			if r.WallTimeSec.OK || r.Solved || r.EndReason != "budget_exhausted" {
				t.Fatalf("%s: bad unsolved run %+v", p.Policy, r)
			}
		}
	}
	out, _ := rep.JSON()
	if !bytes.Contains(out, []byte(`"agent_hours_per_solved": "not_measured"`)) || !bytes.Contains(out, []byte(`"solve_rate": 0,`)) {
		t.Fatalf("JSON must show not_measured and a real zero rate:\n%s", out)
	}
}

func TestPartialSolveRatesAreExact(t *testing.T) {
	// c is solvable only by the "gamma" profile: the policy that never reaches
	// a gamma volunteer scores a measured 0, the one that does scores 1.
	sc := miniScenario(t, "c", []obj{
		leafNode("c", "sim-c", 0, 100, 100, obj{"profiles": obj{"default": obj{"success_probability": 0}, "gamma": obj{"success_probability": 1}}}),
	}, []obj{volunteer("v1", "alpha", "prov-x", nil), volunteer("v2", "gamma", "prov-z", nil)}, 3000, nil)
	rep, err := Simulate(sc, Options{Seed: 1, Samples: 4, Policies: allPolicies(t)})
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]PolicyReport{}
	for _, p := range rep.Policies {
		by[p.Policy] = p
	}
	if p := by["single"]; p.SolvedRuns != 0 || p.SolveRate.V != 0 || p.AgentHoursPerSolved.OK {
		t.Fatalf("single only ever uses alpha: %+v", p)
	}
	if p := by["round-robin"]; p.SolvedRuns != 4 || p.SolveRate.V != 1 || !p.AgentHoursPerSolved.OK {
		t.Fatalf("round-robin reaches gamma: %+v", p)
	}
}

func TestBudgetIsNeverExceeded(t *testing.T) {
	for _, budget := range []int64{600, 1000, 1700, 2500} {
		sc := miniScenario(t, "root", []obj{
			innerNode("root", "sim-root", "and", "a", "b"),
			leafNode("a", "sim-a", 0.15, 200, 590, nil),
			leafNode("b", "sim-b", 0.15, 200, 590, nil),
		}, append(twoLeafVolunteers(), volunteer("v4", "delta", "prov-x", obj{"slots": 3})), budget, nil)
		for run := 0; run < 25; run++ {
			for _, spec := range allPolicies(t) {
				res := RunOnce(sc, spec, NewWorld(8, run), run)
				auditRun(t, sc, res)
				if res.MaxCommittedSec > budget {
					t.Fatalf("budget %d: committed %d", budget, res.MaxCommittedSec)
				}
			}
		}
	}
	// Below one reservation (time limit 600) nothing may start.
	sc := miniScenario(t, "a", []obj{leafNode("a", "sim-a", 1, 100, 100, nil)}, twoLeafVolunteers(), 599, nil)
	res := runPolicy(t, sc, "fixed:3", 1, 0)
	if res.AttemptsStarted != 0 || res.Solved || res.AgentSec != 0 || res.EndReason != "budget_exhausted" {
		t.Fatalf("an unaffordable attempt must not start: %+v", res)
	}
}

func TestHandoffContinuesWithoutDoubleCompute(t *testing.T) {
	// seq: exclusive software task, 500 s of work, checkpoints every 120 s.
	// v1 leaves after exactly 250 s: two checkpoints (240 s) survive, 10 s are
	// lost; v2 resumes after a 30 s handoff overhead and needs 260 s more.
	sc := miniScenario(t, "seq", []obj{leafNode("seq", "sim-seq", 1, 500, 500, nil)}, []obj{
		volunteer("v1", "alpha", "prov-x", obj{"online_sec": obj{"min": 250, "max": 250}}),
		volunteer("v2", "beta", "prov-y", nil),
	}, 5000, obj{"handoff": obj{"overhead_sec": 30}})
	for _, id := range DefaultPolicies() {
		res := runPolicy(t, sc, id, 1, 0)
		auditRun(t, sc, res)
		if !res.Solved || res.AttemptsStarted != 1 || res.Handoffs != 1 {
			t.Fatalf("%s: expected one attempt with one handoff: %+v", id, res)
		}
		if res.AgentSec != 250+290 || res.HandoffLostSec != 10 || res.HandoffOverhead != 30 {
			t.Fatalf("%s: compute must be work 500 + lost 10 + overhead 30 exactly once, got %d (lost %d, overhead %d)", id, res.AgentSec, res.HandoffLostSec, res.HandoffOverhead)
		}
		if len(res.Ledger) != 2 || res.Ledger[0].End != res.Ledger[1].Start || res.Ledger[0].Volunteer == res.Ledger[1].Volunteer {
			t.Fatalf("%s: segments must be back to back on two volunteers: %+v", id, res.Ledger)
		}
		if res.WallSec != 542 { // 540 + 1 s verification + 1 s review
			t.Fatalf("%s: wall %d", id, res.WallSec)
		}
	}
}

func TestWithoutHandoffAnInterruptedAttemptFails(t *testing.T) {
	sc := miniScenario(t, "nohandoff", []obj{leafNode("nohandoff", "sim-nohandoff", 1, 300, 300, nil)},
		[]obj{volunteer("v1", "alpha", "prov-x", nil)}, 5000,
		obj{"outages": []obj{{"provider": "prov-x", "start_sec": 100, "end_sec": 200}}})
	res := runPolicy(t, sc, "single", 1, 0)
	auditRun(t, sc, res)
	if !res.Solved || res.Failed[FailOutage] != 1 || res.AttemptsStarted != 2 || res.Handoffs != 0 {
		t.Fatalf("outage must kill the handoff-less attempt and a new one must finish: %+v", res)
	}
	if res.AgentSec != 100+300 || res.WallSec != 501 {
		t.Fatalf("spent %d wall %d", res.AgentSec, res.WallSec)
	}
	for _, e := range res.Ledger {
		if e.Start > 100 && e.Start < 200 {
			t.Fatalf("no work may start during the outage: %+v", e)
		}
	}
}

func TestOutageResumesHandoffTaskOnAnotherProvider(t *testing.T) {
	sc := miniScenario(t, "a", []obj{leafNode("a", "sim-a", 1, 400, 400, nil)}, []obj{
		volunteer("v1", "alpha", "prov-x", nil), volunteer("v2", "beta", "prov-y", nil),
	}, 5000, obj{"outages": []obj{{"provider": "prov-x", "start_sec": 250, "end_sec": 5000}}, "handoff": obj{"overhead_sec": 20}})
	res := runPolicy(t, sc, "single", 1, 0)
	auditRun(t, sc, res)
	// 250 s on v1: two checkpoints (240 s) survive; v2 continues 160 s + 20 s.
	if !res.Solved || res.Handoffs != 1 || res.AgentSec != 250+180 || res.HandoffLostSec != 10 {
		t.Fatalf("outage handoff: %+v", res)
	}
}

func TestDuplicateArtifactCountsOnce(t *testing.T) {
	sc := miniScenario(t, "a", []obj{leafNode("a", "sim-a", 1, 150, 150, obj{"artifact_variants": 1})},
		twoLeafVolunteers(), 4000,
		obj{"verification": obj{"workers": 1, "duration_sec": obj{"min": 200, "max": 200}}})
	res := runPolicy(t, sc, "fixed:3", 1, 0)
	auditRun(t, sc, res)
	if !res.Solved || res.AttemptsStarted != 3 || res.CandidatesSubmitted != 1 || res.Useful != 1 || res.Duplicate != 2 {
		t.Fatalf("three identical artifacts must yield one useful result: %+v", res)
	}
	if res.WallSec != 350 || res.AgentSec != 450 {
		t.Fatalf("wall %d agent %d", res.WallSec, res.AgentSec)
	}
}

func TestDuplicateOfARejectedArtifactIsNotReverified(t *testing.T) {
	sc := miniScenario(t, "a", []obj{leafNode("a", "sim-a", 1, 150, 150, obj{"artifact_variants": 1, "verification_pass_probability": 0})},
		twoLeafVolunteers(), 4000, nil)
	res := runPolicy(t, sc, "single", 1, 0)
	if res.Solved || res.Useful != 0 || res.CandidatesSubmitted != 1 || res.Failed[FailVerification] != 1 || res.Duplicate != res.AttemptsStarted-1 {
		t.Fatalf("the same bad artifact must be rejected once and then only counted as duplicate: %+v", res)
	}
}

func TestSharedProfileFailureIsCorrelated(t *testing.T) {
	flawed := obj{"profiles": obj{"default": obj{"success_probability": 1}, "alpha": obj{"success_probability": 1, "flaw_probability": 1}}}
	sc := miniScenario(t, "a", []obj{leafNode("a", "sim-a", 1, 100, 100, flawed)},
		[]obj{volunteer("v1-alpha", "alpha", "prov-x", nil), volunteer("v2-beta", "beta", "prov-y", nil)}, 3000, nil)
	single := runPolicy(t, sc, "single", 1, 0)
	if single.Solved || single.SharedFailures != single.AttemptsStarted || single.SharedGroups != 1 || single.Failed[FailSharedFlaw] != single.AttemptsStarted {
		t.Fatalf("every alpha attempt shares one flaw: %+v", single)
	}
	diverse := runPolicy(t, sc, "round-robin", 1, 0)
	if !diverse.Solved || diverse.SharedFailures == 0 {
		t.Fatalf("a second profile escapes the shared flaw: %+v", diverse)
	}
}

func TestDependenciesGateTheStart(t *testing.T) {
	sc := miniScenario(t, "root", []obj{
		innerNode("root", "sim-root", "and", "a", "dep"),
		leafNode("a", "sim-a", 1, 100, 100, nil),
		leafNode("dep", "sim-dep", 1, 100, 100, nil),
	}, twoLeafVolunteers(), 5000, nil)
	res := runPolicy(t, sc, "fixed:3", 1, 0)
	auditRun(t, sc, res)
	start := int64(-1)
	for _, e := range res.Ledger {
		if e.Task == "sim-dep" && (start < 0 || e.Start < start) {
			start = e.Start
		}
	}
	if !res.Solved || start != 101 || res.WallSec != 202 { // a verified at 101, dep needs 100 + 1
		t.Fatalf("sim-dep must wait for sim-a: dep started %d, wall %d (%+v)", start, res.WallSec, res)
	}
}

func TestVerificationQueueWaits(t *testing.T) {
	sc := miniScenario(t, "root", []obj{
		innerNode("root", "sim-root", "and", "a", "b", "c"),
		leafNode("a", "sim-a", 1, 100, 100, nil),
		leafNode("b", "sim-b", 1, 100, 100, nil),
		leafNode("c", "sim-c", 1, 100, 100, nil),
	}, twoLeafVolunteers(), 5000, obj{"verification": obj{"workers": 1, "duration_sec": obj{"min": 50, "max": 50}}})
	res := runPolicy(t, sc, "round-robin", 1, 0)
	if res.VerifyWait != (stat{Count: 3, Sum: 150, Max: 100}) || res.WallSec != 250 {
		t.Fatalf("verification waits 0/50/100 expected: %+v wall %d", res.VerifyWait, res.WallSec)
	}
	if res.ReviewWait.Count != 0 {
		t.Fatal("auto-review contracts must skip the review queue")
	}
}

func TestReviewQueueWaits(t *testing.T) {
	sc := miniScenario(t, "root", []obj{
		innerNode("root", "sim-root", "and", "ma", "mb"),
		leafNode("ma", "sim-ma", 1, 100, 100, nil),
		leafNode("mb", "sim-mb", 1, 100, 100, nil),
	}, twoLeafVolunteers(), 5000, obj{
		"verification": obj{"workers": 2, "duration_sec": obj{"min": 10, "max": 10}},
		"review":       obj{"reviewers": 1, "duration_sec": obj{"min": 100, "max": 100}},
	})
	res := runPolicy(t, sc, "round-robin", 1, 0)
	if res.ReviewWait != (stat{Count: 2, Sum: 100, Max: 100}) || res.WallSec != 310 {
		t.Fatalf("review waits 0/100 expected: %+v wall %d", res.ReviewWait, res.WallSec)
	}
}

func TestReviewRejectionReopensTheLeaf(t *testing.T) {
	sc := miniScenario(t, "ma", []obj{leafNode("ma", "sim-ma", 1, 100, 100, nil)}, twoLeafVolunteers(), 6000,
		obj{"review": obj{"accept_probability": 0.5}})
	var rejected, solved bool
	for run := 0; run < 40; run++ {
		res := runPolicy(t, sc, "single", 4, run)
		auditRun(t, sc, res)
		if res.Failed[FailReview] > 0 && res.Solved {
			rejected, solved = true, true
		}
	}
	if !rejected || !solved {
		t.Fatal("some run must be reviewed, rejected, retried and finally accepted")
	}
}

func TestTimeLimitWithoutHandoffTimesOut(t *testing.T) {
	// sim-nohandoff has a 600 s limit and no handoff: 700 s of work can never finish.
	sc := miniScenario(t, "nohandoff", []obj{leafNode("nohandoff", "sim-nohandoff", 1, 700, 700, nil)}, twoLeafVolunteers(), 4000, nil)
	res := runPolicy(t, sc, "single", 1, 0)
	if res.Solved || res.Failed[FailTimeout] == 0 {
		t.Fatalf("expected timeouts: %+v", res)
	}
}

func TestAcceptedLeafStopsCompetingWorkBeforeANDSiblingsFinish(t *testing.T) {
	sc := miniScenario(t, "root", []obj{
		innerNode("root", "sim-root", "and", "a", "b"),
		leafNode("a", "sim-a", 1, 100, 590, nil),
		leafNode("b", "sim-b", 1, 500, 500, nil),
	}, twoLeafVolunteers(), 3000, nil)
	var seed int64
	var acceptedAt int64
	for seed = 1; seed < 100; seed++ {
		world := NewWorld(seed, 0)
		first := pick(world.Attempt("sim-a", 0).Work, Range{100, 590})
		second := pick(world.Attempt("sim-a", 1).Work, Range{100, 590})
		if first < 400 && second > first+1 {
			acceptedAt = first + 1
			break
		}
	}
	if acceptedAt == 0 {
		t.Fatal("no world with a pending competing attempt found")
	}
	res := runPolicy(t, sc, "round-robin", seed, 0)
	auditRun(t, sc, res)
	if !res.Solved || res.WallSec != 501 || res.Cancelled < 1 || res.Useful != 2 {
		t.Fatalf("expected a cancelled competitor while b completes: %+v", res)
	}
	for _, entry := range res.Ledger {
		if entry.Task == "sim-a" && entry.End > acceptedAt {
			t.Fatalf("accepted leaf consumed compute after %d: %+v", acceptedAt, entry)
		}
	}
}

func TestExecutionBudgetIsSharedAcrossRuns(t *testing.T) {
	budget := &executionBudget{events: maxSimulationEvents - 1}
	first := &runState{execution: budget}
	first.push(&event{at: 1})
	second := &runState{execution: budget}
	defer func() {
		if _, ok := recover().(executionLimitError); !ok {
			t.Fatal("second run must share the exhausted execution allowance")
		}
	}()
	second.push(&event{at: 1})
}
