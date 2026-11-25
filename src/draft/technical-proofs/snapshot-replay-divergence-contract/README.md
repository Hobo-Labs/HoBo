# Snapshot Replay Divergence Contract

Independent proof package for HOBO-283. It stress-tests the adversarial layer above the HOBO-60 replay/live helper, HOBO-57 upcaster gate, and HOBO-240 snapshot lifecycle contract.

## Contract Surface

- `createSnapshot(...)` signs a fold result with the current fold version, upcaster version, erasure-key epoch, event-prefix digest, and quarantine digest.
- `activateFromSnapshot(...)` trusts a snapshot only when all metadata and recomputed prefix state match the current contract. Stale/corrupt/divergent snapshots fall back to full replay; impossible-future snapshots reject.
- `assertSnapshotMatchesReplayAcrossBoundaries(...)` fuzzes snapshot `seq` boundaries and proves snapshot+tail replay equals from-zero replay.
- `replayFromZero(...)` is the authority path.
- `foldMailbox(...)` is the deterministic fixture fold used to model upcasted legacy events, crypto-shredded PII, and quarantine skips.

## Scope Boundaries

This package does not implement the EventStore, snapshot storage backend, upcaster registry, poison-event incident pipeline, crypto-shred key manager, Reactor, GraphQL facade, or cross-Camp replication. It proves the snapshot divergence guard those systems must satisfy.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\snapshot-replay-divergence-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Snapshot Replay Divergence Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
