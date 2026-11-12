# `@hobo/cd/sets` — Sets, Deltas and desired state

Work package WP4 of [plan 0024](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md)
(C1, C8, B1–B4). `createDesiredState` implements the frozen
`DesiredStateReader & DeltaLedger` ports (`src/ports.ts`) and is the single
desired-state lane every delivery path writes through.

## Model

- **Set** (`SetRecord`): the immutable desired state of one Camp. It records
  the Freight, the gate decision that admitted it (I10), its origin
  (`SetOrigin`), its predecessor, and the digest and size of its **resolved-set
  blob**. The plan is never inlined in an event (B3).
- **Delta** (`DeltaRecord`): a change against the Camp's current Set. One open
  Delta per Camp. Lifecycle: `open` → (`update`)* → `apply` | `reject`.
- **Resolved-set blob**: the canonical (key-sorted), secret-free
  `ResolvedDeploymentSet`, stored in the `ArtifactStore` as
  `ARTIFACT_KIND_PACKAGE` with media type
  `application/vnd.hobo.resolved-set+json`. Content identity is independent
  of key order, so `SetRecord.content_hash` is the hash of the canonical form
  (`resolved(set).contentHash` always equals it).

## Commands, events and streams

| Command | Event(s) on `cd-camp-<id>` (spec) |
|---|---|
| `open(delta)` | `delta.Opened` |
| `update(delta)` | `delta.Updated` |
| `apply({deltaId, gateDecisionId, resolved, origin})` | `delta.Applied` + `set.Created` in one append; an empty Delta appends only `delta.Applied` |
| `reject(deltaId, reasons)` | `delta.Rejected` |
| `adoptLegacy()` | `set.Created` with `SET_ORIGIN_LEGACY_FOLD` |

`apply` checks that the Delta's declared `changes` (resource + kind) equal
`diffResolvedSets(base, resolved)`; an empty Delta is a no-op only when the
canonical content hash is unchanged (a new gate decision or Freight with an
identical plan still mints a Set, so lineage is never dropped). Delta ids are
unique across Camps and may not start with `set_`, which lets one `get`
serve both ports.

Every append uses the stream head as its expected version (event-store CAS),
so of two concurrent applies exactly one wins; the loser re-reads and either
returns the winner's Set (same Delta, I12) or is refused `concurrent-apply`.
Observations live on `cd-camp-status-<id>` (status), written by reconcilers;
this module only folds it, so observations never contend with applies (B2,
§10). Policy bindings (`policy.BindingChanged`, written by promotion) are
folded from the spec stream; management mode is folded from the Camp
inventory stream `cd-camp-inventory-<id>` (WP22), defaulting to `MANAGED`.

## Projections (materialized views)

- `foldCampSpec` — the actor-style fold of one Camp's spec stream: current
  Set, history, Delta statuses, open Delta, policy binding. It rejects
  overlapping open Deltas, stale bases, out-of-order Delta events and broken
  predecessor chains as `journal-invalid` (HOBO-50 rules).
- `foldCampStatus` — the latest observation; observations from a lower fence
  than one already seen are ignored (I4).
- `changes()` — streams `DesiredStateChange` frames by event-store position
  (`set.Created`, `policy.BindingChanged`, `camp.ManagementChanged`), resumes
  after a cursor, then tails live (store subscription plus a
  `serviceTickMs` poll for cross-process writers).

There is no separate read store or snapshot: every read folds the per-Camp
stream, which is short (one entry per Delta) and is the event store's own
source of truth. A snapshot of `CampSpecState` can be added behind `spec()`
without changing a port.

## Parse, don't validate

`checkSet`/`parseSet` and `checkDelta`/`parseDelta` (`codec.ts`) are the only
constructors of the derived types `ParsedSet` and `ParsedDelta`; they apply
the constraints in [`data-models/sets.cue`](../../data-models/sets.cue).
`verifyResolvedSet`/`decodeResolvedSetBlob` are the only constructors of
`CanonicalResolvedSet` (verified hashes, closed dependencies, no plaintext
secrets).

