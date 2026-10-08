package contract

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

func golden(t *testing.T) []json.RawMessage {
	t.Helper()
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
	return catalog.Tasks
}
func TestGoldenContracts(t *testing.T) {
	validator, err := NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range golden(t) {
		if _, err := validator.Task(raw); err != nil {
			t.Fatal(err)
		}
	}
}
func TestSharedContractCases(t *testing.T) {
	validator, err := NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../../packages/task-schema/fixtures/task-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name    string              `json:"name"`
		Patches [][]json.RawMessage `json:"patches"`
		Valid   bool                `json:"valid"`
		Rehash  *bool               `json:"rehash"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	base := golden(t)[1]
	for _, scenario := range cases {
		t.Run(scenario.Name, func(t *testing.T) {
			var task map[string]any
			if err := json.Unmarshal(base, &task); err != nil {
				t.Fatal(err)
			}
			for _, patch := range scenario.Patches {
				var path string
				var value any
				_ = json.Unmarshal(patch[0], &path)
				_ = json.Unmarshal(patch[1], &value)
				var cursor any = task
				parts := strings.Split(path, ".")
				for _, part := range parts[:len(parts)-1] {
					switch current := cursor.(type) {
					case map[string]any:
						cursor = current[part]
					case []any:
						index, _ := strconv.Atoi(part)
						cursor = current[index]
					}
				}
				switch current := cursor.(type) {
				case map[string]any:
					current[parts[len(parts)-1]] = value
				case []any:
					index, _ := strconv.Atoi(parts[len(parts)-1])
					current[index] = value
				}
			}
			modified, _ := json.Marshal(task)
			if scenario.Rehash == nil || *scenario.Rehash {
				hash, err := ComputeHash(modified)
				if err != nil {
					t.Fatal(err)
				}
				task["contract_hash"] = hash
				modified, _ = json.Marshal(task)
			}
			_, err := validator.Task(modified)
			if scenario.Valid && err != nil {
				t.Fatal(err)
			}
			if !scenario.Valid && err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
}
func TestDuplicateJSONKeysRejected(t *testing.T) {
	validator, err := NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	raw := golden(t)[0]
	raw = []byte(strings.Replace(string(raw), "{", `{"id":"malicious",`, 1))
	if _, err := validator.Task(raw); err == nil {
		t.Fatal("duplicate keys accepted")
	}
}
