# HOBO-148 Domain Cutover Saga Proof

This executable proof pins the staged/canary DNS cutover contract from
[Plan 12](../../security-networking.md#plan-12) and
[ADR-0035](../../adr/07-portability-extensibility.md#adr-0035).

## Contract Surface

- Cutover consumes the HOBO-142 `domain.Validated` result and refuses to mutate
  the live zone without it.
- TTL is lowered and the previous live TTL is waited out before canary traffic
  shifts.
- Canary routing emits `domain.CutoverStarted` and `domain.RoutingChanged`;
  clean health/SLO samples widen the candidate record to 100%.
- Regression emits `domain.RolledBack` and restores the exact last-known-good
  record set, with effective RTO bounded by the previous cached TTL.
- Flapping health remains in canary watch instead of oscillating rollback.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Cutover lowers and waits out TTLs before shifting traffic to a small canary weight. | `clean cutover lowers TTL, waits out old TTL, shifts canary, then widens to 100%` |
| Simulated post-cutover health regression triggers operator-free rollback to last-known-good. | `post-cutover health regression rolls back to the exact last-known-good record` |
| Clean cutover widens to 100% and emits `domain.RoutingChanged`. | `clean cutover lowers TTL, waits out old TTL, shifts canary, then widens to 100%` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Live-zone mutation before the validation gate passes. | `cutover is refused before the domain validation gate passes` |
| Cutover skips TTL lowering and propagation. | `cutover is refused when TTL lowering was not propagated before shifting traffic` |
| Rollback targets a guessed record instead of the last-known-good record set. | `rollback cannot use a guessed last-known-good record` |
| Flapping health repeatedly rolls back and re-enters cutover. | `flapping health stays in canary watch instead of thrashing rollback` |

## Proof Boundaries

This proof does not implement routing-policy selection, failover/weighted/geo
policy realization, the DNS validation gate, concrete provider DNS adapters, or
the Reliability health-signal source.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\domain-cutover-saga-contract test
```

The package is at
[`src/draft/technical-proofs/domain-cutover-saga-contract`](../../../../src/draft/technical-proofs/domain-cutover-saga-contract/README.md).

Full gate used for this proof:

```powershell
npm.cmd --prefix src\draft\technical-proofs\domain-cutover-saga-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
