// recovery runs a real local Temporal server/worker interruption experiment.
// All processes, workflows and verification artifacts belong to this fixture run.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	attempt "commongrid/spike/temporal"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
)

type silentLog struct{}

func (silentLog) Debug(string, ...interface{}) {}
func (silentLog) Info(string, ...interface{})  {}
func (silentLog) Warn(string, ...interface{})  {}
func (silentLog) Error(string, ...interface{}) {}

type process struct {
	command *exec.Cmd
	done    chan error
	output  *os.File
}

func launch(logPath, binary string, args ...string) (*process, error) {
	output, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(binary, args...)
	cmd.Stdout = output
	cmd.Stderr = output
	if err = cmd.Start(); err != nil {
		output.Close()
		return nil, err
	}
	p := &process{command: cmd, done: make(chan error, 1), output: output}
	go func() { p.done <- cmd.Wait() }()
	return p, nil
}
func (p *process) stop() error {
	if p == nil {
		return nil
	}
	select {
	case <-p.done:
		return p.output.Close()
	default:
	}
	if err := p.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	select {
	case <-p.done:
		return p.output.Close()
	case <-time.After(10 * time.Second):
		return fmt.Errorf("owned process did not stop")
	}
}

func connect(address string) (client.Client, error) {
	deadline := time.Now().Add(30 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		c, err := client.DialContext(ctx, client.Options{HostPort: address, Logger: silentLog{}})
		cancel()
		if err == nil {
			return c, nil
		}
		last = err
		time.Sleep(200 * time.Millisecond)
	}
	return nil, fmt.Errorf("local Temporal startup: %w", last)
}

