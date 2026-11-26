# HOBO-302 Disaster Recovery Failover Proof

This proof pins disaster recovery from
[Plan 05](../../reliability-observability-cost.md#plan-05) and the Operators/SRE
runbook model from [Plan 40](../../operators-sre.md#plan-40) to the bounded
staleness decision in [ADR-0040](../../adr/01-architecture-core.md#adr-0040)
and the SRE runbook decision in
[ADR-0058](../../adr/03-data-plane.md#adr-0058).

Executable proof:

- package: `src/draft/technical-proofs/disaster-recovery-failover-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\disaster-recovery-failover-contract test`

Acceptance coverage:

- simulated provider-region loss triggers a gated failover remediation.
- the DR drill restores actors and projections from the event log.
- replay reconstructs the restored state from durable runbook and incident
  facts.
- measured RPO/RTO are written to the restore result and postmortem replay.

Adversarial coverage:

- stale original-owner writes are fenced by a higher `fenceToken`.
- lagged async restore surfaces a bounded-staleness RPO window and refuses
  zero-data-loss wording.

Scope boundary:

- replication backbone, real provider region routing, and Cross-Camp topology
  remain out of scope.
