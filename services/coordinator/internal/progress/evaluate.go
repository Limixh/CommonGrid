// Package progress computes milestone progress and regressions for one task
// contract (PROJECT_SPEC1.2.md section 11.2). It is a pure calculation core:
// no shell, network, model, clock, randomness or storage. It does not run
// checkers, verify who produced a result, or read Lean dependency evidence;
// callers pass results that a trusted checker already produced, and the
// package only checks that they belong to the same task contract and
// processes them. Nothing here grants scores, acceptance or server authority.
package progress

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"

	"commongrid/coordinator/internal/contract"
)

// Status is a checker verdict for one milestone. StatusNotMeasured is
// output-only: absence of a result means "not measured", and callers cannot
// submit it as a result.
type Status string

const (
	StatusPass        Status = "pass"
	StatusFail        Status = "fail"
	StatusBlocked     Status = "blocked" // depends on an unresolved proof; never counts as pass
	StatusNotMeasured Status = "not_measured"
)

// Change describes one milestone relative to the previous measurement.
type Change string

const (
	ChangeNone        Change = ""            // no previous measurement
	ChangeUnchanged   Change = "unchanged"   // pass state did not change
	ChangeGained      Change = "gained"      // not pass -> pass
	ChangeRegressed   Change = "regressed"   // pass -> fail or blocked
	ChangeUnconfirmed Change = "unconfirmed" // pass -> not measured; not proven broken
)

// Limit names a reason the progress figure must be shown as limited.
type Limit string

const (
	// LimitNoMilestones: the contract defines no milestones. Progress is not
	// available; this is neither a finished task nor 100% success.
	LimitNoMilestones Limit = "no_milestones_defined"
	// LimitUnmeasured: at least one defined milestone has no result.
	LimitUnmeasured Limit = "milestones_not_measured"
	// LimitWeightBelowOne: defined weights sum to less than 1 and are not
	// re-normalized, so progress cannot reach 1.
	LimitWeightBelowOne Limit = "defined_weight_below_one"
)

// Rejection kinds, matched with errors.Is on the returned error.
var (
	ErrInvalidContract    = errors.New("progress: invalid contract milestones")
	ErrInvalidMeasurement = errors.New("progress: malformed measurement")
	ErrContextMismatch    = errors.New("progress: measurement context does not match contract")
	ErrUnknownMilestone   = errors.New("progress: unknown milestone")
	ErrDuplicateMilestone = errors.New("progress: duplicate milestone")
	ErrInvalidStatus      = errors.New("progress: invalid milestone status")
)

// RejectionError is the typed error returned for every rejected input.
// errors.Is(err, ErrXxx) selects the kind; Source is "contract", "current"
// or "previous".
type RejectionError struct {
	Kind        error
	Source      string
	MilestoneID string
	Detail      string
}

func (e *RejectionError) Error() string {
	text := e.Kind.Error() + " (" + e.Source + ")"
	if e.MilestoneID != "" {
		text += fmt.Sprintf(" milestone=%q", clip(e.MilestoneID))
	}
	if e.Detail != "" {
		text += ": " + e.Detail
	}
	return text
}

func (e *RejectionError) Unwrap() error { return e.Kind }

func reject(kind error, source, id, detail string) error {
	return &RejectionError{Kind: kind, Source: source, MilestoneID: id, Detail: detail}
}

func clip(s string) string {
	if r := []rune(s); len(r) > 100 {
		return string(r[:100]) + "..."
	}
	return s
}

// Context binds a measurement to one task contract and one artifact.
type Context struct {
	TaskID         string
	TaskVersion    int64
	ContractHash   string
	BaseCommit     string
	ArtifactSHA256 string
}

// Result is one checker verdict for a milestone defined in the contract.
type Result struct {
	MilestoneID string
	Status      Status
}

// Measurement is the set of results a trusted checker produced for a single
// artifact. Callers build one Measurement per artifact; results of different
// artifacts cannot be mixed in one. Result order is irrelevant.
type Measurement struct {
	Context Context
	Results []Result
}

// Input is the complete evaluation input. Contract must already have passed
// contract.Validator; only the fields this package relies on are re-checked.
// Previous is optional and may come from a different artifact of the same
// task contract.
type Input struct {
	Contract contract.TaskContract
	Current  Measurement
	Previous *Measurement
}

// MilestoneState is the evaluated state of one contract milestone.
type MilestoneState struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Weight         float64 `json:"weight"`
	Critical       bool    `json:"critical"`
	Status         Status  `json:"status"`
	PreviousStatus Status  `json:"previous_status,omitempty"`
	Change         Change  `json:"change,omitempty"`
}

