package simulation

import (
	"container/heap"
	"fmt"
	"sort"

	"commongrid/coordinator/internal/contract"
)

type eventKind int

// Same-time ordering: completions first so a volunteer leaving at the exact
// second a segment ends still delivers; departures last.
const (
	evSegmentEnd eventKind = iota
	evVerifyDone
	evReviewDone
	evOutageEnd
	evJoin
	evOutageStart
	evLeave
)

type event struct {
	at       int64
	kind     eventKind
	seq      int64
	seg      *segment
	vol      *vstate
	provider string
	cand     *candidate
}

type eventQueue []*event

func (q eventQueue) Len() int { return len(q) }
func (q eventQueue) Less(i, j int) bool {
	a, b := q[i], q[j]
	if a.at != b.at {
		return a.at < b.at
	}
	if a.kind != b.kind {
		return a.kind < b.kind
	}
	return a.seq < b.seq
}
func (q eventQueue) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *eventQueue) Push(x any)   { *q = append(*q, x.(*event)) }
func (q *eventQueue) Pop() any {
	old := *q
	n := len(old)
	x := old[n-1]
	*q = old[:n-1]
	return x
}

// Attempt end states.
const (
	stRunning    = "running"
	stResumable  = "resumable"
	stQueued     = "queued"
	stFailed     = "failed"
	stUseful     = "useful"
	stDuplicate  = "duplicate"
	stSuperseded = "superseded"
	stCancelled  = "cancelled"
)

// Failure reasons reported in the failed-attempt breakdown.
const (
	FailAgent        = "agent_failed"
	FailSharedFlaw   = "shared_profile_flaw"
	FailTimeout      = "timeout"
	FailInterrupted  = "interrupted"
	FailOutage       = "provider_outage"
	FailVerification = "verification_rejected"
	FailReview       = "review_rejected"
)

var failureReasons = []string{FailAgent, FailSharedFlaw, FailTimeout, FailInterrupted, FailOutage, FailVerification, FailReview}

type nstate struct {
	node     *Node
	task     contract.TaskContract
	parent   *nstate
	children []*nstate
	order    int
	solved   bool
	closed   bool

	// leaf only
	model               *LeafModel
	passProb            float64
	capacity            int
	limit               int64
	canResume           bool
	deps                []*nstate
	attempts, running   int
	failures, verifying int
	waiting             int
	submitted           map[string]string // artifact id -> pending | accepted | rejected
	needsReview         bool
}

type attempt struct {
	id            int
	leaf          *nstate
	index         int
	vars          AttemptVariates
	work, done    int64
	checkpoints   int64
	segments      int
	state         string
	interruptedAt int64
	seg           *segment
}

type segment struct {
	att         *attempt
	vol         *vstate
	start       int64
	length      int64
	overhead    int64
	workPlanned int64
	active      bool
}

type vstate struct {
	spec   *Volunteer
	online bool
	busy   int
	segs   []*segment
}

type candidate struct {
	att        *attempt
	artifact   string
	variant    int
	enqueuedAt int64
}

// LedgerEntry is one busy interval of a volunteer slot on one attempt.
type LedgerEntry struct {
	Task      string
	Attempt   int
	Volunteer string
	Start     int64
	End       int64
}

// AttemptTrace records the world an attempt faced; it is policy independent.
type AttemptTrace struct {
	Task    string
	Index   int
	Vars    AttemptVariates
	WorkSec int64
}

type stat struct{ Count, Sum, Max int64 }

func (s *stat) add(v int64) {
	s.Count++
	s.Sum += v
	if v > s.Max {
		s.Max = v
	}
}

// RunResult is the outcome of one policy on one sampled world.
type RunResult struct {
	Run         int
	WorldDigest string
	Solved      bool
	EndReason   string
	WallSec     int64 // virtual seconds until the root was solved; valid when Solved
	AgentSec    int64 // agent-time actually spent (all attempts, solved or not)

	MaxCommittedSec int64 // peak of spent + reserved; never above the budget

	AttemptsStarted     int
	Useful              int
	Duplicate           int
	Superseded          int
	Cancelled           int
	CandidatesSubmitted int
	Failed              map[string]int

	VerifyWait, ReviewWait, ResumeWait stat

	Handoffs        int
	HandoffLostSec  int64
	HandoffOverhead int64
	SharedFailures  int
	SharedGroups    int

	Ledger []LedgerEntry
	Trace  []AttemptTrace
}

