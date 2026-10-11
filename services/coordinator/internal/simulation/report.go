package simulation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

const (
	ReportFormat  = "commongrid.simulation.report"
	ReportVersion = "1.0"

	// NotMeasured marks a metric whose definition has no data (for example
	// agent-hours per solved problem when nothing was solved). It is never
	// replaced by a fabricated zero.
	NotMeasured = "not_measured"

	Disclaimer = "Synthetic simulation of scheduling policies. It does not measure real model success or efficiency, real volunteer behaviour or real cost, and it is not product acceptance."
)

// Num is a float rendered with fixed precision (6 decimals, trailing zeros
// trimmed) so identical inputs give byte-identical JSON.
type Num float64

func formatNum(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		panic("non-finite metric")
	}
	s := strconv.FormatFloat(v, 'f', 6, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if s == "-0" || s == "" {
		s = "0"
	}
	return s
}

func (n Num) MarshalJSON() ([]byte, error) { return []byte(formatNum(float64(n))), nil }

// Value is a metric that may be undefined; undefined renders "not_measured".
type Value struct {
	V  float64
	OK bool
}

func measured(v float64) Value { return Value{V: v, OK: true} }

func ratio(num, den int64) Value {
	if den == 0 {
		return Value{}
	}
	return measured(float64(num) / float64(den))
}

func (v Value) MarshalJSON() ([]byte, error) {
	if !v.OK {
		return []byte(`"` + NotMeasured + `"`), nil
	}
	return []byte(formatNum(v.V)), nil
}

type Report struct {
	Format        string         `json:"format"`
	ReportVersion string         `json:"report_version"`
	Disclaimer    string         `json:"disclaimer"`
	Seed          int64          `json:"seed"`
	Scenario      ScenarioInfo   `json:"scenario"`
	Budget        BudgetInfo     `json:"budget"`
	Samples       int            `json:"samples"`
	Worlds        []WorldInfo    `json:"worlds"`
	Policies      []PolicyReport `json:"policies"`
}

type ScenarioInfo struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	FormatVersion string `json:"format_version"`
	SHA256        string `json:"sha256"`
	Nodes         int    `json:"nodes"`
	Leaves        int    `json:"leaves"`
	Volunteers    int    `json:"volunteers"`
}

type BudgetInfo struct {
	TotalAgentSec   int64 `json:"total_agent_sec"`
	TotalAgentHours Num   `json:"total_agent_hours"`
}

// WorldInfo proves every policy of a sample faced one pre-sampled world.
type WorldInfo struct {
	Sample int    `json:"sample"`
	Digest string `json:"digest"`
}

type PolicyReport struct {
	Policy              string         `json:"policy"`
	Samples             int            `json:"samples"`
	SolvedRuns          int            `json:"solved_runs"`
	UnsolvedRuns        int            `json:"unsolved_runs"`
	SolveRate           Value          `json:"solve_rate"`
	EndReasons          map[string]int `json:"end_reasons"`
	AgentHoursTotal     Num            `json:"agent_hours_total"`
	AgentHoursPerSolved Value          `json:"agent_hours_per_solved"`
	WallTimeSec         Summary        `json:"wall_time_sec_solved_runs"`
	Attempts            AttemptReport  `json:"attempts"`
	Queues              QueueReport    `json:"queues"`
	Correlation         Correlation    `json:"correlation"`
	Handoff             HandoffReport  `json:"handoff"`
	Runs                []RunReport    `json:"runs"`
}

type Summary struct {
	Count  int   `json:"count"`
	Mean   Value `json:"mean"`
	Median Value `json:"median"`
	Max    Value `json:"max"`
}

type AttemptReport struct {
	Started          int            `json:"started"`
	Failed           int            `json:"failed"`
	FailedByReason   map[string]int `json:"failed_by_reason"`
	FailedRate       Value          `json:"failed_rate"`
	Useful           int            `json:"useful"`
	Duplicate        int            `json:"duplicate"`
	Superseded       int            `json:"superseded"`
	Cancelled        int            `json:"cancelled"`
	CandidatesQueued int            `json:"candidates_submitted"`
}

