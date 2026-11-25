# Runbook Execution Engine Contract POC

Independent proof for HOBO-285. This package composes the signed runbook
contract, SRE diagnosis projection, failure-taxonomy classifier, and gated
remediation apply path into the native Pipelines-backed runbook execution seam.

## Contract Surface

- `executeRunbook(...)` validates a `defineRunbook` shape, triggers execution
  for an Incident stream, runs read-only diagnosis, classifies the failure,
  selects one matching `fix`, and dispatches the resulting `RemediationAction`
  through the existing gate.
- `runHoboRunbookExec(...)` models `hobo runbook exec --incident <id>` as a
  replayable wrapper over an incident event store.
- `replayRunbookExecution(...)` rebuilds the terminal runbook state from
  `runbook.*` facts.
- `createStackStormEnginePortStub()` records StackStorm as a mapping-only
  optional engine port behind the native Pipelines engine.

## Proven Behavior

- `high-5xx-on-api` executes end-to-end against a simulated incident.
- a runbook with no matching `fix` escalates through the gated apply path.
- `hobo runbook exec --incident <id>` returns a replayable execution stream.
- a signal matching two taxonomy classes selects one deterministic fix and
  never dispatches both.
- a selected fix that exceeds the blast-radius budget aborts before gate
  dispatch, so there is no partial apply.

## Scope Boundaries

This POC does not implement a richer runbook DSL, HolmesGPT runbooks,
Pipelines engine internals, or a production StackStorm adapter.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\runbook-execution-engine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Runbook Execution Engine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