type runState struct {
	sc     *Scenario
	world  World
	policy Policy
	res    *RunResult

	now      int64
	seq      int64
	q        eventQueue
	nodes    []*nstate
	leaves   []*nstate
	root     *nstate
	vols     []*vstate
	outage   map[string]int
	attempts []*attempt

	resumables []*attempt
	spent      int64
	reserved   int64
	running    int

	verifyQ, reviewQ       []*candidate
	verifyBusy, reviewBusy int
	sharedGroups           map[string]bool
	execution              *executionBudget
}

const (
	maxRunEvents        = 100_000
	maxSimulationEvents = 1_000_000
)

type executionLimitError struct{}

func (executionLimitError) Error() string {
	return "simulation execution limit exceeded; reduce samples, horizon or budget"
}

// Bound actual work, rather than assuming a large virtual horizon is cheap.
// Simulate shares this allowance across every policy and sampled world.
type executionBudget struct{ events int }

func (r *runState) push(e *event) {
	if r.seq >= maxRunEvents || r.execution.events >= maxSimulationEvents {
		panic(executionLimitError{})
	}
	r.execution.events++
	r.seq++
	e.seq = r.seq
	heap.Push(&r.q, e)
}

// RunOnce simulates one policy on one world. It is deterministic.
func RunOnce(sc *Scenario, spec PolicySpec, world World, runIndex int) *RunResult {
	return runOnce(sc, spec, world, runIndex, &executionBudget{})
}

func runOnce(sc *Scenario, spec PolicySpec, world World, runIndex int, execution *executionBudget) *RunResult {
	r := &runState{
		execution:    execution,
		sc:           sc,
		world:        world,
		policy:       spec.New(),
		outage:       map[string]int{},
		sharedGroups: map[string]bool{},
		res: &RunResult{
			Run:         runIndex,
			WorldDigest: world.Digest(sc),
			Failed:      map[string]int{},
		},
	}
	r.build()
	r.seed()
	r.loop()
	r.finish()
	return r.res
}

func (r *runState) build() {
	byID := map[string]*nstate{}
	for i := range r.sc.Nodes {
		n := &r.sc.Nodes[i]
		task := r.sc.TaskContracts[n.TaskID]
		st := &nstate{node: n, task: task}
		byID[n.ID] = st
		r.nodes = append(r.nodes, st)
	}
	for _, st := range r.nodes {
		for _, c := range st.node.Children {
			child := byID[c]
			child.parent = st
			st.children = append(st.children, child)
		}
	}
	r.root = byID[r.sc.Root]
	nodeOfTask := map[string]*nstate{}
	for _, st := range r.nodes {
		nodeOfTask[st.task.Id] = st
	}
	order := 0
	var walk func(*nstate)
	walk = func(n *nstate) {
		n.order = order
		order++
		if len(n.children) == 0 {
			r.initLeaf(n, nodeOfTask)
			r.leaves = append(r.leaves, n)
		}
		for _, c := range n.children {
			walk(c)
		}
	}
	walk(r.root)
	for _, v := range r.sc.Volunteers {
		spec := v
		r.vols = append(r.vols, &vstate{spec: &spec})
	}
	sort.SliceStable(r.vols, func(i, j int) bool { return r.vols[i].spec.ID < r.vols[j].spec.ID })
}

func (r *runState) initLeaf(n *nstate, nodeOfTask map[string]*nstate) {
	n.model = n.node.Synthetic
	n.passProb = 1
	if n.model.VerificationPassProbability != nil {
		n.passProb = *n.model.VerificationPassProbability
	}
	n.capacity = 1
	if n.task.Parallelism.Mode == "independent" {
		n.capacity = int(n.task.Parallelism.Cap)
	}
	n.limit = n.task.Environment.TimeLimitSec
	n.canResume = n.task.Handoff.Enabled && n.task.Handoff.ResumeFromLatest
	n.needsReview = n.task.Review.Policy != "auto"
	n.submitted = map[string]string{}
	for at := n; at != nil; at = at.parent {
		for _, dep := range at.task.DependsOn {
			n.deps = append(n.deps, nodeOfTask[dep])
		}
	}
}

