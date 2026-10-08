package attempt

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

func fixtureInput() Input {
	return Input{Fixture: true, LeaseID: "lease-fixture", ContractHash: strings.Repeat("a", 64), LeaseDuration: time.Minute}
}
func fixtureEvent(id, kind string) Event {
	event := Event{ID: id, Kind: kind, LeaseID: fixtureInput().LeaseID, ContractHash: fixtureInput().ContractHash}
	if kind == "checkpoint" {
		event.CheckpointID = "checkpoint-fixture"
	} else {
		event.ArtifactID = "artifact-fixture"
	}
	return event
}

func TestCheckpointAndStaleEvents(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	verifier := &FixtureVerifier{Dir: t.TempDir()}
	env.RegisterActivityWithOptions(verifier.Verify, activity.RegisterOptions{Name: VerifyActivity})
	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow(EventSignal, fixtureEvent("cp-1", "checkpoint"))
		env.SignalWorkflow(EventSignal, fixtureEvent("cp-1", "checkpoint"))
		stale := fixtureEvent("stale", "result")
		stale.ContractHash = strings.Repeat("b", 64)
		env.SignalWorkflow(EventSignal, stale)
		other := fixtureEvent("other", "result")
		other.LeaseID = "different-lease"
		env.SignalWorkflow(EventSignal, other)
		invalid := fixtureEvent("invalid", "result")
		invalid.ArtifactID = "../auth"
		env.SignalWorkflow(EventSignal, invalid)
	}, time.Second)
	env.RegisterDelayedCallback(func() { env.SignalWorkflow(EventSignal, fixtureEvent("result-1", "result")) }, 2*time.Second)
	env.ExecuteWorkflow(Attempt, fixtureInput())
	require.NoError(t, env.GetWorkflowError())
	var result Result
	require.NoError(t, env.GetWorkflowResult(&result))
	require.Equal(t, "fixture_verified", result.State.Phase)
	require.Equal(t, "checkpoint-fixture", result.State.CheckpointID)
	require.Equal(t, 4, result.State.IgnoredEvents)
	require.Equal(t, 2, result.State.AcceptedEvents)
	require.True(t, result.Verification.Reused)
	require.EqualValues(t, 2, result.Verification.ActivityAttempt)
}

func TestDeadlineDoesNotLaunchVerification(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.ExecuteWorkflow(Attempt, fixtureInput())
	require.NoError(t, env.GetWorkflowError())
	var result Result
	require.NoError(t, env.GetWorkflowResult(&result))
	require.Equal(t, "expired", result.State.Phase)
	require.Nil(t, result.Verification)
}

func TestCancellationWhileWaiting(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterDelayedCallback(env.CancelWorkflow, time.Second)
	env.ExecuteWorkflow(Attempt, fixtureInput())
	require.True(t, temporal.IsCanceledError(env.GetWorkflowError()))
}

func TestProductionInputRejected(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	input := fixtureInput()
	input.Fixture = false
	env.ExecuteWorkflow(Attempt, input)
	require.Error(t, env.GetWorkflowError())
}

func TestPermanentVerificationFailureIsNotRetried(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	calls := 0
	env.RegisterActivityWithOptions(func(context.Context, VerificationRequest) (Verification, error) {
		calls++
		return Verification{}, temporal.NewNonRetryableApplicationError("fixture rejected", "rejected", nil)
	}, activity.RegisterOptions{Name: VerifyActivity})
	env.RegisterDelayedCallback(func() { env.SignalWorkflow(EventSignal, fixtureEvent("result-1", "result")) }, time.Second)
	env.ExecuteWorkflow(Attempt, fixtureInput())
	require.Error(t, env.GetWorkflowError())
	require.Equal(t, 1, calls)
}

func TestRepeatedResultDoesNotVerifyTwice(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	calls := 0
	env.RegisterActivityWithOptions(func(context.Context, VerificationRequest) (Verification, error) {
		calls++
		return Verification{FixtureOnly: true}, nil
	}, activity.RegisterOptions{Name: VerifyActivity})
	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow(EventSignal, fixtureEvent("result-1", "result"))
		env.SignalWorkflow(EventSignal, fixtureEvent("result-1", "result"))
		env.SignalWorkflow(EventSignal, fixtureEvent("result-2", "result"))
	}, time.Second)
	env.ExecuteWorkflow(Attempt, fixtureInput())
	require.NoError(t, env.GetWorkflowError())
	require.Equal(t, 1, calls)
}
