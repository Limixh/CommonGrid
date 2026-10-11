// Command simulate runs the offline orchestrator simulator: it reads a
// scenario file, a seed and a policy list, and writes a deterministic JSON
// report. It never calls a model, CLI, network service or Docker, and its
// results say nothing about real model success or efficiency.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"commongrid/coordinator/internal/simulation"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("simulate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	scenarioPath := fs.String("scenario", "", "scenario file (required)")
	seed := fs.Int64("seed", 0, "world seed (required)")
	policies := fs.String("policies", strings.Join(simulation.DefaultPolicies(), ","), "comma-separated policies: single, fixed:N, round-robin, least-attempted")
	samples := fs.Int("samples", 0, "sampled worlds per policy (default: the scenario's recommended_samples)")
	outPath := fs.String("out", "", "write the JSON report to this file instead of stdout")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: simulate --scenario FILE --seed N [--policies LIST] [--samples N] [--out FILE]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	seedSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "seed" {
			seedSet = true
		}
	})
	if *scenarioPath == "" || !seedSet || fs.NArg() != 0 || *samples < 0 {
		fs.Usage()
		return 2
	}
	specs, err := simulation.ParsePolicies(strings.Split(*policies, ","))
	if err != nil {
		fmt.Fprintln(stderr, "simulate:", err)
		return 2
	}
	scenario, err := simulation.LoadFile(*scenarioPath)
	if err != nil {
		fmt.Fprintln(stderr, "simulate:", err)
		return 1
	}
	report, err := simulation.Simulate(scenario, simulation.Options{Seed: *seed, Samples: *samples, Policies: specs})
	if err != nil {
		fmt.Fprintln(stderr, "simulate:", err)
		return 1
	}
	out, err := report.JSON()
	if err != nil {
		fmt.Fprintln(stderr, "simulate:", err)
		return 1
	}
	if *outPath == "" {
		if _, err := stdout.Write(out); err != nil {
			fmt.Fprintln(stderr, "simulate:", err)
			return 1
		}
		return 0
	}
	if err := os.WriteFile(*outPath, out, 0o644); err != nil {
		fmt.Fprintln(stderr, "simulate:", err)
		return 1
	}
	return 0
}
