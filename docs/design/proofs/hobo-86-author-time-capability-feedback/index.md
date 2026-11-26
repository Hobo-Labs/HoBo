# HOBO-86 Author-Time Capability Feedback Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0033](../../adr/01-architecture-core.md#adr-0033).

## Contract Surface

- Static author-time checks read the catalog's registered provider capability facts.
- Missing `require` support produces an error plus deterministic remediation providers.
- Missing `prefer` support produces an advisory warning, not a hard authoring block.
- `preview` and `experimental` support produces stability warnings before deploy.
- Clean stable support produces no findings.
- Findings are machine-consumable for codegen and `hobo doctor`, and renderable for `hobo plan`.
- A stale author catalog snapshot warns while preserving the deploy-time gate as authoritative.

## Proof Boundaries

This is a contract POC. It does not implement the CLI, codegen, doctor, editor integration,
Registry storage, deploy-time Gatekeeper, provider adapters, or the hard `PlanRejected` gate.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\author-time-capability-feedback-contract test
```

The checks prove the issue acceptance and adversarial cases: named remediation, stability-aware
warnings, no-findings clean path, deterministic machine-readable findings, no-provider remediation,
`prefer` behavior, and stale-catalog honesty.
