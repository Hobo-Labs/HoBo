# Guardrail Policy Gate Contract

POC for HOBO-187. This package pins the event contract for a guardrail
policy-gated AI-output step and the promote-phase four-lens model/prompt gate.

## Proven Behaviors

- A failed guardrail check emits `policy.Decided` and `guardrail.Blocked` as
  replayable events.
- Guardrail checker errors fail closed and never release the output.
- Redact (`mutate`) decisions block the original output until a redacted artifact
  exists outside this contract proof.
- `require-approval` failures create a durable obligation that must be satisfied
  by the matching `policy.ObligationSatisfied` event before release.
- Prompt promotion composes the Contract, Eval, Policy, and Trace lenses.
- A candidate with a better eval score still fails promotion if it regresses
  guardrail coverage in the Contract lens.

## Scope Boundary

This package is intentionally only a contract proof. It does not implement a
guardrail engine, NeMo/MS RAI integration, streaming watermarking, model or
prompt registries, eval scoring, or red-team generation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\guardrail-policy-gate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Guardrail Policy Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
