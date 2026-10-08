package verification

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"commongrid/coordinator/internal/artifact"
	"commongrid/coordinator/internal/catalog"
	"commongrid/coordinator/internal/contract"
	"commongrid/coordinator/internal/store"
)

type fixtureRepo struct {
	Repository
	task             contract.TaskContract
	record           store.ArtifactRecord
	claim            store.VerificationClaim
	checkpoint       store.CheckpointVerificationClaim
	claims, verdicts int
	result           store.VerificationResult
	cpResult         store.CheckpointVerificationVerdict
}

func (r *fixtureRepo) Task(context.Context, string) (store.TaskRecord, error) {
	return store.TaskRecord{Contract: r.task}, nil
}
func (r *fixtureRepo) ArtifactForSubmission(context.Context, string) (store.ArtifactRecord, error) {
	return r.record, nil
}
func (r *fixtureRepo) ArtifactForCheckpoint(context.Context, string) (store.ArtifactRecord, error) {
	return r.record, nil
}
func (r *fixtureRepo) ClaimVerification(context.Context, string, time.Duration) (store.VerificationClaim, error) {
	r.claims++
	return r.claim, nil
}
func (r *fixtureRepo) ClaimCheckpointVerification(context.Context, string, time.Duration) (store.CheckpointVerificationClaim, error) {
	r.claims++
	return r.checkpoint, nil
}
func (r *fixtureRepo) CompleteVerification(_ context.Context, _ store.VerificationClaim, result store.VerificationResult) (store.Submission, error) {
	r.verdicts++
	r.result = result
	return store.Submission{ID: "submission"}, nil
}
func (r *fixtureRepo) FinishCheckpointVerification(_ context.Context, result store.CheckpointVerificationVerdict) (store.CheckpointRecord, error) {
	r.verdicts++
	r.cpResult = result
	return store.CheckpointRecord{Status: result.Status}, nil
}

type readerFunc func(context.Context, string, string, int64) ([]byte, error)

func (f readerFunc) Read(c context.Context, id, sha string, size int64) ([]byte, error) {
	return f(c, id, sha, size)
}

type scannerFunc func(context.Context, *artifact.Bundle) error

func (f scannerFunc) Scan(c context.Context, b *artifact.Bundle) error { return f(c, b) }

type harnessFunc func(context.Context, Request) (Outcome, error)

func (f harnessFunc) Verify(c context.Context, r Request) (Outcome, error) { return f(c, r) }

type resolverFunc func(contract.TaskContract, string) (Harness, error)

func (f resolverFunc) Resolve(t contract.TaskContract, p string) (Harness, error) { return f(t, p) }

type workerFixture struct {
	repo                *fixtureRepo
	raw                 []byte
	scanner             Scanner
	harness             Harness
	resolver            Resolver
	reader              Reader
	reads, harnessCalls int
}

