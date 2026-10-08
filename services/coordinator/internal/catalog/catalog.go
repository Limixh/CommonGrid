package catalog

import (
	"commongrid/coordinator/internal/contract"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
)

//go:embed catalog.json
var fixtures embed.FS

type Project struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Type        string `json:"type"`
	Description string `json:"description"`
}
type Catalog struct {
	Source           string                  `json:"source"`
	ExecutionEnabled bool                    `json:"execution_enabled"`
	Projects         []Project               `json:"projects"`
	Tasks            []contract.TaskContract `json:"tasks"`
}

func Load() (*Catalog, error) {
	raw, err := fixtures.ReadFile("catalog.json")
	if err != nil {
		return nil, err
	}
	var catalog Catalog
	if err = json.Unmarshal(raw, &catalog); err != nil {
		return nil, err
	}
	validator, err := contract.NewValidator()
	if err != nil {
		return nil, err
	}
	projects := map[string]bool{}
	tasks := map[string]bool{}
	for _, p := range catalog.Projects {
		if projects[p.ID] {
			return nil, errors.New("duplicate project")
		}
		projects[p.ID] = true
	}
	for _, t := range catalog.Tasks {
		if tasks[t.Id] {
			return nil, errors.New("duplicate task")
		}
		tasks[t.Id] = true
		if !projects[t.ProjectId] {
			return nil, fmt.Errorf("unknown project: %s", t.ProjectId)
		}
		raw, err := json.Marshal(t)
		if err != nil {
			return nil, err
		}
		if _, err = validator.Task(raw); err != nil {
			return nil, fmt.Errorf("%s: %w", t.Id, err)
		}
	}
	active := map[string]bool{}
	visited := map[string]bool{}
	byID := map[string]contract.TaskContract{}
	for _, t := range catalog.Tasks {
		byID[t.Id] = t
	}
	var visit func(string) error
	visit = func(id string) error {
		if active[id] {
			return errors.New("cyclic task dependency")
		}
		if visited[id] {
			return nil
		}
		t, ok := byID[id]
		if !ok {
			return errors.New("unknown task dependency")
		}
		active[id] = true
		for _, dep := range t.DependsOn {
			if err := visit(dep); err != nil {
				return err
			}
		}
		delete(active, id)
		visited[id] = true
		return nil
	}
	for id := range byID {
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	return &catalog, nil
}