func (r *runState) seed() {
	for _, v := range r.vols {
		v := v
		r.push(&event{at: v.spec.JoinSec, kind: evJoin, vol: v})
		if v.spec.OnlineSec != nil {
			r.push(&event{at: v.spec.JoinSec + r.world.VolunteerOnline(v.spec.ID, *v.spec.OnlineSec), kind: evLeave, vol: v})
		}
	}
	windows := make([]struct {
		provider string
		w        window
	}, 0)
	for _, o := range r.sc.Outages {
		windows = append(windows, struct {
			provider string
			w        window
		}{o.Provider, window{o.StartSec, o.EndSec}})
	}
	for i, o := range r.sc.RandomOutages {
		for _, w := range r.world.RandomOutageWindows(i, o) {
			windows = append(windows, struct {
				provider string
				w        window
			}{o.Provider, w})
		}
	}
	for _, w := range windows {
		r.push(&event{at: w.w.Start, kind: evOutageStart, provider: w.provider})
		r.push(&event{at: w.w.End, kind: evOutageEnd, provider: w.provider})
	}
}

func (r *runState) loop() {
	horizon := r.sc.HorizonSec
	for r.q.Len() > 0 && !r.res.Solved {
		at := r.q[0].at
		if at > horizon {
			r.now = horizon
			r.res.EndReason = "horizon_reached"
			return
		}
		r.now = at
		for r.q.Len() > 0 && r.q[0].at == at && !r.res.Solved {
			r.handle(heap.Pop(&r.q).(*event))
		}
		if r.res.Solved {
			return
		}
		r.dispatch()
	}
}

func (r *runState) handle(e *event) {
	switch e.kind {
	case evJoin:
		e.vol.online = true
	case evLeave:
		e.vol.online = false
		for _, seg := range append([]*segment(nil), e.vol.segs...) {
			r.interrupt(seg, FailInterrupted)
		}
	case evOutageStart:
		r.outage[e.provider]++
		for _, v := range r.vols {
			if v.spec.Provider == e.provider {
				for _, seg := range append([]*segment(nil), v.segs...) {
					r.interrupt(seg, FailOutage)
				}
			}
		}
	case evOutageEnd:
		r.outage[e.provider]--
	case evSegmentEnd:
		if e.seg.active {
			r.segmentEnded(e.seg)
		}
	case evVerifyDone:
		r.verifyBusy--
		r.verified(e.cand)
		r.startVerification()
		r.startReview()
	case evReviewDone:
		r.reviewBusy--
		r.reviewed(e.cand)
		r.startReview()
	}
}

func (r *runState) dispatch() {
	for {
		progressed := false
		for _, v := range r.vols {
			if !v.online || r.outage[v.spec.Provider] > 0 || v.busy >= v.spec.Slots {
				continue
			}
			if r.assign(v) {
				progressed = true
			}
		}
		if !progressed {
			return
		}
	}
}

func (r *runState) available() int64 { return r.sc.Budget.TotalAgentSec - r.spent - r.reserved }

func (r *runState) depsSolved(n *nstate) bool {
	for _, d := range n.deps {
		if !d.solved {
			return false
		}
	}
	return true
}

// open reports whether the leaf may host work right now, ignoring capacity.
func (r *runState) open(n *nstate) bool {
	return !n.solved && !n.closed && n.verifying == 0 && r.depsSolved(n)
}

