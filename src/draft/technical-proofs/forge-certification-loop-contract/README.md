# Forge Certification Loop Contract POC

Independent POC for HOBO-649 (S5-04). It pins the Forge certification loop from
Plan 23 (`docs/design/generated-stack.md#plan-23`): run candidate providers
inside the S2-07 no-egress executor sandbox against per-interface conformance
suites (S5-02 shape), feed validation failures into a bounded repair cycle,
and event-source every validate/repair/gate step.

## Contract

- `runForgeCertificationLoop()` requires a validated `hobo.sandbox.profile/v1`
  (Firecracker microvm, `network.mode = "none"`) and at least one
  per-interface conformance suite reference.
- Sandbox validation runs through injected `validateInSandbox` doubles so the
  POC proves loop shape without a real Firecracker runner.
- Repairable validation failures emit `gen.ValidationFailed` then `gen.Repaired`
  until convergence or budget exhaustion (`gen.NeedsHuman`).
- Converged candidates pass `runCertificationGate()` before `gen.Certified`:
  forged conformance attachments are refused by in-boundary digest mismatch, and
  undeclared egress is refused from `sandbox.EscapeAttemptBlocked` evidence.
- Adversarial refusals emit `gen.SafetyRejected` plus auditable
  `conformance.ReportRejected` / `sandbox.EgressDenied` records.
- `replayForgeCertificationRun()` delegates to the generation event replay
  contract so the full stream rebuilds from events.

## Acceptance Mapping

| Acceptance / adversarial case | Executable proof |
|---|---|
| Seeded-defect candidate repairs to green certification. | `Given seeded-defect candidate When bounded repair converges Then certification emits replayable gen events` |
| Forged conformance report refused with audit evidence. | `Given forged conformance attachment When gate reruns in sandbox Then certification is refused with audit evidence` |
| Matching-digest forged pass refused when in-boundary rerun fails. | `Given forged pass digest When in-boundary sandbox rerun fails Then certification is refused with audit evidence` |
| Undeclared egress refused with auditable evidence. | `Given undeclared egress attempt When sandbox blocks escape Then certification is refused with auditable evidence` |
| Bounded repair budget enforced. | `Given oscillating repair When budget exhausts Then one gen.NeedsHuman is emitted` |

## Scope Boundaries

This POC does not implement Forge ingestion (S5-03), real executor sandbox
runtime, signing/registry publish (S5-05), or the full S5-02 coverage report
gate. It composes the existing no-egress sandbox, generation IO, and repair-loop
contracts into one certification orchestrator with adversarial gate checks.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/forge-certification-loop-contract
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Forge Certification Loop Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
