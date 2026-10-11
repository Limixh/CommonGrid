// Package simulation is an offline, seeded, virtual-time simulator that
// compares scheduling policies on synthetic search trees. It never calls a
// model, a CLI, a network service or sleeps: results describe the synthetic
// scenario only and say nothing about real model success or efficiency.
package simulation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"commongrid/coordinator/internal/contract"
)

const (
	ScenarioFormat  = "commongrid.simulation.scenario"
	ScenarioVersion = "1.0"

	defaultHorizonSec    = int64(30 * 24 * 3600)
	defaultSamples       = 20
	maxSamples           = 10000
	maxContractsFileSize = 8 << 20
	maxScenarioFileSize  = 4 << 20
)

var scenarioIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$`)

// Range is an inclusive integer range in seconds.
type Range struct {
	Min int64 `json:"min"`
	Max int64 `json:"max"`
}

func (r Range) validate(name string) error {
	if r.Min < 1 || r.Max < r.Min {
		return fmt.Errorf("%s: need 1 <= min <= max", name)
	}
	return nil
}

// Scenario is the separately versioned simulation input. AND/OR relations and
// synthetic outcomes live here and never in the live task schema; the embedded
// or referenced contracts are ordinary task contracts validated by
// contract.Validator.
type Scenario struct {
	Format             string            `json:"format"`
	FormatVersion      string            `json:"format_version"`
	ID                 string            `json:"id"`
	Title              string            `json:"title"`
	Description        string            `json:"description,omitempty"`
	ContractsFile      string            `json:"contracts_file,omitempty"`
	Contracts          []json.RawMessage `json:"contracts,omitempty"`
	Root               string            `json:"root"`
	Nodes              []Node            `json:"nodes"`
	Budget             Budget            `json:"budget"`
	Volunteers         []Volunteer       `json:"volunteers"`
	Outages            []Outage          `json:"outages,omitempty"`
	RandomOutages      []RandomOutage    `json:"random_outages,omitempty"`
	Verification       Stage             `json:"verification"`
	Review             ReviewStage       `json:"review"`
	Handoff            HandoffModel      `json:"handoff"`
	HorizonSec         int64             `json:"horizon_sec,omitempty"`
	RecommendedSamples int               `json:"recommended_samples,omitempty"`

	// Populated by Load*/Parse; not part of the file format.
	TaskContracts map[string]contract.TaskContract `json:"-"`
	SourceSHA256  string                           `json:"-"`
}

// Node is one search-tree node. Every node maps to exactly one contract: the
// node id must equal that contract's node_id.
type Node struct {
	ID        string     `json:"id"`
	TaskID    string     `json:"task_id"`
	Relation  string     `json:"relation"` // leaf | and | or
	Children  []string   `json:"children,omitempty"`
	Synthetic *LeafModel `json:"synthetic,omitempty"`
}

// LeafModel describes the synthetic attempt outcomes of a leaf.
type LeafModel struct {
	WorkSec                     Range                   `json:"work_sec"`
	Profiles                    map[string]ProfileModel `json:"profiles"`                    // must contain "default"
	ArtifactVariants            int                     `json:"artifact_variants,omitempty"` // 0: every success is a distinct artifact
	VerificationPassProbability *float64                `json:"verification_pass_probability,omitempty"`
}

// ProfileModel is the per-agent-profile outcome model. FlawProbability is the
// chance that this profile has a latent flaw on this task, shared by all of
// its attempts (correlated failure).
type ProfileModel struct {
	SuccessProbability float64 `json:"success_probability"`
	FlawProbability    float64 `json:"flaw_probability,omitempty"`
}

type Budget struct {
	TotalAgentSec int64 `json:"total_agent_sec"`
}

// Volunteer is synthetic capacity: Slots concurrent attempts from JoinSec
// until a leave time sampled from OnlineSec (never leaves when nil).
type Volunteer struct {
	ID        string `json:"id"`
	Profile   string `json:"profile"`
	Provider  string `json:"provider"`
	JoinSec   int64  `json:"join_sec"`
	Slots     int    `json:"slots,omitempty"`
	OnlineSec *Range `json:"online_sec,omitempty"`
}

type Outage struct {
	Provider string `json:"provider"`
	StartSec int64  `json:"start_sec"`
	EndSec   int64  `json:"end_sec"`
}

// RandomOutage pre-samples Count outage windows per run.
type RandomOutage struct {
	Provider    string `json:"provider"`
	Count       int    `json:"count"`
	StartSec    Range  `json:"start_sec"`
	DurationSec Range  `json:"duration_sec"`
}

// Stage is a central verification queue.
type Stage struct {
	Workers     int    `json:"workers,omitempty"`
	DurationSec *Range `json:"duration_sec,omitempty"`
}

// ReviewStage is the human review queue, used for contracts whose review
// policy is not "auto".
type ReviewStage struct {
	Reviewers         int      `json:"reviewers,omitempty"`
	DurationSec       *Range   `json:"duration_sec,omitempty"`
	AcceptProbability *float64 `json:"accept_probability,omitempty"`
}

type HandoffModel struct {
	OverheadSec int64 `json:"overhead_sec,omitempty"`
}

// LoadFile reads, strictly parses and validates a scenario. A relative
// contracts_file resolves against the scenario's directory.
func LoadFile(path string) (*Scenario, error) {
	raw, err := readLimited(path, maxScenarioFileSize)
	if err != nil {
		return nil, err
	}
	return Parse(raw, filepath.Dir(path))
}

func readLimited(path string, limit int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("%s: not a regular file or larger than %d bytes", path, limit)
	}
	return os.ReadFile(path)
}

// Parse validates a scenario document. baseDir resolves contracts_file.
func Parse(raw []byte, baseDir string) (*Scenario, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var sc Scenario
	if err := decoder.Decode(&sc); err != nil {
		return nil, fmt.Errorf("scenario: %w", err)
	}
	if decoder.More() {
		return nil, errors.New("scenario: trailing data")
	}
	sum := sha256.Sum256(raw)
	sc.SourceSHA256 = hex.EncodeToString(sum[:])
	if err := sc.load(baseDir); err != nil {
		return nil, err
	}
	return &sc, nil
}

func (sc *Scenario) load(baseDir string) error {
	if sc.Format != ScenarioFormat || sc.FormatVersion != ScenarioVersion {
		return fmt.Errorf("scenario: unsupported format %q version %q", sc.Format, sc.FormatVersion)
	}
	if !scenarioIDPattern.MatchString(sc.ID) || sc.Title == "" {
		return errors.New("scenario: id and title are required")
	}
	rawContracts, err := sc.rawContracts(baseDir)
	if err != nil {
		return err
	}
	validator, err := contract.NewValidator()
	if err != nil {
		return err
	}
	sc.TaskContracts = make(map[string]contract.TaskContract, len(rawContracts))
	for _, raw := range rawContracts {
		task, err := validator.Task(raw)
		if err != nil {
			return fmt.Errorf("scenario: contract rejected: %w", err)
		}
		if _, dup := sc.TaskContracts[task.Id]; dup {
			return fmt.Errorf("scenario: duplicate contract %s", task.Id)
		}
		sc.TaskContracts[task.Id] = task
	}
	if err := sc.validateTree(); err != nil {
		return err
	}
	if err := sc.validateCapacity(); err != nil {
		return err
	}
	sc.applyDefaults()
	return nil
}

func (sc *Scenario) rawContracts(baseDir string) ([]json.RawMessage, error) {
	if (sc.ContractsFile == "") == (len(sc.Contracts) == 0) {
		return nil, errors.New("scenario: exactly one of contracts and contracts_file is required")
	}
	if len(sc.Contracts) > 0 {
		return sc.Contracts, nil
	}
	if filepath.IsAbs(sc.ContractsFile) {
		return nil, errors.New("scenario: contracts_file must be relative")
	}
	raw, err := readLimited(filepath.Join(baseDir, sc.ContractsFile), maxContractsFileSize)
	if err != nil {
		return nil, fmt.Errorf("scenario: contracts_file: %w", err)
	}
	var file struct {
		Tasks []json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &file); err != nil || len(file.Tasks) == 0 {
		return nil, errors.New("scenario: contracts_file must hold a non-empty tasks array")
	}
	return file.Tasks, nil
}

func (sc *Scenario) validateTree() error {
	if len(sc.Nodes) == 0 || len(sc.Nodes) > 500 {
		return errors.New("scenario: 1..500 nodes required")
	}
	byID := make(map[string]*Node, len(sc.Nodes))
	usedTasks := map[string]bool{}
	for i := range sc.Nodes {
		n := &sc.Nodes[i]
		if _, dup := byID[n.ID]; dup || n.ID == "" {
			return fmt.Errorf("scenario: duplicate or empty node id %q", n.ID)
		}
		byID[n.ID] = n
		task, ok := sc.TaskContracts[n.TaskID]
		if !ok {
			return fmt.Errorf("scenario: node %s references unknown contract %q", n.ID, n.TaskID)
		}
		if task.NodeId != n.ID {
			return fmt.Errorf("scenario: node %s must equal contract %s node_id %q", n.ID, n.TaskID, task.NodeId)
		}
		if usedTasks[n.TaskID] {
			return fmt.Errorf("scenario: contract %s used by two nodes", n.TaskID)
		}
		usedTasks[n.TaskID] = true
		switch n.Relation {
		case "leaf":
			if len(n.Children) != 0 || n.Synthetic == nil {
				return fmt.Errorf("scenario: leaf %s needs synthetic and no children", n.ID)
			}
			if err := n.Synthetic.validate(n.ID); err != nil {
				return err
			}
		case "and", "or":
			if len(n.Children) == 0 || n.Synthetic != nil {
				return fmt.Errorf("scenario: %s node %s needs children and no synthetic", n.Relation, n.ID)
			}
		default:
			return fmt.Errorf("scenario: node %s has unknown relation %q", n.ID, n.Relation)
		}
	}
	root, ok := byID[sc.Root]
	if !ok {
		return errors.New("scenario: root is not a node")
	}
	parents := map[string]string{}
	for _, n := range sc.Nodes {
		for _, child := range n.Children {
			if _, ok := byID[child]; !ok || child == sc.Root {
				return fmt.Errorf("scenario: node %s has bad child %q", n.ID, child)
			}
			if _, dup := parents[child]; dup {
				return fmt.Errorf("scenario: node %s has two parents", child)
			}
			parents[child] = n.ID
		}
	}
	reached := map[string]bool{}
	var walk func(*Node) error
	walk = func(n *Node) error {
		if reached[n.ID] {
			return errors.New("scenario: cycle in tree")
		}
		reached[n.ID] = true
		for _, child := range n.Children {
			if err := walk(byID[child]); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return err
	}
	if len(reached) != len(sc.Nodes) {
		return errors.New("scenario: unreachable nodes")
	}
	return sc.validateDependencies(byID, parents)
}

// validateDependencies rejects depends_on edges that point outside the
// scenario or can never be satisfied (cycles, ancestors).
func (sc *Scenario) validateDependencies(byID map[string]*Node, parents map[string]string) error {
	nodeOfTask := map[string]string{}
	for _, n := range sc.Nodes {
		nodeOfTask[n.TaskID] = n.ID
	}
	var leavesUnder func(id string) []string
	leavesUnder = func(id string) []string {
		n := byID[id]
		if n.Relation == "leaf" {
			return []string{id}
		}
		var out []string
		for _, c := range n.Children {
			out = append(out, leavesUnder(c)...)
		}
		return out
	}
	edges := map[string][]string{}
	for _, n := range sc.Nodes {
		if n.Relation != "leaf" {
			continue
		}
		for at := n.ID; at != ""; at = parents[at] {
			for _, dep := range sc.TaskContracts[byID[at].TaskID].DependsOn {
				target, ok := nodeOfTask[dep]
				if !ok {
					return fmt.Errorf("scenario: contract %s depends on %s outside the scenario", byID[at].TaskID, dep)
				}
				edges[n.ID] = append(edges[n.ID], leavesUnder(target)...)
			}
		}
	}
	state := map[string]int{}
	var visit func(string) bool
	visit = func(id string) bool {
		if state[id] == 1 {
			return false
		}
		if state[id] == 2 {
			return true
		}
		state[id] = 1
		for _, next := range edges[id] {
			if !visit(next) {
				return false
			}
		}
		state[id] = 2
		return true
	}
	ids := make([]string, 0, len(edges))
	for id := range edges {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if !visit(id) {
			return errors.New("scenario: unsatisfiable depends_on (cycle or ancestor)")
		}
	}
	return nil
}

func (m *LeafModel) validate(id string) error {
	if err := m.WorkSec.validate("leaf " + id + " work_sec"); err != nil {
		return err
	}
	if _, ok := m.Profiles["default"]; !ok {
		return fmt.Errorf("scenario: leaf %s needs a default profile model", id)
	}
	for name, p := range m.Profiles {
		if !inUnit(p.SuccessProbability) || !inUnit(p.FlawProbability) {
			return fmt.Errorf("scenario: leaf %s profile %s: probabilities must be in [0,1]", id, name)
		}
	}
	if m.ArtifactVariants < 0 || m.ArtifactVariants > 1000 {
		return fmt.Errorf("scenario: leaf %s artifact_variants out of range", id)
	}
	if m.VerificationPassProbability != nil && !inUnit(*m.VerificationPassProbability) {
		return fmt.Errorf("scenario: leaf %s verification_pass_probability out of range", id)
	}
	return nil
}

func inUnit(p float64) bool { return p >= 0 && p <= 1 }

func (sc *Scenario) validateCapacity() error {
	if sc.Budget.TotalAgentSec < 1 {
		return errors.New("scenario: budget.total_agent_sec must be positive")
	}
	if len(sc.Volunteers) == 0 || len(sc.Volunteers) > 1000 {
		return errors.New("scenario: 1..1000 volunteers required")
	}
	seen := map[string]bool{}
	for _, v := range sc.Volunteers {
		if v.ID == "" || seen[v.ID] || v.Profile == "" || v.Provider == "" || v.JoinSec < 0 || v.Slots < 0 || v.Slots > 50 {
			return fmt.Errorf("scenario: bad volunteer %q", v.ID)
		}
		seen[v.ID] = true
		if v.OnlineSec != nil {
			if err := v.OnlineSec.validate("volunteer " + v.ID + " online_sec"); err != nil {
				return err
			}
		}
	}
	for _, o := range sc.Outages {
		if o.Provider == "" || o.StartSec < 0 || o.EndSec <= o.StartSec {
			return errors.New("scenario: bad outage window")
		}
	}
	for _, o := range sc.RandomOutages {
		if o.Provider == "" || o.Count < 1 || o.Count > 100 || o.StartSec.Min < 0 || o.StartSec.Max < o.StartSec.Min {
			return errors.New("scenario: bad random outage")
		}
		if err := o.DurationSec.validate("random outage duration_sec"); err != nil {
			return err
		}
	}
	if sc.Verification.Workers < 0 || sc.Review.Reviewers < 0 || sc.Handoff.OverheadSec < 0 || sc.HorizonSec < 0 {
		return errors.New("scenario: negative stage or horizon value")
	}
	for name, r := range map[string]*Range{"verification.duration_sec": sc.Verification.DurationSec, "review.duration_sec": sc.Review.DurationSec} {
		if r != nil {
			if err := r.validate(name); err != nil {
				return err
			}
		}
	}
	if sc.Review.AcceptProbability != nil && !inUnit(*sc.Review.AcceptProbability) {
		return errors.New("scenario: review.accept_probability out of range")
	}
	if sc.RecommendedSamples < 0 || sc.RecommendedSamples > maxSamples {
		return errors.New("scenario: recommended_samples out of range")
	}
	for _, n := range sc.Nodes {
		if n.Relation == "leaf" && sc.Handoff.OverheadSec >= sc.TaskContracts[n.TaskID].Environment.TimeLimitSec {
			return fmt.Errorf("scenario: handoff overhead must be below the time limit of %s", n.TaskID)
		}
	}
	return nil
}

func (sc *Scenario) applyDefaults() {
	if sc.Verification.Workers == 0 {
		sc.Verification.Workers = 1
	}
	if sc.Verification.DurationSec == nil {
		sc.Verification.DurationSec = &Range{Min: 1, Max: 1}
	}
	if sc.Review.Reviewers == 0 {
		sc.Review.Reviewers = 1
	}
	if sc.Review.DurationSec == nil {
		sc.Review.DurationSec = &Range{Min: 1, Max: 1}
	}
	if sc.HorizonSec == 0 {
		sc.HorizonSec = defaultHorizonSec
	}
	if sc.RecommendedSamples == 0 {
		sc.RecommendedSamples = defaultSamples
	}
	for i := range sc.Volunteers {
		if sc.Volunteers[i].Slots == 0 {
			sc.Volunteers[i].Slots = 1
		}
	}
}
