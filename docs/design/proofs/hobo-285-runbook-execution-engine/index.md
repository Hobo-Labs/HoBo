# HOBO-285 Runbook Execution Engine Proof

This proof pins the native runbook execution seam from
[Plan 40](../../operators-sre.md#plan-40) to the Pipelines engine intent in
[Plan 25](../../platform-engineering.md#plan-25), reusing the event-sourced SRE
model from [ADR-0058](../../adr/03-data-plane.md#adr-0058).

Executable proof:

- package: `src/draft/technical-proofs/runbook-execution-engine-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\runbook-execution-engine-contract test`

Acceptance coverage:

- `high-5xx-on-api` executes end-to-end against a simulated Incident.
- a runbook with no matching `fix` escalates through gated remediation.
- `hobo runbook exec --incident <id>` is replayable from `runbook.*` facts.

Adversarial coverage:

- a signal matching two taxonomy classes selects one deterministic fix and
  dispatches exactly one `RemediationAction`.
- a fix exceeding the blast-radius budget records `runbook.Failed` before gate
  dispatch, with no Crew apply/propose facts and no gateway command.

Scope boundary:

- richer authoring DSLs, HolmesGPT runbooks, Pipelines internals, and the real
  StackStorm adapter remain out of scope.
