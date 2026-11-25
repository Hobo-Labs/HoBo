# HOBO-308 Runaway Remediation Guard Proof

This executable proof covers the M3 adversarial hardening required by
[Plan 40](../../operators-sre.md#plan-40),
[Plan 29](../../contracts-policy-flags.md#plan-29),
[ADR-0047](../../adr/02-identity-security.md#adr-0047), and
[ADR-0094](../../adr/02-identity-security.md#adr-0094). It builds on the SRE decision tree,
the Crew event contract, and HOBO-284's gated apply path while keeping policy-engine internals and
new remediation kinds out of scope.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Scripted flapping signal remediates once, detects re-trigger from its own effect, then trips a breaker after K cycles. | `trips a circuit breaker after self-caused flapping without a second apply` applies the first fix, denies the self-caused repeat during cooldown, and escalates on the configured second cycle. |
| After the breaker trips, SRE does not remediate again. | The same test asserts the breaker emits `crew.HandoffRequested`, then a later signal remains `circuit-breaker-open` with no second `crew.ActionApplied`. |
| Per-action rate limits and cooldowns contain repeated writes. | `enforces a per-action cooldown even without explicit self-causation evidence` and `rate-limits repeated action kinds even when idempotency keys change` deny repeated writes inside the guard window. |
| Blast radius never grows across the loop. | `keeps blast radius monotonic across repeated remediation attempts` rejects same-target widening; `does not let a causal loop widen blast radius across targets` rejects causal cross-target widening. |
| Guard decisions are event-sourced. | Each test reuses emitted `policy.Decided` and `crew.*` facts; replay reconstructs final status and applied-action count. |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Two operators fixing each other's symptoms. | `detects two operators fixing each other's symptoms as a causation loop` follows the causal action chain and escalates when it closes back to the first operator. |
| Amplifying fix. | `hard-stops an amplifying fix to A2H` rejects a follow-on signal whose severity or observed blast radius grew after the prior fix. |

## Commands

```powershell
npm.cmd --prefix src\draft\technical-proofs\runaway-remediation-guard-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```