## Contracts and proofs

- PACT: [`test/sets/desired-state.pact.json`](../../test/sets/desired-state.pact.json)
  (promotion and reconcilers → desired state), verified by
  `desired-state.pact.test.ts`.
- Protobuf: `SetRecord`, `DeltaRecord`, `DeltaDecisionRecord`,
  `ResourceChange`, `SetOrigin`, `ChangeKind` in `data-models/cd.proto`
  (frozen); CUE in `data-models/sets.cue`, vetted against real bodies by
  `cue-constraints.test.ts`.
- Upcaster corpus: `SET_EVENT_CONTRACTS` pins `set.Created` and `delta.*`
  v1 bodies; `test/sets/fixtures/sets-corpus-baseline.json` is append-only.
- Promoted proofs: `delta-set-apply-reconcile-contract` (apply, empty Delta,
  missing dependency, rollback-as-Delta) and
  `hobo-50-deployment-set-delta` (fold, key-order-stable addresses, diff,
  overlap, stale base, absent resource, out-of-order) in
  `promoted-proofs.test.ts`.

## Metrics (`TelemetrySink`)

| Metric | Kind | Attributes |
|---|---|---|
| `hobo.cd.sets.deltas_opened` | counter | camp, intent |
| `hobo.cd.sets.deltas_applied` / `hobo.cd.sets.apply_refused` | counter | camp, origin, reason |
| `hobo.cd.sets.deltas_rejected` | counter | camp, reason |
| `hobo.cd.sets.apply_conflicts` | counter | camp |
| `hobo.cd.sets.resolved_set_bytes` | histogram (By) | camp, origin |
| `hobo.cd.sets.resolved_set_verify_failures` | counter | camp, reason |
| `hobo.cd.sets.legacy_adopted` / `hobo.cd.sets.legacy_skipped` | counter | camp, reason |

A failing sink never fails a command.

## Runbook

| Symptom (reason code) | Meaning | Action |
|---|---|---|
| `delta-overlap` | The Camp already has an open Delta. | Find it with `spec(campId).openDeltaId`; apply or reject it. A promotion that died mid-flight leaves its Delta open: reject it with reason `abandoned`. |
| `delta-stale-base` / `concurrent-apply` | Another writer moved the Camp's current Set. | Re-resolve against `current(campId)` and open a new Delta. Repeated `apply_conflicts` on one Camp means two controllers drive it; check fan-out/promotion leases. |
| `delta-diff-mismatch` | The resolved set does not match the Delta's declared changes. | Recompute `changes` with `diffResolvedSets(base, resolved)`; a mismatch means the resolver and the Delta disagree about what changes. |
| `secret-material` | A plaintext secret reached a resolved set. | Replace the value with a `secretRef:` locator at its source (declaration or Matching). Nothing was stored. |
| `resolved-set-missing` | The blob a Set names is gone from the artifact store. | Restore the blob (the digest is in the message) from a replica or backup, or re-apply the Set with a new Delta. Retention (WP1) must never delete a referenced blob; check its referenced-set scan. |
| `resolved-set-digest-mismatch` | The stored bytes no longer hash to the Set's digest (corruption at rest). | Promotion and reconciliation for the Camp stay blocked. Restore the blob from a replica; `hobo.cd.sets.resolved_set_verify_failures` shows the scope. |
| `blob-digest-mismatch` | The artifact store returned a different digest for bytes it was given. | The store backend is faulty or misconfigured (wrong hashing or a proxy rewriting bodies). Fix the backend; nothing was appended. |
| `journal-invalid` | A Camp's spec stream is inconsistent (a write outside this module). | Stop writers for the Camp, export the stream, and repair it by an operator-reviewed append. Never edit events in place. |
| Legacy estate shows no current Set | `adoptLegacy` has not run, the deployment was rolled back, or it was skipped. | Run adoption (composition does it at start); read `skipped` reasons and `hobo.cd.sets.legacy_skipped`. |
