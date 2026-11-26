# HOBO-86 Author-Time Capability Feedback Contract

This draft package proves the author-time feedback seam from
[PLAN-04](../../../../docs/design/control-plane.md#plan-04),
[PLAN-25](../../../../docs/design/platform-engineering.md#plan-25), and
[ADR-0033](../../../../docs/design/adr/01-architecture-core.md#adr-0033).

## Contract Surface

- The same registered provider capability facts used by Matching can be evaluated before deploy.
- A selected provider missing a required capability emits a structured error and a named remediation provider when one exists.
- A selected provider missing a preferred capability emits a warning, not a hard error.
- Preview and experimental capabilities emit stability warnings: pinned, may change, policy may deny.
- Clean stable support emits no advisory findings.
- Findings are machine-consumable through the shared report shape for codegen and `hobo doctor`, while `hobo plan` can render the same report as text.
- A stale author catalog snapshot is advisory only; deploy-time `PlanRejected` remains required and authoritative.

## Proof Boundaries

This proof does not implement the deploy-time `PlanRejected` gate, provider registry storage,
editor/LSP integration, CLI plumbing, or real provider adapters. It pins the advisory author-time
contract that those surfaces consume.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\author-time-capability-feedback-contract test
```

The checks cover required misses with remediation, preview/experimental warnings, clean stable
support, deterministic remediation ordering, prefer-degrade warnings, no-provider fail-closed
remediation, and stale-catalog handling.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Author Time Capability Feedback Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
