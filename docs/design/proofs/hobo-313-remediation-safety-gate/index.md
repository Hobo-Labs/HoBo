# HOBO-313 Remediation Safety Gate Proof

This executable proof covers the M3 adversarial hardening required by
[Plan 40](../../operators-sre.md#plan-40),
[Plan 29](../../contracts-policy-flags.md#plan-29),
[ADR-0074](../../adr/02-identity-security.md#adr-0074), and
[ADR-0094](../../adr/02-identity-security.md#adr-0094). It builds a narrow
pre-apply safety gate around existing `RemediationAction` and Crew event
contracts without changing signal production, RBAC definition, or the gated
remediation apply runtime.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Single uncorroborated signal does not trigger destructive auto-fix; escalates. | `escalates a single uncorroborated destructive signal without applying remediation` emits `require-approval`, denies the proposed action, requests A2H, and emits no `crew.ActionApplied`. |
| Action exceeding operator role is denied with reason. | `denies a remediation action that exceeds the operator role` rejects an operator whose RBAC role has only `remediation:propose`, preserving `rbac-role-missing-remediation-apply`. |
| Over-spend-cap action is denied or held, not applied. | `denies an over-spend-cap remediation before apply` blocks a projected spend-cap breach with `spend-cap-exceeded` and no apply event. |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Forged/replayed signal rejected, not acted on. | `rejects forged and replayed signals without applying remediation` fails closed on invalid SPIFFE provenance, prior `remediationSafety.Decided` signal ids, and replayed action idempotency keys. |
| Operator cannot widen own `.allow()` to authorize action. | `does not let an operator widen its own allow list to authorize remediation` rejects self-authored capability widening before RBAC can make the action appear valid. |
| Near-cap action must not sneak under by splitting into many sub-cap actions. | `aggregates near-cap split remediations so sub-cap actions cannot bypass spend policy` replays prior safety facts in the same scope/window and denies the aggregate breach. |

## Commands

```powershell
npm.cmd --prefix src\draft\technical-proofs\remediation-safety-gate-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```
