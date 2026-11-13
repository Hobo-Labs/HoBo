# `@hobo/fleet/audit` (L06)

The tamper-evident audit log of design §6.14: the authority's hash chain, its verification, and the witness that co-signs checkpoints and trust records.

## Entry points

The frozen entry points of design §7.3 live in `index.ts`. The other modules in this directory belong to this lane and are not part of the contract.

| Entry point | What it does |
|---|---|
| `createAuditChain` | On each `tick()`, turns every new journal event (`FleetEventStore.readAll` order) into one `AuditEntry` on the `AuditLog`. Signs a checkpoint (`hobo-fleet/audit-checkpoint/v1`) every 1,000 entries, and at a tick 60 s or more after the last checkpoint when there are new entries; journals each as `fleet.AuditCheckpointed` on `fleet-audit`. Recovers its head after a restart from the last `fleet.AuditCheckpointed` event and the log |
| `verifyAuditChain` | Recomputes the chain from entry 1 and checks each checkpoint's authority and witness signatures (`verifyWitnessed` against the given trust record) and its hash. Fails with `proof-invalid` and `detail.rule` one of `sequence`, `previous-hash`, `checkpoint-signature`, `checkpoint-beyond`, `checkpoint-hash` |
| `createWitness` | Reads the entries itself every second, recomputes the chain, watches registry changes, and co-signs checkpoints and proposed trust records by the rules below. Logs `hobo_fleet_witness_refused` for every refusal and `hobo_fleet_witness_lag` once three checkpoints in a row are refused |

## The chain

- `entry_hash = SHA-256(previous_hash ‖ entry_bytes)`: `previous_hash` is the previous entry's hash as 32 raw bytes (64 hex zeros for the first entry) and `entry_bytes` is the entry's protobuf binary.
- `data_digest` is SHA-256 of `canonicalJson(data)` (`@hobo/core`: keys sorted at every depth). A `fleet.TrustRotated` event carries the proposed `TrustRecord` bytes, base64, in `data.record`; its digest is SHA-256 of those bytes.
- `subject` and `subject_sequence`: an event on `fleet-member-<id>`, `fleet-fleet-<id>` or `fleet-trust` changes registry record `member.<id>`, `fleet.<id>` or `trust` when it names the record's sequence after the event, in `meta.subjectSequence` or else in the data field `recordSequence`, `revision` or `sequence`. Any other event has its stream id as subject and sequence 0.
- `actor` is `<kind>:<id>` of the event's principal; `at` is the event's `ts`.
- A checkpoint's `at` is the `at` of the entry it covers, and the `fleet.AuditCheckpointed` data is the checkpoint's four fields. So the witness rebuilds the exact payload the authority signed from entries it recomputed itself: it learns of a checkpoint from that entry and finds the covered entry whose fields give the entry's data digest.

## The witness

A checkpoint is co-signed only if:

1. every entry up to it is there, in sequence, and chains (`entries-withheld`, `chain-broken`);
2. its `fleet.AuditCheckpointed` entry names a prefix of the chain the witness computed, under the pinned trust record's incarnation (`checkpoint-unknown`);
3. every registry change the witness saw more than 5 s (clock skew) before the checkpoint was journaled has an entry with that `subject` and `subject_sequence` before it (`registry-change-unrecorded`). A change is a new record sequence for a key; a re-sign keeps the sequence and is ignored;
4. it does not contradict a final checkpoint at the same sequence (`checkpoint-rewritten`).

A proposed trust record is co-signed only if it verifies against an authority key of the pinned record (`unpinned-key`, `authority-signature`), its sequence is one above the pinned one (`sequence`), it is for the same tenant (`tenant`), and a `fleet.TrustRotated` entry with its digest is in the chain. Without that entry the proposal is refused (`trust-rotation-unrecorded`) and kept, and co-signed once the entry appears.

A witness that is down cannot log its own lag; F13's alarm for that case comes from the availability events of the status feed (L27).
