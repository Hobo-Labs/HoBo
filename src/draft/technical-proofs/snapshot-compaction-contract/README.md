# Snapshot Compaction Contract

HOBO-240 proof package for Plan 11 / ADR-0050 snapshot lifecycle policy on top of the EventStore primitive supplied by earlier slices.

It proves:

- actor activation uses a snapshot only as a cache and replays tail events after the covered `seq`;
- deleting or corrupting a snapshot falls back to authoritative replay;
- high-volume domain streams can snapshot-and-truncate older events to cold storage with an audit marker;
- compliance-retained `token.*`, `resource.*`, and policy streams refuse compaction;
- `run.*` streams archive only after terminal state plus retention.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\snapshot-compaction-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Snapshot Compaction Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
- `type-tests/` — strict TypeScript consumer proof that the implementation exports the same typed surface as the declaration file without ambient Node runtime types.