func waitState(c client.Client, id string, predicate func(attempt.State) bool) (attempt.State, error) {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		value, err := c.QueryWorkflow(ctx, id, "", attempt.StateQuery)
		cancel()
		if err == nil {
			var state attempt.State
			if err = value.Get(&state); err != nil {
				return state, err
			}
			if predicate(state) {
				return state, nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return attempt.State{}, fmt.Errorf("workflow state timeout: %s", id)
}

func runWorker(address, ledger string) error {
	c, err := connect(address)
	if err != nil {
		return err
	}
	defer c.Close()
	w := worker.New(c, attempt.TaskQueue, worker.Options{MaxConcurrentActivityExecutionSize: 2})
	w.RegisterWorkflow(attempt.Attempt)
	v := &attempt.FixtureVerifier{Dir: ledger}
	w.RegisterActivityWithOptions(v.Verify, activity.RegisterOptions{Name: attempt.VerifyActivity})
	return w.Run(worker.InterruptCh())
}

func runRecovery(serverBinary, base string) error {
	if serverBinary == "" || base == "" {
		return fmt.Errorf("server-binary and state-dir required")
	}
	if err := os.MkdirAll(base, 0700); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(base, "run-")
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	address := listener.Addr().String()
	port := fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
	listener.Close()
	database := filepath.Join(dir, "temporal.sqlite")
	ledger := filepath.Join(dir, "fixture-ledger")
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	var server, workerProcess *process
	defer func() {
		if workerProcess != nil {
			workerProcess.stop()
		}
		if server != nil {
			server.stop()
		}
	}()
	startServer := func() error {
		var err error
		server, err = launch(filepath.Join(dir, "server.log"), serverBinary, "server", "start-dev", "--ip", "127.0.0.1", "--port", port, "--headless", "--db-filename", database)
		return err
	}
	startWorker := func() error {
		var err error
		workerProcess, err = launch(filepath.Join(dir, "worker.log"), executable, "--worker", "--address", address, "--ledger", ledger)
		return err
	}
	if err = startServer(); err != nil {
		return err
	}
	c, err := connect(address)
	if err != nil {
		return fmt.Errorf("%w (logs: %s)", err, dir)
	}
	defer func() {
		if c != nil {
			c.Close()
		}
	}()
	if err = startWorker(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	input := attempt.Input{Fixture: true, LeaseID: "fixture-lease", ContractHash: strings.Repeat("a", 64), LeaseDuration: 2 * time.Minute}
	workflowID := "fixture-recovery"
	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: workflowID, TaskQueue: attempt.TaskQueue}, attempt.Attempt, input)
	if err != nil {
		return err
	}
	if _, err = waitState(c, workflowID, func(s attempt.State) bool { return s.Phase == "waiting" }); err != nil {
		return err
	}
	event := attempt.Event{ID: "cp-1", Kind: "checkpoint", LeaseID: input.LeaseID, ContractHash: input.ContractHash, CheckpointID: "fixture-checkpoint"}
	if err = c.SignalWorkflow(ctx, workflowID, run.GetRunID(), attempt.EventSignal, event); err != nil {
		return err
	}
	if _, err = waitState(c, workflowID, func(s attempt.State) bool { return s.CheckpointID == event.CheckpointID }); err != nil {
		return err
	}
	if err = workerProcess.stop(); err != nil {
		return err
	}
	workerProcess = nil
	c.Close()
	if err = server.stop(); err != nil {
		return err
	}
	server = nil
	fmt.Println("Recorded checkpoint; killed owned worker and server")
	if err = startServer(); err != nil {
		return err
	}
	c, err = connect(address)
	if err != nil {
		return err
	}
	if err = startWorker(); err != nil {
		return err
	}
	recovered, err := waitState(c, workflowID, func(s attempt.State) bool { return s.CheckpointID == "fixture-checkpoint" && s.Phase == "waiting" })
	if err != nil {
		return err
	}
	stale := attempt.Event{ID: "stale", Kind: "result", LeaseID: input.LeaseID, ContractHash: strings.Repeat("b", 64), ArtifactID: "fixture-artifact"}
	if err = c.SignalWorkflow(ctx, workflowID, run.GetRunID(), attempt.EventSignal, stale); err != nil {
		return err
	}
	if _, err = waitState(c, workflowID, func(s attempt.State) bool { return s.IgnoredEvents == 1 }); err != nil {
		return err
	}
	resultEvent := stale
	resultEvent.ID = "result-1"
	resultEvent.ContractHash = input.ContractHash
	if err = c.SignalWorkflow(ctx, workflowID, run.GetRunID(), attempt.EventSignal, resultEvent); err != nil {
		return err
	}
	var result attempt.Result
	if err = c.GetWorkflow(ctx, workflowID, run.GetRunID()).Get(ctx, &result); err != nil {
		return err
	}
	if result.State.Phase != "fixture_verified" || result.Verification == nil || !result.Verification.Reused || result.Verification.ActivityAttempt != 2 {
		return fmt.Errorf("retry/recovery assertion failed: %+v", result)
	}
	markers, err := filepath.Glob(filepath.Join(ledger, "*.json"))
	if err != nil {
		return err
	}
	if len(markers) != 1 {
		return fmt.Errorf("expected one fixture effect, got %d", len(markers))
	}
	expiry := input
	expiry.LeaseDuration = 500 * time.Millisecond
	expiredRun, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: "fixture-expiry", TaskQueue: attempt.TaskQueue}, attempt.Attempt, expiry)
	if err != nil {
		return err
	}
	var expired attempt.Result
	if err = expiredRun.Get(ctx, &expired); err != nil {
		return err
	}
	if expired.State.Phase != "expired" || expired.Verification != nil {
		return fmt.Errorf("deadline assertion failed")
	}
	cancelledRun, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: "fixture-cancel", TaskQueue: attempt.TaskQueue}, attempt.Attempt, input)
	if err != nil {
		return err
	}
	if _, err = waitState(c, "fixture-cancel", func(s attempt.State) bool { return s.Phase == "waiting" }); err != nil {
		return err
	}
	if err = c.CancelWorkflow(ctx, "fixture-cancel", cancelledRun.GetRunID()); err != nil {
		return err
	}
	if err = cancelledRun.Get(ctx, nil); !temporal.IsCanceledError(err) {
		return fmt.Errorf("expected cancelled workflow, got %v", err)
	}
	if err = workerProcess.stop(); err != nil {
		return err
	}
	workerProcess = nil
	if err = server.stop(); err != nil {
		return err
	}
	server = nil
	report := map[string]interface{}{
		"checked_at": time.Now().UTC().Format(time.RFC3339), "fixture_only": true, "production_ready": false,
		"workflow_id": workflowID, "run_id": run.GetRunID(), "recovered_state": recovered, "result": result,
		"checks":        map[string]bool{"server_and_worker_restart": true, "checkpoint_replayed": true, "stale_event_rejected": true, "activity_retry_after_effect": true, "one_fixture_effect": true, "deadline": true, "cancellation": true},
		"cli_execution": false, "limitations": []string{"SQLite development server, not production HA", "fixture file ledger, not PostgreSQL outbox or job reconciliation", "no agent, account, sandbox or real artifact verification"},
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(dir, "report.json"), append(encoded, '\n'), 0600); err != nil {
		return err
	}
	fmt.Printf("PASS: recovery, retry, stale event, deadline and cancellation\nReport: %s\n", filepath.Join(dir, "report.json"))
	return nil
}

func main() {
	workerMode := flag.Bool("worker", false, "run fixture worker")
	address := flag.String("address", "127.0.0.1:7233", "local server")
	ledger := flag.String("ledger", "", "fixture ledger directory")
	serverBinary := flag.String("server-binary", "", "pinned dev server binary")
	stateDir := flag.String("state-dir", "", "experiment report directory")
	flag.Parse()
	var err error
	if *workerMode {
		err = runWorker(*address, *ledger)
	} else {
		err = runRecovery(*serverBinary, *stateDir)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