// Report is the deterministic evaluation output. All milestone lists follow
// contract order and are never nil.
type Report struct {
	TaskID       string `json:"task_id"`
	TaskVersion  int64  `json:"task_version"`
	ContractHash string `json:"contract_hash"`
	BaseCommit   string `json:"base_commit"`
	// Artifact contexts are kept apart: the current and previous measurement
	// may be about different artifacts.
	ArtifactSHA256         string `json:"artifact_sha256"`
	HasPrevious            bool   `json:"has_previous"`
	PreviousArtifactSHA256 string `json:"previous_artifact_sha256,omitempty"`

	Milestones []MilestoneState `json:"milestones"`

	// TotalWeight is the sum of defined weights, not re-normalized.
	TotalWeight float64 `json:"total_weight"`
	// PassedWeight is the exact sum of weights of passing milestones.
	PassedWeight         float64 `json:"passed_weight"`
	PreviousPassedWeight float64 `json:"previous_passed_weight,omitempty"`
	// Progress is the value to show: PassedWeight, at most 0.5 while a
	// critical milestone is unresolved. It is 0 and meaningless when
	// ProgressAvailable is false.
	Progress          float64 `json:"progress"`
	ProgressAvailable bool    `json:"progress_available"`
	// CriticalCapApplied is true only when the 0.5 cap lowered Progress.
	CriticalCapApplied bool `json:"critical_cap_applied"`
	// CriticalBlockers lists critical milestones that are not passing
	// (fail, blocked or not measured).
	CriticalBlockers []string `json:"critical_blockers"`

	Gained      []string `json:"gained"`
	Regressed   []string `json:"regressed"`
	Unconfirmed []string `json:"unconfirmed"`
	Unmeasured  []string `json:"unmeasured"`
	Limits      []Limit  `json:"limits"`
}

// weightTolerance is the same bound contract/validate.go applies to the sum
// of milestone weights (total > 1+1e-12 is rejected there). The check below
// repeats that exact float64 computation, in contract order, so both accept
// and reject the same sets.
const weightTolerance = 1e-12

// criticalCap is the spec cap (section 11.2) while a critical milestone is
// unresolved.
var criticalCap = big.NewRat(1, 2)

