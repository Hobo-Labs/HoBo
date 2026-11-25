# SRE Drift Remediation Journey Contract POC

HOBO-216 proof for the SRE path:
out-of-band drift -> `hobo inspect` / `hobo drift` / `hobo logs` -> read-only
diagnosis -> gated remediation -> approval -> idempotent `hobo up`.

## What This Proves

- `resource.DriftDetected` appears in CLI-shaped inspect, drift, and log
  projections.
- The runbook diagnosis consumes only read projections: `tail_logs`, `get_drift`,
  and `slo_status`.
- A production resync opens an approval obligation and does not apply until a
  separate human approves it.
- Approval emits an allow decision, applies through the existing canary
  remediation contract, then `hobo up` reconciles and noops on the second run.
- A low-risk reversible non-prod resync can auto-apply through the same
  rollback-capable canary path.

## Adversarial Coverage

- Unclassifiable incidents create an on-call handoff with a deadline.
- Crew writes outside scoped RBAC or spend caps are denied and audited.
- A failed reconcile gate emits no provisioned resources and no applied set.
- Drift adopted as new desired state is not healed backward.
- The proposing SRE agent cannot approve its own production gate.

## Boundary

This package composes the existing drift remediation, SRE diagnosis, gated
remediation, remediation safety, and `hobo up` convergence contracts. It does
not implement drift detection, the real CLI/MCP servers, runbook engines,
policy services, dashboard approvals, chaos experiments, or drift-heal
internals.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\sre-drift-remediation-journey-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sre Drift Remediation Journey Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
