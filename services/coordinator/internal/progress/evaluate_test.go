package progress

import (
	"encoding/json"
	"errors"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"commongrid/coordinator/internal/contract"
)

const (
	testHash     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testCommit   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	artifactOne  = "1111111111111111111111111111111111111111111111111111111111111111"
	artifactTwo  = "2222222222222222222222222222222222222222222222222222222222222222"
	otherHash    = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	otherCommit  = "dddddddddddddddddddddddddddddddddddddddd"
	testTaskName = "task-1"
)

type ms struct {
	ID       string  `json:"id"`
	Weight   float64 `json:"weight"`
	Critical bool    `json:"critical"`
}

type res struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func task(milestones []ms) contract.TaskContract {
	c := contract.TaskContract{Id: testTaskName, TaskVersion: 3, ContractHash: testHash}
	c.Workspace.Commit = testCommit
	for _, m := range milestones {
		c.Progress.Milestones = append(c.Progress.Milestones, contract.Milestone{Id: m.ID, Name: "name " + m.ID, Check: "check", Weight: m.Weight, Critical: m.Critical})
	}
	return c
}

func measurement(artifact string, results []res) Measurement {
	m := Measurement{Context: Context{TaskID: testTaskName, TaskVersion: 3, ContractHash: testHash, BaseCommit: testCommit, ArtifactSHA256: artifact}}
	for _, r := range results {
		m.Results = append(m.Results, Result{MilestoneID: r.ID, Status: Status(r.Status)})
	}
	return m
}

type scenario struct {
	Name       string `json:"name"`
	Milestones []ms   `json:"milestones"`
	Current    []res  `json:"current"`
	Previous   []res  `json:"previous"`
	Expect     struct {
		Error                string   `json:"error"`
		Available            bool     `json:"available"`
		PassedWeight         float64  `json:"passed_weight"`
		PreviousPassedWeight float64  `json:"previous_passed_weight"`
		Progress             float64  `json:"progress"`
		Cap                  bool     `json:"cap"`
		Blockers             []string `json:"blockers"`
		Gained               []string `json:"gained"`
		Regressed            []string `json:"regressed"`
		Unconfirmed          []string `json:"unconfirmed"`
		Unmeasured           []string `json:"unmeasured"`
		Limits               []Limit  `json:"limits"`
	} `json:"expect"`
}

var errorKinds = map[string]error{
	"unknown_milestone":   ErrUnknownMilestone,
	"duplicate_milestone": ErrDuplicateMilestone,
	"invalid_status":      ErrInvalidStatus,
}

func loadScenarios(t *testing.T) []scenario {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "scenarios.json"))
	if err != nil {
		t.Fatal(err)
	}
	var scenarios []scenario
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&scenarios); err != nil {
		t.Fatal(err)
	}
	return scenarios
}

func (s scenario) input() Input {
	in := Input{Contract: task(s.Milestones), Current: measurement(artifactOne, s.Current)}
	if s.Previous != nil {
		prev := measurement(artifactTwo, s.Previous)
		in.Previous = &prev
	}
	return in
}

func nonNil[T any](v []T) []T {
	if v == nil {
		return []T{}
	}
	return v
}

