# Projection Rebuild Contract

Independent POC for HOBO-273. It proves the Plan 32 / ADR-0050 projection
rebuild-from-zero contract for derived sinks:

- large derived projections rebuild from the event log into a new read-model shape;
- interrupted shard rebuilds resume from a checkpoint without restarting or double-applying events;
- snapshot-seeded rebuilds fold only the tail after the snapshot position;
- shard-parallel rebuilds must catch up to live before blue/green cutover;
- non-deterministic vector sinks reject deterministic replay and rebuild through recorded-output
  backfill.

## Scope Boundary

This package does not implement provider sink adapters, a production snapshot primitive,
cross-cloud export/import, the embedding model, or in-place expand/backfill/contract for
authoritative external stores. It is a branch-local executable contract for the derived projection
sink rebuild boundary.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\projection-rebuild-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Projection Rebuild Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