func (r *runState) assign(v *vstate) bool {
	if max := r.policy.MaxParallel(); max > 0 && r.running >= max {
		return false
	}
	avail := r.available()
	for i, att := range r.resumables {
		leaf := att.leaf
		if r.open(leaf) && leaf.running < leaf.capacity && leaf.limit <= avail {
			r.resumables = append(r.resumables[:i], r.resumables[i+1:]...)
			leaf.waiting--
			r.res.Handoffs++
			r.res.ResumeWait.add(r.now - att.interruptedAt)
			r.startSegment(att, v)
			return true
		}
	}
	var cands []Candidate
	var leaves []*nstate
	for _, leaf := range r.leaves {
		if r.open(leaf) && leaf.running+leaf.waiting < leaf.capacity && leaf.limit <= avail {
			cands = append(cands, Candidate{TaskID: leaf.task.Id, Order: leaf.order, Attempts: leaf.attempts, Running: leaf.running, Failures: leaf.failures})
			leaves = append(leaves, leaf)
		}
	}
	if len(cands) == 0 {
		return false
	}
	idx := r.policy.Pick(cands)
	if idx < 0 || idx >= len(cands) {
		panic(fmt.Sprintf("policy %s returned index %d of %d", r.policy.ID(), idx, len(cands)))
	}
	leaf := leaves[idx]
	att := &attempt{id: len(r.attempts), leaf: leaf, index: leaf.attempts, vars: r.world.Attempt(leaf.task.Id, leaf.attempts)}
	att.work = pick(att.vars.Work, leaf.model.WorkSec)
	leaf.attempts++
	r.attempts = append(r.attempts, att)
	r.res.AttemptsStarted++
	r.res.Trace = append(r.res.Trace, AttemptTrace{Task: leaf.task.Id, Index: att.index, Vars: att.vars, WorkSec: att.work})
	r.startSegment(att, v)
	return true
}

// startSegment atomically reserves the leaf's full time limit; the unused part
// is released when the segment ends. A resumed attempt has exactly one active
// segment, so compute is never charged twice for the same moment.
func (r *runState) startSegment(att *attempt, v *vstate) {
	if att.seg != nil && att.seg.active {
		panic("attempt already has an active segment")
	}
	leaf := att.leaf
	var overhead int64
	if att.segments > 0 {
		overhead = r.sc.Handoff.OverheadSec
	}
	workPlanned := att.work - att.done
	if workPlanned > leaf.limit-overhead {
		workPlanned = leaf.limit - overhead
	}
	seg := &segment{att: att, vol: v, start: r.now, overhead: overhead, workPlanned: workPlanned, length: overhead + workPlanned, active: true}
	if r.spent+r.reserved+leaf.limit > r.sc.Budget.TotalAgentSec {
		panic("budget reservation would exceed the budget")
	}
	r.reserved += leaf.limit
	if c := r.spent + r.reserved; c > r.res.MaxCommittedSec {
		r.res.MaxCommittedSec = c
	}
	r.running++
	leaf.running++
	v.busy++
	v.segs = append(v.segs, seg)
	att.seg = seg
	att.segments++
	att.state = stRunning
	r.push(&event{at: r.now + seg.length, kind: evSegmentEnd, seg: seg})
}

// endSegment settles a segment after elapsed seconds of real use.
func (r *runState) endSegment(seg *segment, elapsed int64) {
	seg.active = false
	att := seg.att
	r.spent += elapsed
	r.reserved -= att.leaf.limit
	r.running--
	att.leaf.running--
	seg.vol.busy--
	for i, s := range seg.vol.segs {
		if s == seg {
			seg.vol.segs = append(seg.vol.segs[:i], seg.vol.segs[i+1:]...)
			break
		}
	}
	consumed := seg.overhead
	if elapsed < consumed {
		consumed = elapsed
	}
	r.res.HandoffOverhead += consumed
	r.res.AgentSec += elapsed
	r.res.Ledger = append(r.res.Ledger, LedgerEntry{Task: att.leaf.task.Id, Attempt: att.id, Volunteer: seg.vol.spec.ID, Start: seg.start, End: seg.start + elapsed})
}

func (r *runState) segmentEnded(seg *segment) {
	att := seg.att
	profile := seg.vol.spec.Profile
	r.endSegment(seg, seg.length)
	att.done += seg.workPlanned
	if att.done >= att.work {
		r.completed(att, profile)
		return
	}
	leaf := att.leaf
	if leaf.canResume && att.checkpoints < leaf.task.Handoff.MaxCheckpoints {
		att.checkpoints++ // lease-end checkpoint keeps all progress
		r.makeResumable(att)
		return
	}
	r.fail(att, FailTimeout)
}

