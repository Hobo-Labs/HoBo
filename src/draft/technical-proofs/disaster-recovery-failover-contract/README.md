# HOBO-302 Disaster Recovery Failover Contract

This package proves the disaster-recovery orchestration slice for a simulated
provider-region loss. It composes the existing incident aggregate, signed
runbook, gated remediation, and delivery saga contracts instead of introducing a
new runtime.

Executable proof:

- package: `src/draft/technical-proofs/disaster-recovery-failover-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\disaster-recovery-failover-contract test`

Acceptance coverage:

- region loss creates a signed DR runbook execution that selects a gated
  `RemediationAction(kind=failover)`.
- the failover applies through the gated remediation path and restores actors
  and projections from the replicated event log.
- replay rebuilds the restored state from recorded `runbook.*` and
  `incident.*` facts.
- RPO and RTO measurements are recorded on the restore result and postmortem
  replay.

Adversarial coverage:

- a stale primary append racing the new failover owner is rejected by a higher
  `fenceToken`.
- an async replica with lag reports bounded staleness and an unreplicated seq
  window; it does not claim zero data loss.

Scope boundary:

- replication backbone implementation is out of scope.
- Cross-Camp topology and real provider routing are out of scope.
- the package consumes the HOBO-284 gated remediation and HOBO-285 runbook
  execution contracts rather than rebuilding those engines.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Disaster Recovery Failover Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
