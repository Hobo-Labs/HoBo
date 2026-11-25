# HOBO-270 SRE Operator Skeleton Proof

HOBO-270 is proven by the focused POC at
[`src/draft/technical-proofs/sre-operator-skeleton-contract`](../../../../src/draft/technical-proofs/sre-operator-skeleton-contract/README.md).

## Acceptance Evidence

- A simulated `slo.BudgetBurned` signal emits one `crew.AgentDispatched` and one
  `incident.Opened`.
- Multiple correlated `alert.Fired` signals fold into one Incident and later duplicates are
  reported instead of reopening or redispatching.
- `sre.mttd` is emitted as the elapsed seconds from source signal occurrence to dispatch.
- A 100-signal storm with one root cause opens exactly one Incident.
- An unknown signal type produces a warning record and `crew.HandoffRequested` to on-call,
  rather than being silently dropped.
- The built-in SRE principal records the default reasoning engine port and a HolmesGPT adapter
  stub port without invoking a diagnosis engine.

## Scope Boundary

This branch intentionally stops at `signal -> dispatch -> incident.Opened`. It does not implement
diagnosis, classification, remediation proposals, runbook execution, paging, or real HolmesGPT
integration.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\sre-operator-skeleton-contract test
```
