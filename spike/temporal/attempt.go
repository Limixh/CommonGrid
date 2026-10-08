// Package attempt is a fixture-only F0 experiment, disconnected from the API.
// No activity can launch an agent, charge a budget, or accept a production result.
package attempt

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	TaskQueue      = "commongrid-f0-fixtures"
	EventSignal    = "validated-attempt-event"
	StateQuery     = "attempt-state"
	VerifyActivity = "verify-fixture"
)

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Input struct {
	Fixture       bool
	LeaseID       string
	ContractHash  string
	LeaseDuration time.Duration
}

// Event is assumed to have passed coordinator authentication and outbox delivery.
// Matching a hash here is not proof of authorization or artifact validity.
type Event struct {
	ID           string
	Kind         string
	LeaseID      string
	ContractHash string
	CheckpointID string
	ArtifactID   string
}

type State struct {
	Phase          string
	CheckpointID   string
	IgnoredEvents  int
	AcceptedEvents int
}

type VerificationRequest struct {
	LeaseID        string
	ContractHash   string
	ArtifactID     string
	IdempotencyKey string
}

type Verification struct {
	FixtureOnly     bool
	Reused          bool
	ActivityAttempt int32
}

type Result struct {
	State        State
	Verification *Verification
}

func validEvent(event Event, input Input) bool {
	if !identifier.MatchString(event.ID) || event.LeaseID != input.LeaseID || event.ContractHash != input.ContractHash {
		return false
	}
	switch event.Kind {
	case "checkpoint":
		return identifier.MatchString(event.CheckpointID) && event.ArtifactID == ""
	case "result":
		return identifier.MatchString(event.ArtifactID) && event.CheckpointID == ""
	default:
		return false
	}
}

func Attempt(ctx workflow.Context, input Input) (Result, error) {
	if !input.Fixture || !identifier.MatchString(input.LeaseID) || !digest.MatchString(input.ContractHash) || input.LeaseDuration <= 0 || input.LeaseDuration > 24*time.Hour {
		return Result{}, temporal.NewNonRetryableApplicationError("fixture input required", "invalid_input", nil)
	}
	state := State{Phase: "waiting"}
	if err := workflow.SetQueryHandler(ctx, StateQuery, func() (State, error) { return state, nil }); err != nil {
		return Result{}, err
	}
	deadline := workflow.Now(ctx).Add(input.LeaseDuration)
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	defer cancelTimer()
	timer := workflow.NewTimer(timerCtx, input.LeaseDuration)
	events := workflow.GetSignalChannel(ctx, EventSignal)
	seen := make(map[string]bool)
	var selected Event
	for state.Phase == "waiting" {
		selector := workflow.NewSelector(ctx)
		selector.AddFuture(timer, func(workflow.Future) { state.Phase = "expired" })
		selector.AddReceive(events, func(channel workflow.ReceiveChannel, more bool) {
			var event Event
			channel.Receive(ctx, &event)
			if !workflow.Now(ctx).Before(deadline) {
				state.Phase = "expired"
				return
			}
			if !validEvent(event, input) || seen[event.ID] || len(seen) >= 256 {
				state.IgnoredEvents++
				return
			}
			seen[event.ID] = true
			state.AcceptedEvents++
			if event.Kind == "checkpoint" {
				state.CheckpointID = event.CheckpointID
				return
			}
			selected = event
			state.Phase = "verifying"
		})
		selector.Select(ctx)
		if ctx.Err() != nil {
			return Result{State: State{Phase: "cancelled", CheckpointID: state.CheckpointID}}, ctx.Err()
		}
	}
	if state.Phase == "expired" {
		return Result{State: state}, nil
	}
	cancelTimer()
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(input.LeaseID+"\x00"+input.ContractHash+"\x00"+selected.ArtifactID)))
	request := VerificationRequest{LeaseID: input.LeaseID, ContractHash: input.ContractHash, ArtifactID: selected.ArtifactID, IdempotencyKey: key}
	activityCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout:    5 * time.Second,
		ScheduleToCloseTimeout: 30 * time.Second,
		WaitForCancellation:    true,
		RetryPolicy:            &temporal.RetryPolicy{InitialInterval: 100 * time.Millisecond, BackoffCoefficient: 1, MaximumAttempts: 3},
	})
	var verification Verification
	if err := workflow.ExecuteActivity(activityCtx, VerifyActivity, request).Get(ctx, &verification); err != nil {
		if temporal.IsCanceledError(err) || ctx.Err() != nil {
			state.Phase = "cancelled"
			return Result{State: state}, err
		}
		state.Phase = "verification_failed"
		return Result{State: state}, err
	}
	state.Phase = "fixture_verified" // Never a production acceptance or a point award.
	return Result{State: state, Verification: &verification}, nil
}