type Wait struct {
	Count int   `json:"count"`
	Mean  Value `json:"mean"`
	Max   Value `json:"max"`
}

type QueueReport struct {
	VerificationWaitSec Wait `json:"verification_wait_sec"`
	ReviewWaitSec       Wait `json:"review_wait_sec"`
	ResumeWaitSec       Wait `json:"resume_wait_sec"`
}

type Correlation struct {
	SharedProfileFailures int `json:"shared_profile_failures"`
	SharedFailureGroups   int `json:"shared_failure_groups"`
	DuplicateArtifacts    int `json:"duplicate_artifacts"`
}

type HandoffReport struct {
	Resumes     int   `json:"resumes"`
	LostWorkSec int64 `json:"lost_work_sec"`
	OverheadSec int64 `json:"overhead_sec"`
}

type RunReport struct {
	Sample           int    `json:"sample"`
	Solved           bool   `json:"solved"`
	EndReason        string `json:"end_reason"`
	WallTimeSec      Value  `json:"wall_time_sec"`
	AgentSec         int64  `json:"agent_sec"`
	MaxCommittedSec  int64  `json:"max_committed_agent_sec"`
	AttemptsStarted  int    `json:"attempts_started"`
	FailedAttempts   int    `json:"failed_attempts"`
	UsefulResults    int    `json:"useful_results"`
	DuplicateResults int    `json:"duplicate_artifacts"`
}

// Options select the sampled worlds and the policies compared on them.
type Options struct {
	Seed     int64
	Samples  int // 0 uses the scenario's recommended_samples
	Policies []PolicySpec
}

// Simulate runs every policy on the same pre-sampled worlds, one world per
// sample index, and aggregates the report. Unsolved runs stay in the report.
func Simulate(sc *Scenario, opts Options) (rep *Report, err error) {
	defer func() {
		if p := recover(); p != nil {
			if limit, ok := p.(executionLimitError); ok {
				rep, err = nil, limit
			} else {
				rep, err = nil, fmt.Errorf("simulation invariant violated: %v", p)
			}
		}
	}()
	samples := opts.Samples
	if samples == 0 {
		samples = sc.RecommendedSamples
	}
	if samples < 1 || samples > maxSamples {
		return nil, fmt.Errorf("samples must be 1..%d", maxSamples)
	}
	if len(opts.Policies) == 0 {
		return nil, fmt.Errorf("at least one policy is required")
	}
	leaves := 0
	for _, n := range sc.Nodes {
		if n.Relation == "leaf" {
			leaves++
		}
	}
	rep = &Report{
		Format:        ReportFormat,
		ReportVersion: ReportVersion,
		Disclaimer:    Disclaimer,
		Seed:          opts.Seed,
		Scenario: ScenarioInfo{ID: sc.ID, Title: sc.Title, FormatVersion: sc.FormatVersion, SHA256: sc.SourceSHA256,
			Nodes: len(sc.Nodes), Leaves: leaves, Volunteers: len(sc.Volunteers)},
		Budget:  BudgetInfo{TotalAgentSec: sc.Budget.TotalAgentSec, TotalAgentHours: Num(float64(sc.Budget.TotalAgentSec) / 3600)},
		Samples: samples,
	}
	results := make([][]*RunResult, len(opts.Policies))
	execution := &executionBudget{}
	for i := 0; i < samples; i++ {
		world := NewWorld(opts.Seed, i)
		digest := world.Digest(sc)
		rep.Worlds = append(rep.Worlds, WorldInfo{Sample: i, Digest: digest})
		for p, spec := range opts.Policies {
			res := runOnce(sc, spec, world, i, execution)
			if res.WorldDigest != digest {
				return nil, fmt.Errorf("policy %s saw a different world in sample %d", spec.ID, i)
			}
			if res.MaxCommittedSec > sc.Budget.TotalAgentSec || res.AgentSec > sc.Budget.TotalAgentSec {
				return nil, fmt.Errorf("policy %s exceeded the budget in sample %d", spec.ID, i)
			}
			results[p] = append(results[p], res)
		}
	}
	for p, spec := range opts.Policies {
		rep.Policies = append(rep.Policies, aggregate(spec.ID, results[p]))
	}
	return rep, nil
}

