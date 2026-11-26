# HOBO-315 Compensation Escalation Proof

This proof records the compensation-of-compensation hardening contract for
[Plan 05](../../reliability-observability-cost.md#plan-05).

## Proof Surface

- [Draft package](../../../../src/draft/technical-proofs/compensation-escalation-contract/README.md)
- [Executable checks](../../../../src/draft/technical-proofs/compensation-escalation-contract/test/compensation-escalation.test.ts)

## Proven Constraints

- Failed destroy retries are capped and terminate in `needs-human`, not an infinite loop.
- Escalation includes an exact orphan inventory for unreclaimed and dependency-blocked resources.
- Ambiguous destroy calls run `refresh()` before deciding whether to escalate or mark reclaimed.
- Resumed compensation does not double-destroy resources already recorded as reclaimed.
- Escalation persistence precedes notification, so notifier failure cannot lose the durable state.
- Timeouts, retry storms, and dependency cycles escalate rather than amplifying provider load.

## Scope Boundary

The proof intentionally stops at a contract POC. It does not build the production compensation engine,
provider adapters, SRE remediation applier, spend breaker, or dashboard UI.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\compensation-escalation-contract test
```
