# HOBO-187 Guardrail Policy Gate Proof

This proof records the branch evidence for the M2 guardrail policy-gated step
and four-lens model/prompt promotion gate in
[PLAN-46](../../governance-planes.md#plan-46) and
[PLAN-29](../../contracts-policy-flags.md#plan-29).

## Acceptance Evidence

- `src/draft/technical-proofs/guardrail-policy-gate-contract` emits `policy.Decided` and
  `guardrail.Blocked` for failed guardrail checks, and the blocked state rebuilds
  from the event stream.
- Guardrail checker errors are treated as failures, so the output is blocked
  and `releaseGuardedOutput` returns `released: false`.
- Redact (`mutate`) decisions block the original output rather than releasing it
  before a redacted artifact exists.
- `require-approval` guardrail failures create a durable approval obligation
  keyed to the blocked output. Unrelated or forged approval events do not release
  the output.
- Prompt promotion evaluates the Contract, Eval, Policy, and Trace lenses as one
  promote-phase gate.
- A prompt candidate that improves eval score but removes guardrail coverage is
  denied by the Contract lens and never emits `model.Promoted`.
- Eval-only evidence cannot pass promotion without the other lenses.

## Scope Boundary

This proof intentionally does not implement a guardrail engine, NeMo/MS RAI
adapter, streaming watermark, model/prompt/eval-dataset registry, red-team
runner, or eval-score computation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\guardrail-policy-gate-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
