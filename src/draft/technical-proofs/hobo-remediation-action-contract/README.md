# Remediation Action Contract POC

Independent POC for HOBO-251. It pins the M0 contract for autonomous Crew write actions before any policy engine, live-fix applier, runbook DSL, or executor exists.

## Contract Surface

- `RemediationAction`: `{ kind, target, blastRadius, environment, idempotencyKey, conformanceState }`.
- `BlastRadius`: `{ scope, reversible, compensationPath?, estimatedImpact }`.
- Contract artifacts:
  - `wit/remediation-action.wit`
  - `schema/remediation-action.zod.ts`
  - `schema/remediation-action.v1.schema.json`
- Effect-class classifier:
  - low-risk + reversible + non-prod + conformance-green -> `auto`
  - medium-risk + reversible + non-prod + conformance-green -> `canary-with-auto-rollback`
  - prod, irreversible, high-impact, unknown environment, unknown action kind, or non-green conformance -> `require-approval`
- Event proof: `crew.ActionProposed` carries the action, blast radius, and policy effect class.

## Scope Boundaries

This POC intentionally does not implement the policy engine, obligation execution, live-fix applier, runbook DSL, agent reasoning, or any real mutation path.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-remediation-action-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Remediation Action Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