func aggregate(id string, runs []*RunResult) PolicyReport {
	pr := PolicyReport{Policy: id, Samples: len(runs), EndReasons: map[string]int{}}
	pr.Attempts.FailedByReason = map[string]int{}
	for _, reason := range failureReasons {
		pr.Attempts.FailedByReason[reason] = 0
	}
	var agentSec, ver, rev, res stat
	var walls []int64
	for _, r := range runs {
		failed := 0
		for reason, n := range r.Failed {
			pr.Attempts.FailedByReason[reason] += n
			failed += n
		}
		pr.Attempts.Failed += failed
		pr.EndReasons[r.EndReason]++
		if r.Solved {
			pr.SolvedRuns++
			walls = append(walls, r.WallSec)
		}
		agentSec.Sum += r.AgentSec
		a := &pr.Attempts
		a.Started += r.AttemptsStarted
		a.Useful += r.Useful
		a.Duplicate += r.Duplicate
		a.Superseded += r.Superseded
		a.Cancelled += r.Cancelled
		a.CandidatesQueued += r.CandidatesSubmitted
		merge(&ver, r.VerifyWait)
		merge(&rev, r.ReviewWait)
		merge(&res, r.ResumeWait)
		pr.Correlation.SharedProfileFailures += r.SharedFailures
		pr.Correlation.SharedFailureGroups += r.SharedGroups
		pr.Correlation.DuplicateArtifacts += r.Duplicate
		pr.Handoff.Resumes += r.Handoffs
		pr.Handoff.LostWorkSec += r.HandoffLostSec
		pr.Handoff.OverheadSec += r.HandoffOverhead
		wall := Value{}
		if r.Solved {
			wall = measured(float64(r.WallSec))
		}
		pr.Runs = append(pr.Runs, RunReport{
			Sample: r.Run, Solved: r.Solved, EndReason: r.EndReason, WallTimeSec: wall,
			AgentSec: r.AgentSec, MaxCommittedSec: r.MaxCommittedSec, AttemptsStarted: r.AttemptsStarted,
			FailedAttempts: failed, UsefulResults: r.Useful, DuplicateResults: r.Duplicate,
		})
	}
	pr.UnsolvedRuns = pr.Samples - pr.SolvedRuns
	pr.SolveRate = ratio(int64(pr.SolvedRuns), int64(pr.Samples))
	pr.AgentHoursTotal = Num(float64(agentSec.Sum) / 3600)
	if pr.SolvedRuns > 0 {
		// Spend of unsolved runs counts: abandoning failures must not look free.
		pr.AgentHoursPerSolved = measured(float64(agentSec.Sum) / 3600 / float64(pr.SolvedRuns))
	}
	pr.WallTimeSec = summarize(walls)
	pr.Attempts.FailedRate = ratio(int64(pr.Attempts.Failed), int64(pr.Attempts.Started-pr.Attempts.Cancelled))
	pr.Queues = QueueReport{waitOf(ver), waitOf(rev), waitOf(res)}
	return pr
}

func merge(dst *stat, src stat) {
	dst.Count += src.Count
	dst.Sum += src.Sum
	if src.Max > dst.Max {
		dst.Max = src.Max
	}
}

func waitOf(s stat) Wait {
	if s.Count == 0 {
		return Wait{}
	}
	return Wait{Count: int(s.Count), Mean: measured(float64(s.Sum) / float64(s.Count)), Max: measured(float64(s.Max))}
}

func summarize(v []int64) Summary {
	if len(v) == 0 {
		return Summary{}
	}
	sorted := append([]int64(nil), v...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	var sum int64
	for _, x := range sorted {
		sum += x
	}
	n := len(sorted)
	median := float64(sorted[n/2])
	if n%2 == 0 {
		median = float64(sorted[n/2-1]+sorted[n/2]) / 2
	}
	return Summary{Count: n, Mean: measured(float64(sum) / float64(n)), Median: measured(median), Max: measured(float64(sorted[n-1]))}
}

// JSON renders the report deterministically: struct field order, sorted map
// keys and fixed float formatting.
func (r *Report) JSON() ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(r); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