func TestScenarios(t *testing.T) {
	for _, s := range loadScenarios(t) {
		t.Run(s.Name, func(t *testing.T) {
			report, err := Evaluate(s.input())
			if s.Expect.Error != "" {
				kind := errorKinds[s.Expect.Error]
				if kind == nil {
					t.Fatalf("scenario names unknown error %q", s.Expect.Error)
				}
				var rejection *RejectionError
				if !errors.Is(err, kind) || !errors.As(err, &rejection) {
					t.Fatalf("want typed %v, got %v", kind, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			e := s.Expect
			if report.ProgressAvailable != e.Available || report.PassedWeight != e.PassedWeight || report.Progress != e.Progress || report.CriticalCapApplied != e.Cap || report.PreviousPassedWeight != e.PreviousPassedWeight {
				t.Fatalf("numbers: got available=%v passed=%v previous=%v progress=%v cap=%v; want %+v", report.ProgressAvailable, report.PassedWeight, report.PreviousPassedWeight, report.Progress, report.CriticalCapApplied, e)
			}
			for name, pair := range map[string][2][]string{
				"blockers":    {report.CriticalBlockers, e.Blockers},
				"gained":      {report.Gained, e.Gained},
				"regressed":   {report.Regressed, e.Regressed},
				"unconfirmed": {report.Unconfirmed, e.Unconfirmed},
				"unmeasured":  {report.Unmeasured, e.Unmeasured},
			} {
				if !reflect.DeepEqual(pair[0], nonNil(pair[1])) {
					t.Errorf("%s: got %v want %v", name, pair[0], pair[1])
				}
			}
			if !reflect.DeepEqual(report.Limits, nonNil(e.Limits)) {
				t.Errorf("limits: got %v want %v", report.Limits, e.Limits)
			}
			if report.HasPrevious != (s.Previous != nil) {
				t.Errorf("has_previous = %v", report.HasPrevious)
			}
		})
	}
}

func TestMilestoneStatesFollowContractOrder(t *testing.T) {
	report, err := Evaluate(Input{
		Contract: task([]ms{{ID: "z", Weight: 0.3}, {ID: "a", Weight: 0.3, Critical: true}, {ID: "m", Weight: 0.4}}),
		Current:  measurement(artifactOne, []res{{"m", "pass"}, {"a", "blocked"}, {"z", "fail"}}),
	})
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, s := range report.Milestones {
		order = append(order, s.ID+":"+string(s.Status))
	}
	if got := strings.Join(order, ","); got != "z:fail,a:blocked,m:pass" {
		t.Fatalf("order/status = %s", got)
	}
	if report.Milestones[0].Name != "name z" || !report.Milestones[1].Critical || report.Milestones[2].Weight != 0.4 {
		t.Fatalf("definition fields not carried: %+v", report.Milestones)
	}
}

func TestContextMismatchRejected(t *testing.T) {
	definition := []ms{{ID: "a", Weight: 1}}
	results := []res{{"a", "pass"}}
	mutations := map[string]func(*Context){
		"task_id":       func(c *Context) { c.TaskID = "other-task" },
		"task_version":  func(c *Context) { c.TaskVersion = 4 },
		"contract_hash": func(c *Context) { c.ContractHash = otherHash },
		"base_commit":   func(c *Context) { c.BaseCommit = otherCommit },
	}
	for name, mutate := range mutations {
		t.Run("current "+name, func(t *testing.T) {
			in := Input{Contract: task(definition), Current: measurement(artifactOne, results)}
			mutate(&in.Current.Context)
			assertRejected(t, in, ErrContextMismatch, "current")
		})
		t.Run("previous "+name, func(t *testing.T) {
			prev := measurement(artifactTwo, results)
			mutate(&prev.Context)
			in := Input{Contract: task(definition), Current: measurement(artifactOne, results), Previous: &prev}
			assertRejected(t, in, ErrContextMismatch, "previous")
		})
	}
	for _, artifact := range []string{"", "xyz", strings.ToUpper(testHash), artifactOne + "0"} {
		in := Input{Contract: task(definition), Current: measurement(artifact, results)}
		assertRejected(t, in, ErrInvalidMeasurement, "current")
	}
}

func assertRejected(t *testing.T, in Input, kind error, source string) {
	t.Helper()
	_, err := Evaluate(in)
	var rejection *RejectionError
	if !errors.Is(err, kind) || !errors.As(err, &rejection) || rejection.Source != source {
		t.Fatalf("want %v from %s, got %v", kind, source, err)
	}
}

func TestInvalidContractRejected(t *testing.T) {
	good := measurement(artifactOne, nil)
	cases := map[string]struct {
		mutate func(*contract.TaskContract)
		kind   error
	}{
		"duplicate milestone": {func(c *contract.TaskContract) {
			c.Progress.Milestones = append(c.Progress.Milestones, c.Progress.Milestones[0])
		}, ErrDuplicateMilestone},
		"zero weight":     {func(c *contract.TaskContract) { c.Progress.Milestones[0].Weight = 0 }, ErrInvalidContract},
		"negative weight": {func(c *contract.TaskContract) { c.Progress.Milestones[0].Weight = -0.1 }, ErrInvalidContract},
		"weight above 1":  {func(c *contract.TaskContract) { c.Progress.Milestones[0].Weight = 1.5 }, ErrInvalidContract},
		"weights exceed 1": {func(c *contract.TaskContract) {
			c.Progress.Milestones = append(c.Progress.Milestones, contract.Milestone{Id: "b", Name: "b", Check: "c", Weight: 0.5})
		}, ErrInvalidContract},
		"bad id":          {func(c *contract.TaskContract) { c.Progress.Milestones[0].Id = "has space" }, ErrInvalidContract},
		"missing task id": {func(c *contract.TaskContract) { c.Id = "" }, ErrInvalidContract},
		"zero version":    {func(c *contract.TaskContract) { c.TaskVersion = 0 }, ErrInvalidContract},
		"bad hash":        {func(c *contract.TaskContract) { c.ContractHash = "" }, ErrInvalidContract},
		"bad base commit": {func(c *contract.TaskContract) { c.Workspace.Commit = "short" }, ErrInvalidContract},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c := task([]ms{{ID: "a", Weight: 0.6}})
			tc.mutate(&c)
			assertRejected(t, Input{Contract: c, Current: good}, tc.kind, "contract")
		})
	}
}

// The contract tolerates a weight total up to 1+1e-12 and nothing more; the
// evaluator must accept and reject exactly the same sets as the validator.
func TestWeightToleranceMatchesContractValidator(t *testing.T) {
	validator, err := contract.NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../../packages/task-schema/fixtures/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Tasks []map[string]any `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	for _, weights := range [][2]float64{{0.5, 0.5}, {0.5, 0.5 + 1e-12}, {0.5, 0.5 + 2e-12}, {0.5, 0.5 + 5e-12}, {0.3, 0.7}, {0.1 + 0.2, 0.7}} {
		name := strconv.FormatFloat(weights[0], 'g', -1, 64) + "+" + strconv.FormatFloat(weights[1], 'g', -1, 64)
		t.Run(name, func(t *testing.T) {
			doc := catalog.Tasks[1]
			milestones := doc["progress"].(map[string]any)["milestones"].([]any)
			milestones[0].(map[string]any)["weight"] = weights[0]
			milestones[1].(map[string]any)["weight"] = weights[1]
			body, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			hash, err := contract.ComputeHash(body)
			if err != nil {
				t.Fatal(err)
			}
			doc["contract_hash"] = hash
			if body, err = json.Marshal(doc); err != nil {
				t.Fatal(err)
			}
			_, validatorErr := validator.Task(body)
			if validatorErr != nil && !strings.Contains(validatorErr.Error(), "weights exceed") {
				t.Fatalf("fixture unexpectedly invalid for another reason: %v", validatorErr)
			}
			_, evalErr := Evaluate(Input{Contract: task([]ms{{ID: "a", Weight: weights[0]}, {ID: "b", Weight: weights[1]}}), Current: measurement(artifactOne, nil)})
			if (validatorErr == nil) != (evalErr == nil) {
				t.Fatalf("validator=%v evaluator=%v", validatorErr, evalErr)
			}
			if evalErr != nil && !errors.Is(evalErr, ErrInvalidContract) {
				t.Fatalf("untyped rejection: %v", evalErr)
			}
		})
	}
}

func TestGoldenContractFixturesEvaluate(t *testing.T) {
	validator, err := contract.NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../../packages/task-schema/fixtures/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Tasks []json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	for _, body := range catalog.Tasks {
		c, err := validator.Task(body)
		if err != nil {
			t.Fatal(err)
		}
		m := Measurement{Context: Context{TaskID: c.Id, TaskVersion: c.TaskVersion, ContractHash: c.ContractHash, BaseCommit: c.Workspace.Commit, ArtifactSHA256: artifactOne}}
		for _, d := range c.Progress.Milestones {
			m.Results = append(m.Results, Result{MilestoneID: d.Id, Status: StatusPass})
		}
		report, err := Evaluate(Input{Contract: c, Current: m})
		if err != nil {
			t.Fatalf("%s: %v", c.Id, err)
		}
		if len(c.Progress.Milestones) == 0 {
			if report.ProgressAvailable || report.Progress != 0 || len(report.Limits) != 1 || report.Limits[0] != LimitNoMilestones {
				t.Fatalf("%s: empty definition read as measured: %+v", c.Id, report)
			}
			continue
		}
		if !report.ProgressAvailable || report.Progress != 1 || report.CriticalCapApplied {
			t.Fatalf("%s: %+v", c.Id, report)
		}
	}
}

func permutations[T any](items []T) [][]T {
	if len(items) <= 1 {
		return [][]T{append([]T(nil), items...)}
	}
	var out [][]T
	for i := range items {
		rest := append(append([]T(nil), items[:i]...), items[i+1:]...)
		for _, p := range permutations(rest) {
			out = append(out, append([]T{items[i]}, p...))
		}
	}
	return out
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestResultOrderDoesNotChangeReport(t *testing.T) {
	definition := []ms{{ID: "a", Weight: 0.1, Critical: true}, {ID: "b", Weight: 0.2}, {ID: "c", Weight: 0.3}, {ID: "d", Weight: 0.25}}
	current := []res{{"a", "fail"}, {"b", "pass"}, {"c", "blocked"}, {"d", "pass"}}
	previous := []res{{"a", "pass"}, {"b", "fail"}, {"c", "pass"}}
	var want string
	count := 0
	for _, cur := range permutations(current) {
		for _, prev := range permutations(previous) {
			p := measurement(artifactTwo, prev)
			report, err := Evaluate(Input{Contract: task(definition), Current: measurement(artifactOne, cur), Previous: &p})
			if err != nil {
				t.Fatal(err)
			}
			got := mustJSON(t, report)
			if want == "" {
				want = got
			} else if got != want {
				t.Fatalf("report depends on result order:\n%s\n%s", want, got)
			}
			count++
		}
	}
	if count != 24*6 {
		t.Fatalf("ran %d permutations", count)
	}
}

func TestMilestoneDefinitionOrderDoesNotChangeTotals(t *testing.T) {
	definition := []ms{{ID: "a", Weight: 0.1}, {ID: "b", Weight: 0.2}, {ID: "c", Weight: 0.3}, {ID: "d", Weight: 0.4, Critical: true}}
	current := []res{{"a", "pass"}, {"b", "pass"}, {"c", "pass"}, {"d", "pass"}}
	for _, perm := range permutations(definition) {
		report, err := Evaluate(Input{Contract: task(perm), Current: measurement(artifactOne, current)})
		if err != nil {
			t.Fatal(err)
		}
		if report.PassedWeight != 1 || report.Progress != 1 || report.TotalWeight != 1 || report.CriticalCapApplied {
			t.Fatalf("order %v: %+v", perm, report)
		}
		for i, s := range report.Milestones {
			if s.ID != perm[i].ID {
				t.Fatalf("states do not follow contract order")
			}
		}
	}
}

func TestRejectionDoesNotDependOnResultOrder(t *testing.T) {
	definition := []ms{{ID: "a", Weight: 0.5}, {ID: "b", Weight: 0.5}}
	faulty := []res{{"ghost", "pass"}, {"a", "pass"}, {"a", "fail"}, {"b", "weird"}, {"zzz", "pass"}}
	var want string
	for _, perm := range permutations(faulty) {
		_, err := Evaluate(Input{Contract: task(definition), Current: measurement(artifactOne, perm)})
		if !errors.Is(err, ErrUnknownMilestone) {
			t.Fatalf("got %v", err)
		}
		if want == "" {
			want = err.Error()
		} else if err.Error() != want {
			t.Fatalf("error text depends on order: %q vs %q", want, err.Error())
		}
	}
	for _, perm := range permutations([]res{{"a", "pass"}, {"a", "fail"}, {"b", "weird"}}) {
		_, err := Evaluate(Input{Contract: task(definition), Current: measurement(artifactOne, perm)})
		if !errors.Is(err, ErrDuplicateMilestone) {
			t.Fatalf("got %v", err)
		}
	}
}

func TestPreviousArtifactContextIsKeptSeparate(t *testing.T) {
	definition := []ms{{ID: "a", Weight: 0.5}, {ID: "b", Weight: 0.5}}
	previous := measurement(artifactTwo, []res{{"a", "pass"}, {"b", "pass"}})
	report, err := Evaluate(Input{Contract: task(definition), Current: measurement(artifactOne, []res{{"a", "fail"}, {"b", "pass"}}), Previous: &previous})
	if err != nil {
		t.Fatal(err)
	}
	if report.ArtifactSHA256 != artifactOne || report.PreviousArtifactSHA256 != artifactTwo || !report.HasPrevious {
		t.Fatalf("artifact contexts: %+v", report)
	}
	if !reflect.DeepEqual(report.Regressed, []string{"a"}) || report.PreviousPassedWeight != 1 || report.PassedWeight != 0.5 {
		t.Fatalf("regression from the previous artifact not computed: %+v", report)
	}
	states := map[string]MilestoneState{}
	for _, s := range report.Milestones {
		states[s.ID] = s
	}
	if states["a"].Change != ChangeRegressed || states["a"].PreviousStatus != StatusPass || states["b"].Change != ChangeUnchanged {
		t.Fatalf("states: %+v", states)
	}
	// Same artifact twice is allowed too.
	same := measurement(artifactOne, []res{{"a", "pass"}, {"b", "pass"}})
	if report, err = Evaluate(Input{Contract: task(definition), Current: measurement(artifactOne, []res{{"a", "pass"}, {"b", "pass"}}), Previous: &same}); err != nil || len(report.Regressed) != 0 || len(report.Gained) != 0 {
		t.Fatalf("unchanged re-measurement: %v %+v", err, report)
	}
}

func TestNoPreviousMeansNoComparison(t *testing.T) {
	report, err := Evaluate(Input{Contract: task([]ms{{ID: "a", Weight: 1}}), Current: measurement(artifactOne, []res{{"a", "pass"}})})
	if err != nil {
		t.Fatal(err)
	}
	if report.HasPrevious || len(report.Gained) != 0 || len(report.Regressed) != 0 || report.Milestones[0].Change != ChangeNone || report.Milestones[0].PreviousStatus != "" {
		t.Fatalf("%+v", report)
	}
}

func TestEvaluateDoesNotMutateInputAndIsRepeatable(t *testing.T) {
	c := task([]ms{{ID: "a", Weight: 0.5, Critical: true}, {ID: "b", Weight: 0.5}})
	cur := measurement(artifactOne, []res{{"b", "pass"}, {"a", "fail"}})
	before := mustJSON(t, []any{c, cur})
	first, err := Evaluate(Input{Contract: c, Current: cur})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Evaluate(Input{Contract: c, Current: cur})
	if err != nil {
		t.Fatal(err)
	}
	if mustJSON(t, []any{c, cur}) != before || mustJSON(t, first) != mustJSON(t, second) {
		t.Fatal("input mutated or output unstable")
	}
	first.Milestones[0].Status = StatusPass
	first.CriticalBlockers[0] = "x"
	if third, _ := Evaluate(Input{Contract: c, Current: cur}); third.Milestones[0].Status != StatusFail {
		t.Fatal("report aliases shared state")
	}
}

func TestReportJSONGolden(t *testing.T) {
	definition := []ms{{ID: "crit", Weight: 0.2, Critical: true}, {ID: "a", Weight: 0.4}, {ID: "b", Weight: 0.3}}
	previous := measurement(artifactTwo, []res{{"crit", "pass"}, {"a", "fail"}})
	report, err := Evaluate(Input{Contract: task(definition), Current: measurement(artifactOne, []res{{"b", "pass"}, {"a", "pass"}, {"crit", "blocked"}}), Previous: &previous})
	if err != nil {
		t.Fatal(err)
	}
	got, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("testdata", "report.golden.json")
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, append(got, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(want)) != string(got) {
		t.Fatalf("report JSON changed:\n%s", got)
	}
}

// The package must stay a pure calculation core.
func TestPackageImportsNoShellNetworkOrModelCode(t *testing.T) {
	forbidden := []string{"os/exec", "net", "net/http", "syscall", "plugin", "unsafe", "database/sql", "commongrid/coordinator/internal/store", "commongrid/coordinator/internal/httpapi", "commongrid/coordinator/internal/verification"}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range parsed.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			for _, bad := range forbidden {
				if path == bad || strings.HasPrefix(path, bad+"/") {
					t.Errorf("%s imports %s", file, path)
				}
			}
		}
	}
}
