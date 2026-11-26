# Multi-Region DR Replay Contract POC

Independent proof for HOBO-659 (S6-04).

This package pins the multi-region Yard topology, cross-region log replication, and
`hobo yard up --restore <log>` DR-as-replay boundary from Plan 05 and control-plane
bootstrap without implementing production `packages/cloud` runtime code.

## Contract Surface

- `parseMultiRegionTopology(manifest)` — active-passive authoritative log plus
  active-active stateless tier (Gateway, Planner, Executor).
- `assessCrossRegionReplication(log)` — cross-region replication lag with honest RPO
  reporting (≤ 5 s async tier).
- `yardUpRestore(request)` — models `hobo yard up --restore <log>`: replay streams,
  rehydrate actors/projections, measure RTO.
- `replayEventLog(log)` — deterministic event-log replay into projection snapshots.
- `runRegionLossDrill(scenario)` — region-loss acceptance drill (RTO < 15 min, RPO
  ≤ 5 s, byte-identical projections per NFR-008).
- `verifyProjectionIntegrity({ before, after })` — byte-identical snapshot compare.

## Scope Boundaries

Included:

- Multi-region topology manifest parsing (active-passive log + active-active stateless).
- Cross-region replicated log assessment and replay restore command semantics.
- Region-loss DR drill with RTO/RPO/integrity acceptance gates.
- Adversarial guards: excessive RPO lag, RTO breach, projection hash mismatch, corrupt log.

Excluded:

- Production quorum Raft / `runtime-postgres` HA implementation (S6-02).
- Real provider routing, DNS failover, and Junction folding.
- Live `hobo` CLI binary wiring (consumes this contract later).

## Proof

```bash
pnpm --prefix src/draft/technical-proofs/multi-region-dr-replay-contract test
```

## Architecture Evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `src/parse.ts` — parse-don't-validate boundary (`ParsedRestoreRequest`, `ParsedMultiRegionTopology`, `ParsedReplicatedLog`).
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## References

- [reliability-observability-cost.md Plan 05](../../../docs/design/reliability-observability-cost.md#plan-05)
- [control-plane.md Plan 04](../../../docs/design/control-plane.md#plan-04)
- Promoted scenarios: `src/draft/epic-proofs/reliability-observability-cost-finops/`,
  `src/draft/technical-proofs/disaster-recovery-failover-contract/`
