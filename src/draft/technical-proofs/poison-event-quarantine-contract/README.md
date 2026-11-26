# Poison Event Quarantine Contract POC

Independent proof for HOBO-291. It pins the Plan 11 / ADR-0050 runtime poison-event path:

- Projection and aggregate folds quarantine deterministic decode/upcast/fold failures instead of wedging.
- `*.Quarantined` facts record the offending `seq`, source event id/type, fold, fold kind, and reason.
- Replays skip the same quarantined `seq` deterministically, preserving replay/live equivalence.
- The append-only log is not rewritten or pruned; the source event remains visible beside the quarantine fact.
- `hobo doctor`-shaped findings surface the quarantine as an incident signal.

Scope boundary:

- This package handles runtime poison that slipped past the pre-deploy golden-replay gate.
- It does not implement the golden-replay corpus, SRE incident aggregate, or snapshot-during-quarantine consistency.
- A quarantined event that becomes processable under a later upcaster requires explicit reprocess policy; it is not silently un-quarantined.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\poison-event-quarantine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Poison Event Quarantine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