var (
	hashPattern   = regexp.MustCompile(`^[a-f0-9]{64}$`)
	commitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
	idPattern     = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$`)
)

// Evaluate computes milestone states, passed weight, displayed progress,
// critical blockers and gained/regressed milestones. The result depends only
// on the contract and on the set of results, never on their order. The
// weight sums are exact (big.Rat over the float64 values) and rounded once
// to the nearest float64.
func Evaluate(in Input) (Report, error) {
	ms := in.Contract.Progress.Milestones
	if err := checkContract(in.Contract); err != nil {
		return Report{}, err
	}
	current, err := index("current", in.Contract, in.Current)
	if err != nil {
		return Report{}, err
	}
	var previous map[string]Status
	if in.Previous != nil {
		if previous, err = index("previous", in.Contract, *in.Previous); err != nil {
			return Report{}, err
		}
	}

	report := Report{
		TaskID:           in.Contract.Id,
		TaskVersion:      in.Contract.TaskVersion,
		ContractHash:     in.Contract.ContractHash,
		BaseCommit:       in.Contract.Workspace.Commit,
		ArtifactSHA256:   in.Current.Context.ArtifactSHA256,
		HasPrevious:      in.Previous != nil,
		Milestones:       make([]MilestoneState, 0, len(ms)),
		CriticalBlockers: []string{},
		Gained:           []string{},
		Regressed:        []string{},
		Unconfirmed:      []string{},
		Unmeasured:       []string{},
		Limits:           []Limit{},
	}
	if in.Previous != nil {
		report.PreviousArtifactSHA256 = in.Previous.Context.ArtifactSHA256
	}

	total, passed, previousPassed := new(big.Rat), new(big.Rat), new(big.Rat)
	criticalUnresolved := false
	for _, m := range ms {
		weight := new(big.Rat).SetFloat64(m.Weight)
		total.Add(total, weight)
		state := MilestoneState{ID: m.Id, Name: m.Name, Weight: m.Weight, Critical: m.Critical, Status: lookup(current, m.Id)}
		if state.Status == StatusPass {
			passed.Add(passed, weight)
		} else {
			if m.Critical {
				criticalUnresolved = true
				report.CriticalBlockers = append(report.CriticalBlockers, m.Id)
			}
			if state.Status == StatusNotMeasured {
				report.Unmeasured = append(report.Unmeasured, m.Id)
			}
		}
		if in.Previous != nil {
			state.PreviousStatus = lookup(previous, m.Id)
			wasPass, isPass := state.PreviousStatus == StatusPass, state.Status == StatusPass
			if wasPass {
				previousPassed.Add(previousPassed, weight)
			}
			switch {
			case !wasPass && isPass:
				state.Change = ChangeGained
				report.Gained = append(report.Gained, m.Id)
			case wasPass && !isPass && state.Status == StatusNotMeasured:
				state.Change = ChangeUnconfirmed
				report.Unconfirmed = append(report.Unconfirmed, m.Id)
			case wasPass && !isPass:
				state.Change = ChangeRegressed
				report.Regressed = append(report.Regressed, m.Id)
			default:
				state.Change = ChangeUnchanged
			}
		}
		report.Milestones = append(report.Milestones, state)
	}

	// The contract tolerates a total up to 1+1e-12; shown values never exceed 1.
	one := big.NewRat(1, 1)
	report.TotalWeight = toFloat(minRat(total, one))
	report.PassedWeight = toFloat(minRat(passed, one))
	report.PreviousPassedWeight = toFloat(minRat(previousPassed, one))
	if len(ms) == 0 {
		report.Limits = append(report.Limits, LimitNoMilestones)
		return report, nil
	}
	report.ProgressAvailable = true
	shown := minRat(passed, one)
	if criticalUnresolved && shown.Cmp(criticalCap) > 0 {
		shown = criticalCap
		report.CriticalCapApplied = true
	}
	report.Progress = toFloat(shown)
	if len(report.Unmeasured) > 0 {
		report.Limits = append(report.Limits, LimitUnmeasured)
	}
	if total.Cmp(one) < 0 {
		report.Limits = append(report.Limits, LimitWeightBelowOne)
	}
	return report, nil
}

func lookup(m map[string]Status, id string) Status {
	if s, ok := m[id]; ok {
		return s
	}
	return StatusNotMeasured
}

func minRat(a, b *big.Rat) *big.Rat {
	if a.Cmp(b) > 0 {
		return b
	}
	return a
}

func toFloat(r *big.Rat) float64 {
	f, _ := r.Float64()
	return f
}

func checkContract(c contract.TaskContract) error {
	switch {
	case c.Id == "" || c.TaskVersion < 1:
		return reject(ErrInvalidContract, "contract", "", "task identity missing")
	case !hashPattern.MatchString(c.ContractHash):
		return reject(ErrInvalidContract, "contract", "", "contract_hash malformed")
	case !commitPattern.MatchString(c.Workspace.Commit):
		return reject(ErrInvalidContract, "contract", "", "base commit malformed")
	}
	seen := map[string]bool{}
	var sum float64 // same naive contract-order float64 sum as contract/validate.go
	for _, m := range c.Progress.Milestones {
		switch {
		case !idPattern.MatchString(m.Id):
			return reject(ErrInvalidContract, "contract", m.Id, "milestone id malformed")
		case seen[m.Id]:
			return reject(ErrDuplicateMilestone, "contract", m.Id, "")
		case math.IsNaN(m.Weight) || math.IsInf(m.Weight, 0) || m.Weight <= 0 || m.Weight > 1:
			return reject(ErrInvalidContract, "contract", m.Id, "weight must be in (0, 1]")
		}
		seen[m.Id] = true
		sum += m.Weight
	}
	if sum > 1+weightTolerance {
		return reject(ErrInvalidContract, "contract", "", "milestone weights exceed 1")
	}
	return nil
}

// index validates a measurement against the contract and returns its results
// keyed by milestone id.
func index(source string, c contract.TaskContract, m Measurement) (map[string]Status, error) {
	x := m.Context
	switch {
	case x.TaskID != c.Id:
		return nil, reject(ErrContextMismatch, source, "", "task_id differs")
	case x.TaskVersion != c.TaskVersion:
		return nil, reject(ErrContextMismatch, source, "", "task_version differs")
	case x.ContractHash != c.ContractHash:
		return nil, reject(ErrContextMismatch, source, "", "contract_hash differs")
	case x.BaseCommit != c.Workspace.Commit:
		return nil, reject(ErrContextMismatch, source, "", "base_commit differs")
	case !hashPattern.MatchString(x.ArtifactSHA256):
		return nil, reject(ErrInvalidMeasurement, source, "", "artifact_sha256 malformed")
	}
	defined := make(map[string]bool, len(c.Progress.Milestones))
	for _, d := range c.Progress.Milestones {
		defined[d.Id] = true
	}
	// Faults are collected over all results and reported by fixed priority
	// (unknown, duplicate, invalid status; smallest id first) so the error
	// never depends on result order.
	out := make(map[string]Status, len(m.Results))
	var unknown, duplicate, invalid []Result
	for _, r := range m.Results {
		switch {
		case !defined[r.MilestoneID]:
			unknown = append(unknown, r)
			continue
		case r.Status != StatusPass && r.Status != StatusFail && r.Status != StatusBlocked:
			invalid = append(invalid, r)
		}
		if _, dup := out[r.MilestoneID]; dup {
			duplicate = append(duplicate, r)
		}
		out[r.MilestoneID] = r.Status
	}
	if r, ok := smallest(unknown); ok {
		return nil, reject(ErrUnknownMilestone, source, r.MilestoneID, "")
	}
	if r, ok := smallest(duplicate); ok {
		return nil, reject(ErrDuplicateMilestone, source, r.MilestoneID, "")
	}
	if r, ok := smallest(invalid); ok {
		return nil, reject(ErrInvalidStatus, source, r.MilestoneID, fmt.Sprintf("status %q", clip(string(r.Status))))
	}
	return out, nil
}

func smallest(rs []Result) (Result, bool) {
	if len(rs) == 0 {
		return Result{}, false
	}
	best := rs[0]
	for _, r := range rs[1:] {
		if r.MilestoneID < best.MilestoneID || (r.MilestoneID == best.MilestoneID && r.Status < best.Status) {
			best = r
		}
	}
	return best, true
}