func (r *runState) interrupt(seg *segment, reason string) {
	att := seg.att
	elapsed := r.now - seg.start
	r.endSegment(seg, elapsed)
	leaf := att.leaf
	if !leaf.canResume {
		r.fail(att, reason)
		return
	}
	interval := leaf.task.Handoff.CheckpointIntervalSec
	workElapsed := elapsed - seg.overhead
	if workElapsed < 0 {
		workElapsed = 0
	}
	cp := workElapsed / interval
	if room := leaf.task.Handoff.MaxCheckpoints - att.checkpoints; cp > room {
		cp = room
	}
	att.done += cp * interval
	att.checkpoints += cp
	r.res.HandoffLostSec += workElapsed - cp*interval
	r.makeResumable(att)
}

func (r *runState) makeResumable(att *attempt) {
	att.state = stResumable
	att.interruptedAt = r.now
	att.leaf.waiting++
	r.resumables = append(r.resumables, att)
}

func (r *runState) fail(att *attempt, reason string) {
	att.state = stFailed
	att.leaf.failures++
	r.res.Failed[reason]++
}

func (r *runState) completed(att *attempt, profile string) {
	leaf := att.leaf
	model, ok := leaf.model.Profiles[profile]
	if !ok {
		model = leaf.model.Profiles["default"]
	}
	if r.world.Flaw(leaf.task.Id, profile) < model.FlawProbability {
		r.res.SharedFailures++
		r.sharedGroups[leaf.task.Id+"|"+profile] = true
		r.fail(att, FailSharedFlaw)
		return
	}
	if att.vars.Success >= model.SuccessProbability {
		r.fail(att, FailAgent)
		return
	}
	// Without artifact_variants every successful attempt yields its own
	// artifact; with it, successes draw from a small pool and can repeat.
	variant := att.index
	if variants := leaf.model.ArtifactVariants; variants > 0 {
		variant = int(att.vars.Artifact * float64(variants))
		if variant >= variants {
			variant = variants - 1
		}
	}
	artifact := fmt.Sprintf("%s#%d", leaf.task.Id, variant)
	if _, seen := leaf.submitted[artifact]; seen {
		att.state = stDuplicate
		r.res.Duplicate++
		return
	}
	leaf.submitted[artifact] = "pending"
	leaf.verifying++
	att.state = stQueued
	r.res.CandidatesSubmitted++
	r.verifyQ = append(r.verifyQ, &candidate{att: att, artifact: artifact, variant: variant, enqueuedAt: r.now})
	r.startVerification()
}

func (r *runState) drop(c *candidate) {
	c.att.leaf.verifying--
	c.att.state = stSuperseded
	r.res.Superseded++
}

func (r *runState) stale(c *candidate) bool { return c.att.leaf.solved || c.att.leaf.closed }

func (r *runState) startVerification() {
	for !r.res.Solved && r.verifyBusy < r.sc.Verification.Workers && len(r.verifyQ) > 0 {
		c := r.verifyQ[0]
		r.verifyQ = r.verifyQ[1:]
		if r.stale(c) {
			r.drop(c)
			continue
		}
		r.res.VerifyWait.add(r.now - c.enqueuedAt)
		r.verifyBusy++
		r.push(&event{at: r.now + pick(c.att.vars.VerifySvc, *r.sc.Verification.DurationSec), kind: evVerifyDone, cand: c})
	}
}

func (r *runState) verified(c *candidate) {
	leaf := c.att.leaf
	if r.stale(c) {
		r.drop(c)
		return
	}
	if r.world.ArtifactValidity(leaf.task.Id, c.variant) >= leaf.passProb {
		leaf.submitted[c.artifact] = "rejected"
		leaf.verifying--
		r.fail(c.att, FailVerification)
		return
	}
	if !leaf.needsReview {
		r.accept(c)
		return
	}
	c.enqueuedAt = r.now
	r.reviewQ = append(r.reviewQ, c)
}

