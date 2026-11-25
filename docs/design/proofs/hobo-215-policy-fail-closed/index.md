# HOBO-215 Policy Fail-Closed Proof

This proof backs [PLAN-29](../../contracts-policy-flags.md#plan-29),
[ADR-0015](../../adr/02-identity-security.md#adr-0015),
[ADR-0023](../../adr/02-identity-security.md#adr-0023), and
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

The executable POC in
[`src/draft/technical-proofs/policy-fail-closed-contract`](../../../../src/draft/technical-proofs/policy-fail-closed-contract)
faults the policy evaluator, Gatekeeper composition, and guardrail/contract
steps without implementing those out-of-scope engines.

## Acceptance Mapping

| Acceptance / adversarial case | Executable proof |
|---|---|
| Evaluator outage denies | `denies when the policy evaluator is unreachable` |
| Ruleset compile failure fails closed | `fails closed when a ruleset cannot compile` |
| Throwing rule denies and is not skipped | `denies when a rule throws and does not skip the rule as pass` |
| Missing gate result blocks verify | `blocks verify composition when a required gate is missing or times out` |
| Partial gate timeout blocks verify | `blocks verify composition when a required gate is missing or times out` |
| Guardrail or contract step error blocks | `blocks when a guardrail or contract step errors` |
| Evaluator-path chaos fault never allows | `never emits allow under evaluator-path chaos faults` |
| Stale cached allow past revocation bound denies | `does not serve a stale cached allow past the revocation bound` |

## Boundary

This is a draft contract proof only. It does not implement the built-in policy
engine, the unified Gatekeeper runtime, the chaos tier, or the full
decision-cache / revocation-propagation hardening from HOBO-200.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\policy-fail-closed-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
