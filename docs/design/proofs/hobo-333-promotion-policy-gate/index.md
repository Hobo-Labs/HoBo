# HOBO-333 Promotion Policy Gate Proof

This proof records the branch evidence for the M1 generation promotion policy
gate in the [generation pipeline](../../generated-stack.md#the-generation-pipeline).

## Acceptance Evidence

- `src/draft/technical-proofs/generation-promotion-policy-gate-contract` builds a policy request
  with `{ subject, action: "gen.certify", resource, phase: "promote", context }`.
- A low-risk preview fixture with green conformance and eval evidence
  auto-certifies through `policy.Decided` and emits `gen.Certified`.
- A prod/high-risk fixture emits a `createHook` approval path and cannot certify
  until `gen.ApprovalHookResolved` approves it.
- Unknown risk classes fail closed to `require-approval` even when an overbroad
  policy fixture would allow the action.
- Gate decisions replay from `policy.Decided`, `gen.PromotionGateDecided`,
  approval, and certification events.

## Scope Boundary

This proof intentionally does not implement policy-engine internals, approval
delivery UI, registry publishing, SLSA signing, validation, or conformance
suites.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-promotion-policy-gate-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