func (r *runState) startReview() {
	for !r.res.Solved && r.reviewBusy < r.sc.Review.Reviewers && len(r.reviewQ) > 0 {
		c := r.reviewQ[0]
		r.reviewQ = r.reviewQ[1:]
		if r.stale(c) {
			r.drop(c)
			continue
		}
		r.res.ReviewWait.add(r.now - c.enqueuedAt)
		r.reviewBusy++
		r.push(&event{at: r.now + pick(c.att.vars.ReviewSvc, *r.sc.Review.DurationSec), kind: evReviewDone, cand: c})
	}
}

func (r *runState) reviewed(c *candidate) {
	leaf := c.att.leaf
	if r.stale(c) {
		r.drop(c)
		return
	}
	accept := 1.0
	if r.sc.Review.AcceptProbability != nil {
		accept = *r.sc.Review.AcceptProbability
	}
	if c.att.vars.ReviewAccept >= accept {
		leaf.submitted[c.artifact] = "rejected"
		leaf.verifying--
		r.fail(c.att, FailReview)
		return
	}
	r.accept(c)
}

func (r *runState) accept(c *candidate) {
	leaf := c.att.leaf
	leaf.verifying--
	leaf.submitted[c.artifact] = "accepted"
	c.att.state = stUseful
	r.res.Useful++
	r.markSolved(leaf)
}

// markSolved applies the AND/OR semantics: an OR node is solved by any solved
// child, an AND node only when all children are solved. A solved node closes
// every unsolved branch below it.
func (r *runState) markSolved(n *nstate) {
	n.solved = true
	if len(n.children) == 0 {
		r.cancelLeafWork(n)
	}
	for _, c := range n.children {
		r.closeBranch(c)
	}
	if n == r.root {
		r.res.Solved = true
		r.res.EndReason = "solved"
		r.res.WallSec = r.now
		return
	}
	p := n.parent
	if p.solved {
		return
	}
	switch p.node.Relation {
	case "or":
		r.markSolved(p)
	case "and":
		for _, c := range p.children {
			if !c.solved {
				return
			}
		}
		r.markSolved(p)
	}
}

func (r *runState) closeBranch(n *nstate) {
	if n.solved {
		return
	}
	n.closed = true
	for _, c := range n.children {
		r.closeBranch(c)
	}
	if len(n.children) > 0 {
		return
	}
	r.cancelLeafWork(n)
}

// Stop competing attempts as soon as their leaf is accepted, even when an
// unfinished AND sibling keeps the root open.
func (r *runState) cancelLeafWork(n *nstate) {
	for _, att := range r.attempts {
		if att.leaf != n {
			continue
		}
		switch att.state {
		case stRunning:
			r.endSegment(att.seg, r.now-att.seg.start)
			att.state = stCancelled
		case stResumable:
			n.waiting--
			att.state = stCancelled
		}
	}
	kept := r.resumables[:0]
	for _, att := range r.resumables {
		if att.leaf != n {
			kept = append(kept, att)
		}
	}
	r.resumables = kept
}

// finish settles segments still running at the end, classifies leftovers and
// derives the end reason of an unsolved run.
func (r *runState) finish() {
	for _, att := range r.attempts {
		if att.state == stRunning {
			r.endSegment(att.seg, r.now-att.seg.start)
			att.state = stCancelled
		}
	}
	for _, att := range r.attempts {
		switch att.state {
		case stResumable, stQueued, stCancelled:
			att.state = stCancelled
			r.res.Cancelled++
		}
	}
	r.res.SharedGroups = len(r.sharedGroups)
	if r.res.Solved {
		return
	}
	if r.res.EndReason == "" {
		r.res.EndReason = r.unsolvedReason()
	}
}

func (r *runState) unsolvedReason() string {
	avail := r.available()
	min := int64(-1)
	for _, leaf := range r.leaves {
		if !leaf.solved && !leaf.closed && (min < 0 || leaf.limit < min) {
			min = leaf.limit
		}
	}
	if min < 0 {
		return "stalled"
	}
	if avail < min {
		return "budget_exhausted"
	}
	for _, v := range r.vols {
		if v.online {
			return "stalled"
		}
	}
	return "no_capacity"
}
