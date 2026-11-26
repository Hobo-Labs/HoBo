# HOBO-316 DR Failover Integrity Proof

This proof records the DR failover integrity hardening for
[Plan 05](../../reliability-observability-cost.md#plan-05) and the Operators/SRE
DR runbook path in [Plan 40](../../operators-sre.md#plan-40).

## Proof Surface

- [Draft package](../../../../src/draft/technical-proofs/dr-failover-integrity-contract/README.md)
- [Executable checks](../../../../src/draft/technical-proofs/dr-failover-integrity-contract/test/dr-failover-integrity.test.ts)

## Proven Constraints

- A stale original owner cannot commit with a lower `fenceToken` after failover.
- Async restore reports bounded-staleness RPO and an unreplicated sequence window.
- From-zero replay yields one restored owner and one state head.
- Interrupted failover resumes from checkpointed steps without double-applying the fence.

## Scope Boundary

The proof stays at the contract layer. It does not build replication transport,
provider-region routing, bootstrap internals, or the production DR engine.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\dr-failover-integrity-contract test
```