func newFixture(t *testing.T, purpose string) *workerFixture {
	t.Helper()
	tasks, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	task := tasks.Tasks[1]
	binding := artifact.Binding{Purpose: purpose, TaskID: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, LeaseID: "fixture-lease", BaseCommit: task.Workspace.Commit, StrategyID: task.Strategies[0].Id}
	raw, err := artifact.Encode(binding, map[string][]byte{"src/search.ts": []byte("export const fixtureValue = 7;\n")})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	ref := store.ArtifactRef{ID: "artifact-0123456789abcdef0123456789abcdef", SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(raw))}
	f := &workerFixture{raw: raw, repo: &fixtureRepo{task: task, record: store.ArtifactRecord{ArtifactRegistration: store.ArtifactRegistration{UserID: "fixture-user", LeaseID: binding.LeaseID, TaskID: binding.TaskID, TaskVersion: binding.TaskVersion, ContractHash: binding.ContractHash, BaseCommit: binding.BaseCommit, StrategyID: binding.StrategyID, Purpose: purpose, ScanPolicy: "trusted-fixture", ScanPolicyVersion: "v1", Artifact: ref}, State: "ready"}}}
	f.repo.claim = store.VerificationClaim{SubmissionID: "submission", Token: "fixture-token", Until: time.Now().Add(time.Minute), TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, Artifact: ref}
	f.repo.checkpoint = store.CheckpointVerificationClaim{Checkpoint: store.CheckpointRecord{Metadata: contract.Checkpoint{CheckpointId: "checkpoint", TaskId: task.Id, TaskVersion: task.TaskVersion, ContractHash: task.ContractHash, LeaseId: binding.LeaseID, BaseCommit: binding.BaseCommit, Type: "hard", ArtifactSha256: ref.SHA256}, Artifact: ref}, Token: "fixture-token", Deadline: time.Now().Add(time.Minute)}
	f.reader = readerFunc(func(context.Context, string, string, int64) ([]byte, error) {
		f.reads++
		return bytes.Clone(f.raw), nil
	})
	f.scanner = scannerFunc(func(context.Context, *artifact.Bundle) error { return nil })
	f.harness = harnessFunc(func(_ context.Context, r Request) (Outcome, error) {
		f.harnessCalls++
		return Outcome{Pass: true, CheckedSHA256: r.ArtifactSHA256}, nil
	})
	f.resolver = resolverFunc(func(contract.TaskContract, string) (Harness, error) { return f.harness, nil })
	return f
}
func (f *workerFixture) worker(t *testing.T) *Worker {
	t.Helper()
	w, err := New(f.repo, f.reader, f.scanner, f.resolver, Config{ScanPolicy: "trusted-fixture", ScanPolicyVersion: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func TestVerificationUnavailableOrStaleAuthorityNeverClaims(t *testing.T) {
	cases := map[string]func(*workerFixture){
		"pending":      func(f *workerFixture) { f.repo.record.State = "pending" },
		"policy":       func(f *workerFixture) { f.repo.record.ScanPolicyVersion = "v2" },
		"task-version": func(f *workerFixture) { f.repo.task.TaskVersion++ },
		"base":         func(f *workerFixture) { f.repo.record.BaseCommit = "foreign" },
		"purpose":      func(f *workerFixture) { f.repo.record.Purpose = "checkpoint" },
		"resolver-unavailable": func(f *workerFixture) {
			f.resolver = resolverFunc(func(contract.TaskContract, string) (Harness, error) { return nil, errors.New("PRIVATE_DETAIL") })
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, "result")
			change(f)
			_, err := f.worker(t).Submission(context.Background(), "submission")
			if err == nil || f.repo.claims != 0 || f.reads != 0 || f.repo.verdicts != 0 {
				t.Fatal("invalid authority advanced", err)
			}
		})
	}
	f := newFixture(t, "result")
	var absent scannerFunc
	if _, err := New(f.repo, f.reader, absent, f.resolver, Config{ScanPolicy: "p", ScanPolicyVersion: "v1"}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("typed nil scanner accepted")
	}
}

func TestVerificationFailedChecksNeverWriteVerdict(t *testing.T) {
	cases := map[string]func(*workerFixture){
		"archive-digest": func(f *workerFixture) { f.raw[len(f.raw)-1] ^= 1 },
		"archive-size":   func(f *workerFixture) { f.raw = append(f.raw, 0) },
		"claim-digest":   func(f *workerFixture) { f.repo.claim.Artifact.SHA256 = "foreign" },
		"expired":        func(f *workerFixture) { f.repo.claim.Until = time.Now().Add(-time.Second) },
		"reader-error": func(f *workerFixture) {
			f.reader = readerFunc(func(context.Context, string, string, int64) ([]byte, error) { return nil, errors.New("PRIVATE_DETAIL") })
		},
		"scanner-error": func(f *workerFixture) {
			f.scanner = scannerFunc(func(context.Context, *artifact.Bundle) error { return errors.New("PRIVATE_DETAIL") })
		},
		"harness-error": func(f *workerFixture) {
			f.harness = harnessFunc(func(context.Context, Request) (Outcome, error) { return Outcome{}, errors.New("PRIVATE_DETAIL") })
		},
		"unchecked-digest": func(f *workerFixture) {
			f.harness = harnessFunc(func(context.Context, Request) (Outcome, error) {
				return Outcome{Pass: true, CheckedSHA256: "foreign"}, nil
			})
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, "result")
			change(f)
			_, err := f.worker(t).Submission(context.Background(), "submission")
			if err == nil || f.repo.verdicts != 0 {
				t.Fatal("invalid verification persisted verdict", err)
			}
			if err.Error() == "PRIVATE_DETAIL" {
				t.Fatal("dependency detail exposed")
			}
		})
	}
}

