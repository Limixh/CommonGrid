package simulation

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
)

// World is the shared random environment of one run. Nothing in it is a
// sequential random stream: every variate is a pure function of
// (seed, run, domain, entity keys), so a policy cannot change what another
// policy sees by consuming randomness in a different order or amount. All
// policies in one sample are evaluated on the same World.
type World struct {
	seed int64
	run  int
}

// NewWorld returns the world for one (seed, run index).
func NewWorld(seed int64, run int) World { return World{seed: seed, run: run} }

func (w World) bits(domain string, parts ...string) uint64 {
	h := sha256.New()
	put := func(s string) {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(s)))
		h.Write(n[:])
		h.Write([]byte(s))
	}
	put("commongrid-sim-world/1")
	put(strconv.FormatInt(w.seed, 10))
	put(strconv.Itoa(w.run))
	put(domain)
	for _, p := range parts {
		put(p)
	}
	return binary.BigEndian.Uint64(h.Sum(nil)[:8])
}

// U returns a uniform variate in [0,1) for the key.
func (w World) U(domain string, parts ...string) float64 {
	return float64(w.bits(domain, parts...)>>11) / float64(uint64(1)<<53)
}

// pick maps u in [0,1) onto the inclusive range.
func pick(u float64, r Range) int64 {
	n := r.Max - r.Min + 1
	v := int64(u * float64(n))
	if v >= n {
		v = n - 1
	}
	return r.Min + v
}

// AttemptVariates are all the random numbers an attempt can ever need,
// keyed by (task, attempt index). They do not depend on which volunteer,
// profile or policy runs the attempt.
type AttemptVariates struct {
	Work         float64
	Success      float64
	Artifact     float64
	VerifySvc    float64
	ReviewSvc    float64
	ReviewAccept float64
}

// Attempt returns the variates of the index-th attempt on task.
func (w World) Attempt(task string, index int) AttemptVariates {
	i := strconv.Itoa(index)
	return AttemptVariates{
		Work:         w.U("attempt-work", task, i),
		Success:      w.U("attempt-success", task, i),
		Artifact:     w.U("attempt-artifact", task, i),
		VerifySvc:    w.U("attempt-verify-service", task, i),
		ReviewSvc:    w.U("attempt-review-service", task, i),
		ReviewAccept: w.U("attempt-review-accept", task, i),
	}
}

// Flaw is the latent shared-failure variate of (task, profile): all attempts
// of a flawed profile on a task fail together.
func (w World) Flaw(task, profile string) float64 { return w.U("profile-flaw", task, profile) }

// ArtifactValidity decides, per artifact identity, whether verification will
// accept it. Identical artifacts therefore always get identical verdicts.
func (w World) ArtifactValidity(task string, variant int) float64 {
	return w.U("artifact-valid", task, strconv.Itoa(variant))
}

// VolunteerOnline samples how long a volunteer stays after joining.
func (w World) VolunteerOnline(volunteer string, r Range) int64 {
	return pick(w.U("volunteer-online", volunteer), r)
}

type window struct{ Start, End int64 }

// RandomOutageWindows pre-samples the windows of one random outage rule.
func (w World) RandomOutageWindows(ruleIndex int, o RandomOutage) []window {
	out := make([]window, 0, o.Count)
	for i := 0; i < o.Count; i++ {
		key := []string{o.Provider, strconv.Itoa(ruleIndex), strconv.Itoa(i)}
		start := pick(w.U("outage-start", key...), o.StartSec)
		out = append(out, window{start, start + pick(w.U("outage-duration", key...), o.DurationSec)})
	}
	return out
}

// digestAttempts is how many attempt indexes per leaf enter the digest.
const digestAttempts = 16

// Digest fingerprints the pre-sampled world of a scenario (volunteer
// departures, outage windows, shared flaws and the first attempt variates of
// every leaf). Two policies facing the same world report the same digest.
func (w World) Digest(sc *Scenario) string {
	h := sha256.New()
	for _, v := range sc.Volunteers {
		if v.OnlineSec != nil {
			fmt.Fprintf(h, "vol %s %d\n", v.ID, w.VolunteerOnline(v.ID, *v.OnlineSec))
		}
	}
	for i, o := range sc.RandomOutages {
		for _, win := range w.RandomOutageWindows(i, o) {
			fmt.Fprintf(h, "outage %s %d %d\n", o.Provider, win.Start, win.End)
		}
	}
	profiles := map[string]bool{}
	for _, v := range sc.Volunteers {
		profiles[v.Profile] = true
	}
	names := make([]string, 0, len(profiles))
	for p := range profiles {
		names = append(names, p)
	}
	sort.Strings(names)
	for _, n := range sc.Nodes {
		if n.Relation != "leaf" {
			continue
		}
		for _, p := range names {
			fmt.Fprintf(h, "flaw %s %s %x\n", n.TaskID, p, w.bits("profile-flaw", n.TaskID, p))
		}
		for i := 0; i < digestAttempts; i++ {
			a := w.Attempt(n.TaskID, i)
			fmt.Fprintf(h, "att %s %d %v %v %v %v %v %v\n", n.TaskID, i, a.Work, a.Success, a.Artifact, a.VerifySvc, a.ReviewSvc, a.ReviewAccept)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}
