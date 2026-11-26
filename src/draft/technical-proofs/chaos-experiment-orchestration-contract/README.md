# Chaos Experiment Orchestration Contract

This draft POC proves HOBO-298's chaos orchestration boundary without building any external chaos
engine. It models the event-sourced contract for policy-gated, blast-radius-bounded experiments.

## Contract

- `orchestrateChaosExperiment(input)` evaluates the policy budget, chooses a sandbox lane or
  ephemeral Camp clone, injects a declared fault through a stub injector, records `chaos.*` events,
  and aborts on steady-state breach.
- `replayChaosExperiment(events)` rebuilds the terminal status and regression-test references from
  the event stream.

## Scope

In scope:

- `chaos.ExperimentStarted`, `chaos.FaultInjected`, `chaos.SteadyStateChecked`,
  `chaos.Aborted`, and `chaos.ExperimentCompleted` facts.
- prod chaos policy-budget denial before any fault injection.
- shared-lane admission checks for baseline leases and non-lane-tagged egress.
- failed experiment to replayable regression-test handoff.

Out of scope:

- Chaos Mesh, Litmus, FIS, or other external engine adapters.
- dashboard UI and red-team experiments.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\chaos-experiment-orchestration-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Chaos Experiment Orchestration Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