func TestVerificationRescansButHarnessUsesOriginalBytes(t *testing.T) {
	f := newFixture(t, "result")
	f.scanner = scannerFunc(func(_ context.Context, b *artifact.Bundle) error {
		b.Files[0].Bytes[0] = 'X'
		b.TaskID = "mutated"
		return nil
	})
	f.harness = harnessFunc(func(_ context.Context, r Request) (Outcome, error) {
		if len(r.Bundle.Files) != 1 || string(r.Bundle.Files[0].Bytes) != "export const fixtureValue = 7;\n" || r.Bundle.TaskID != f.repo.task.Id {
			t.Fatal("scanner changed immutable harness input")
		}
		return Outcome{Pass: true, CheckedSHA256: r.ArtifactSHA256}, nil
	})
	if _, err := f.worker(t).Submission(context.Background(), "submission"); err != nil || f.repo.verdicts != 1 || !f.repo.result.Pass || f.repo.result.ArtifactSHA256 != f.repo.record.Artifact.SHA256 {
		t.Fatal("valid verdict missing", err)
	}
}

func TestVerificationNegativeAndCheckpointVerdictsStayBound(t *testing.T) {
	for _, purpose := range []string{"result", "checkpoint"} {
		t.Run(purpose, func(t *testing.T) {
			f := newFixture(t, purpose)
			f.harness = harnessFunc(func(_ context.Context, r Request) (Outcome, error) {
				return Outcome{Pass: false, CheckedSHA256: r.ArtifactSHA256}, nil
			})
			w := f.worker(t)
			var err error
			if purpose == "result" {
				_, err = w.Submission(context.Background(), "submission")
			} else {
				_, err = w.Checkpoint(context.Background(), "checkpoint")
			}
			if err != nil || f.repo.verdicts != 1 {
				t.Fatal("negative verdict missing", err)
			}
			if purpose == "result" && f.repo.result.Pass {
				t.Fatal("negative result passed")
			}
			if purpose == "checkpoint" && (f.repo.cpResult.Status != "rejected" || f.repo.cpResult.ReasonCode != "quick_check_failed" || f.repo.cpResult.ArtifactSHA256 != f.repo.record.Artifact.SHA256) {
				t.Fatal("checkpoint rejection unbound")
			}
		})
	}
	f := newFixture(t, "checkpoint")
	f.repo.checkpoint.Checkpoint.Metadata.LeaseId = "foreign"
	if _, err := f.worker(t).Checkpoint(context.Background(), "checkpoint"); err == nil || f.repo.verdicts != 0 || f.reads != 0 {
		t.Fatal("checkpoint fence bypassed", err)
	}
}

func TestVerificationCancellationDuringHarnessNeverWritesVerdict(t *testing.T) {
	f := newFixture(t, "result")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.harness = harnessFunc(func(_ context.Context, r Request) (Outcome, error) {
		cancel()
		return Outcome{Pass: true, CheckedSHA256: r.ArtifactSHA256}, nil
	})
	if _, err := f.worker(t).Submission(ctx, "submission"); !errors.Is(err, context.Canceled) || f.repo.verdicts != 0 {
		t.Fatal("cancelled verdict written", err)
	}
}
