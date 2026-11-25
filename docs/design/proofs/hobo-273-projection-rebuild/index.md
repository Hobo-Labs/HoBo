# HOBO-273 Projection Rebuild Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32) and
[ADR-0050](../../adr/03-data-plane.md#adr-0050).

The executable POC in
[`src/draft/technical-proofs/projection-rebuild-contract`](../../../../src/draft/technical-proofs/projection-rebuild-contract)
pins the derived projection sink rebuild contract:

- rebuild-from-zero materializes a large event stream into the new read-model shape and records a
  `migration.PhaseApplied` backfill fact;
- checkpoints make an interrupted shard rebuild resumable without restarting from zero or
  double-applying already folded events;
- snapshot-seeded rebuilds resume from the snapshot position and fold only tail events;
- blue/green cutover is refused until the rebuilt sink catches up to the live position;
- non-deterministic vector sinks reject deterministic replay and use recorded-output backfill.

Scope kept out: authoritative-external in-place migration, cross-cloud sink export/import, the
snapshot primitive, provider sink adapters, and embedding model execution.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\projection-rebuild-contract test
```
