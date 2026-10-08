package contract

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed contracts.schema.json
var schemas embed.FS

type Validator struct{ task, checkpoint *jsonschema.Schema }

func NewValidator() (*Validator, error) {
	raw, err := schemas.ReadFile("contracts.schema.json")
	if err != nil {
		return nil, err
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft7)
	if err = compiler.AddResource("https://commongrid.local/schemas/contracts/1.0", document); err != nil {
		return nil, err
	}
	schema, err := compiler.Compile("https://commongrid.local/schemas/contracts/1.0#/$defs/TaskContract")
	if err != nil {
		return nil, err
	}
	checkpoint, err := compiler.Compile("https://commongrid.local/schemas/contracts/1.0#/$defs/Checkpoint")
	if err != nil {
		return nil, err
	}
	return &Validator{task: schema, checkpoint: checkpoint}, nil
}

// Checkpoint metadata is untrusted context. Validation grants no usable verdict.
func (v *Validator) Checkpoint(raw []byte) (Checkpoint, error) {
	var checkpoint Checkpoint
	if len(raw) > 128*1024 {
		return checkpoint, errors.New("checkpoint metadata too large")
	}
	if _, err := jsoncanonicalizer.Transform(raw); err != nil {
		return checkpoint, fmt.Errorf("invalid canonical JSON: %w", err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return checkpoint, err
	}
	if err = v.checkpoint.Validate(document); err != nil {
		return checkpoint, err
	}
	if err = json.Unmarshal(raw, &checkpoint); err != nil {
		return checkpoint, err
	}
	if checkpoint.ParentCheckpointId != nil && *checkpoint.ParentCheckpointId == checkpoint.CheckpointId {
		return checkpoint, errors.New("checkpoint cannot parent itself")
	}
	return checkpoint, nil
}

func ComputeHash(raw []byte) (string, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return "", err
	}
	payload := make(map[string]json.RawMessage, len(immutableFields))
	for _, field := range immutableFields {
		value, exists := document[field]
		if !exists {
			return "", fmt.Errorf("missing immutable field: %s", field)
		}
		payload[field] = value
	}
	serialized, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	canonical, err := jsoncanonicalizer.Transform(serialized)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func (v *Validator) Task(raw []byte) (TaskContract, error) {
	var task TaskContract
	// JCS rejects duplicate keys and invalid Unicode before JSON decoding can hide them.
	if _, err := jsoncanonicalizer.Transform(raw); err != nil {
		return task, fmt.Errorf("invalid canonical JSON: %w", err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return task, err
	}
	if err = v.task.Validate(document); err != nil {
		return task, err
	}
	if err = json.Unmarshal(raw, &task); err != nil {
		return task, err
	}
	if err = semantics(task); err != nil {
		return task, err
	}
	hash, err := ComputeHash(raw)
	if err != nil {
		return task, err
	}
	if task.ContractHash != hash {
		return task, errors.New("contract_hash mismatch")
	}
	return task, nil
}

func semantics(t TaskContract) error {
	profile, output := "software-tests", "software-diff/1.0"
	if t.Type == "lean" {
		profile, output = "lean-proof", "lean-artifact/1.0"
	}
	if t.Kind == "plan" {
		profile, output = "planner-proposal", "planner-proposal/1.0"
	}
	if t.Verification.Profile != profile || t.Verification.OutputSchema != output {
		return errors.New("verification: kind/type/profile/output mismatch")
	}
	if t.Kind == "rebase" && t.Type == "lean" {
		return errors.New("rebase is software-only")
	}
	if t.Parallelism.Initial > t.Parallelism.Cap {
		return errors.New("parallelism: initial exceeds cap")
	}
	if t.Parallelism.Mode == "exclusive" && (t.Parallelism.Initial != 1 || t.Parallelism.Cap != 1) {
		return errors.New("exclusive parallelism must be 1")
	}
	for _, id := range t.DependsOn {
		if id == t.Id {
			return errors.New("task cannot depend on itself")
		}
	}
	strategyIDs := map[string]bool{}
	for _, s := range t.Strategies {
		if strategyIDs[s.Id] {
			return errors.New("duplicate strategy")
		}
		strategyIDs[s.Id] = true
	}
	milestoneIDs := map[string]bool{}
	var weight float64
	for _, m := range t.Progress.Milestones {
		if milestoneIDs[m.Id] {
			return errors.New("duplicate milestone")
		}
		milestoneIDs[m.Id] = true
		weight += m.Weight
	}
	if weight > 1+1e-12 {
		return errors.New("milestone weights exceed 1")
	}
	for _, preferred := range t.Agents.Preferred {
		for _, excluded := range t.Agents.Excluded {
			if preferred == excluded {
				return errors.New("agent is both preferred and excluded")
			}
		}
	}
	if len(t.Agents.Excluded) == 2 {
		return errors.New("all agents excluded")
	}
	if (t.Review.Policy == "auto") != (t.Review.RequiredApprovals == 0) {
		return errors.New("review approvals mismatch")
	}
	if t.Kind == "plan" && t.Review.Policy == "auto" {
		return errors.New("planner proposals require human review")
	}
	if t.Review.Policy == "auto" && (t.Type != "lean" || t.Verification.Profile != "lean-proof") {
		return errors.New("automatic review is limited to Lean proof verification")
	}
	if !t.Handoff.Enabled && t.Handoff.ResumeFromLatest {
		return errors.New("handoff disabled but resume enabled")
	}
	reserved := regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)`)
	for _, path := range append(append([]string{}, t.Workspace.EntryFiles...), t.Workspace.WritablePaths...) {
		for _, part := range strings.Split(path, "/") {
			if part == "." || part == ".." || strings.HasSuffix(part, ".") || reserved.MatchString(part) || strings.EqualFold(part, ".git") || strings.EqualFold(part, ".codex") || strings.EqualFold(part, ".claude") {
				return errors.New("unsafe or protected workspace path")
			}
		}
	}
	return nil
}
