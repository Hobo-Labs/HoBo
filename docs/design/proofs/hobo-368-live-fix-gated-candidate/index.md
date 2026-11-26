# HOBO-368 Live-fix gated candidate proof

This proof covers the applier side of self-healing live-fix from
[PLAN-23](../../generated-stack.md#plan-23), [PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-40](../../operators-sre.md#plan-40), and [PLAN-06](../../ai-native-agent-auth.md#plan-06).

The executable contract lives in
`src/draft/technical-proofs/live-fix-gated-candidate-contract` and proves:

- A captured failing trace becomes a permanent regression test.
- A generated candidate must pass sandbox validation, conformance, and failing-trace replay before policy evaluation.
- Low-risk candidates enter a gated canary and auto-roll back on regression.
- Production, destructive, or over-blast-radius candidates require human approval and are not auto-applied.
- The event log can be replayed to recover applied, approval, validation-blocked, and rolled-back outcomes.

Scope deliberately excludes the SRE classifier. This proof starts after the classifier has selected
the live-fix applier path.

## Verification

```powershell
npm.cmd test -- src/draft/technical-proofs/live-fix-gated-candidate-contract/test/live-fix-gated-candidate.test.ts
```
