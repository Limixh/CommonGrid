package simulation

import (
	"fmt"
	"strconv"
	"strings"
)

// Candidate is what a policy may know about an open leaf: counts of what the
// scheduler has already done, never the hidden synthetic outcome.
type Candidate struct {
	TaskID   string
	Order    int // depth-first position in the tree
	Attempts int // attempts started so far
	Running  int // attempts currently holding a volunteer slot
	Failures int // attempts that ended in failure
}

// Policy decides which open leaf gets the next free volunteer slot. A policy
// instance is created per run and carries no randomness: all randomness lives
// in the shared World, so policies cannot perturb each other's world.
type Policy interface {
	// ID is the canonical spec, e.g. "fixed:3".
	ID() string
	// MaxParallel caps concurrently running attempts; 0 means unlimited.
	MaxParallel() int
	// Pick returns the index of the chosen candidate. candidates is never
	// empty and already respects per-task caps, dependencies and budget.
	Pick(candidates []Candidate) int
}

// attemptBlock is how many attempts the ordered policies give one leaf before
// moving to the next open leaf.
const attemptBlock = 3

// PolicySpec builds a fresh policy instance for each run.
type PolicySpec struct {
	ID   string
	make func() Policy
}

// New returns a fresh instance.
func (s PolicySpec) New() Policy { return s.make() }

// ParsePolicies parses a list such as "single", "fixed:3", "round-robin" and
// "least-attempted". Duplicates are rejected.
func ParsePolicies(specs []string) ([]PolicySpec, error) {
	if len(specs) == 0 {
		return nil, fmt.Errorf("at least one policy is required")
	}
	seen := map[string]bool{}
	out := make([]PolicySpec, 0, len(specs))
	for _, raw := range specs {
		spec, err := parsePolicy(strings.TrimSpace(raw))
		if err != nil {
			return nil, err
		}
		if seen[spec.ID] {
			return nil, fmt.Errorf("duplicate policy %q", spec.ID)
		}
		seen[spec.ID] = true
		out = append(out, spec)
	}
	return out, nil
}

func parsePolicy(raw string) (PolicySpec, error) {
	name, arg, hasArg := strings.Cut(raw, ":")
	switch {
	case name == "single" && !hasArg:
		return PolicySpec{ID: "single", make: func() Policy { return &orderedPolicy{id: "single", limit: 1} }}, nil
	case name == "fixed" && hasArg:
		n, err := strconv.Atoi(arg)
		if err != nil || n < 1 || n > 50 {
			return PolicySpec{}, fmt.Errorf("fixed policy needs a parallelism 1..50, got %q", arg)
		}
		id := "fixed:" + strconv.Itoa(n)
		return PolicySpec{ID: id, make: func() Policy { return &orderedPolicy{id: id, limit: n} }}, nil
	case name == "round-robin" && !hasArg:
		return PolicySpec{ID: name, make: func() Policy { return &roundRobin{last: -1} }}, nil
	case name == "least-attempted" && !hasArg:
		return PolicySpec{ID: name, make: func() Policy { return leastAttempted{} }}, nil
	}
	return PolicySpec{}, fmt.Errorf("unknown policy %q (single | fixed:N | round-robin | least-attempted)", raw)
}

// DefaultPolicies is the standard comparison set.
func DefaultPolicies() []string {
	return []string{"single", "fixed:3", "round-robin", "least-attempted"}
}

// orderedPolicy works the tree in depth-first order, giving each leaf blocks
// of attemptBlock attempts before moving on. limit is the global parallelism:
// 1 is the single-agent baseline, N the simple fixed-parallel baseline.
type orderedPolicy struct {
	id    string
	limit int
}

func (p *orderedPolicy) ID() string       { return p.id }
func (p *orderedPolicy) MaxParallel() int { return p.limit }
func (p *orderedPolicy) Pick(c []Candidate) int {
	best := 0
	for i, cand := range c {
		bi, bb := cand.Attempts/attemptBlock, c[best].Attempts/attemptBlock
		if bi < bb || (bi == bb && cand.Order < c[best].Order) {
			best = i
		}
	}
	return best
}

// roundRobin cycles through open leaves in depth-first order.
type roundRobin struct{ last int }

func (p *roundRobin) ID() string       { return "round-robin" }
func (p *roundRobin) MaxParallel() int { return 0 }
func (p *roundRobin) Pick(c []Candidate) int {
	best, bestAfter := -1, -1
	for i, cand := range c {
		if cand.Order > p.last && (bestAfter == -1 || cand.Order < c[bestAfter].Order) {
			bestAfter = i
		}
		if best == -1 || cand.Order < c[best].Order {
			best = i
		}
	}
	if bestAfter != -1 {
		best = bestAfter
	}
	p.last = c[best].Order
	return best
}

// leastAttempted always picks the leaf with the fewest started attempts.
type leastAttempted struct{}

func (leastAttempted) ID() string       { return "least-attempted" }
func (leastAttempted) MaxParallel() int { return 0 }
func (leastAttempted) Pick(c []Candidate) int {
	best := 0
	for i, cand := range c {
		if cand.Attempts < c[best].Attempts || (cand.Attempts == c[best].Attempts && cand.Order < c[best].Order) {
			best = i
		}
	}
	return best
}
