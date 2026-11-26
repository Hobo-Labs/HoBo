# Runbook Contract POC

Independent proof for HOBO-260. It pins the M0 declarative runbook contract before any runbook execution engine, Pipelines internals, StackStorm adapter, or richer DSL exists.

## Contract Surface

- `defineRunbook(name, spec)` / `validateRunbook(spec)` validate the `on -> diagnose -> fix[]` structure.
- Each `fix[].action` is a HOBO-251 `RemediationAction`; unbounded writes fail through the shared blast-radius validator.
- `gate` must be at least as restrictive as the action's derived effect class: `auto < canary-with-auto-rollback < require-approval`.
- Signed/versioned metadata is required before a runbook can load.
- `runbook.Defined`, `runbook.Triggered`, `runbook.StepCompleted`, `runbook.Completed`, and `runbook.Failed` are replayable facts on one runbook stream.

## Scope Boundaries

This POC does not implement the execution engine, Pipelines internals, HolmesGPT/StackStorm adapters, on-call dispatch, or a new authoring DSL. It only proves the contract shape those slices will consume.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\runbook-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Runbook Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
