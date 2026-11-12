# `@hobo/cd/reconcile` — fenced pull reconcilers (WP7)

Plan 0024 §9 WP7 (D5, D6, D22, D25; invariants I2–I5). Every delivery change
reaches a target only through a Camp reconciler: it reads the Camp's desired
state by cursor, fetches the resolved plan by digest, converges through a
`Realizer`, reports to the Camp's **status** stream and checkpoints.

The two realizer adapters this module drives live beside it in
[`../adapters/orchestrator.ts`](../adapters/orchestrator.ts) (resource graphs)
and [`../adapters/hosting-transition.ts`](../adapters/hosting-transition.ts)
(workload versions); they are documented here so `adapters/` stays shared.

## Surface

| Export | What it is |
|---|---|
| `createCampReconciler(d)` | `CampReconciler`: `run(signal)` holds and renews Camp leases; `reconcileOnce(campId, ctx)` is one bounded pass (`hobo up`, tests). |
| `createInProcessTransport(d)` | `ReconcilerTransport` over the journal (conductor mode). |
| `createDriftPolicy(options)` | Default `DriftPolicy`: per-class routes with safety overrides. |
| `planDeparture`, `keepOf` | `DepartureAction` handling (`DELETE`, `ORPHAN`, `ORPHAN_DATA`). |
| `sanitizeObservation`, `trimAttributes` | Observation hygiene: stamps, `observe_fields`, 16 KiB bound, secret scan, claims, handover. |
| `RETAINED_FIELDS`, `applyRetained`, `parseRetainProperty` | Retained fields (D22). |
| `statusEventsFor`, `RECONCILE_EVENTS` | Observation → status-stream events. |
| `createOrchestratorRealizer` | `../adapters/orchestrator.ts`: attested apply via `runOrchestrator`; only changed nodes. |
| `createHostingTransitionRealizer` | `../adapters/hosting-transition.ts`: versions via `createHostingTransitionCoordinator`. |

## Event architecture

- **Commands**: `reconcileOnce` / `run` (reconciler); `claim`, `renew`,
  `report`, `checkpoint` (transport).
- **Actor**: one writer per Camp. The durable subscription lease
  `cd:camp:<campId>` (partition = Camp, holder = `<reconcilerId>/<holderId>`)
  is the actor boundary; its fence token stamps every report (I4).
- **Event store**: spec stream `cd-camp-<id>` is read only (written by
  promotion through WP4); status stream `cd-camp-status-<id>` is the only
  stream this module writes, fenced by the lease. The orchestrator realizer
  keeps a private fenced ledger `cd-realizer-graph-<id>`.
- **Events written** (`status-events.ts`):

  | Observation | Events |
  |---|---|
  | `CONVERGING` | `deployment.ReconcileStarted`, `deployment.StatusObserved` |
  | `CONVERGED` | `deployment.StatusObserved`, `deployment.Converged` |
  | `BLOCKED` | `deployment.StatusObserved`, `deployment.ReconcileBlocked` |
  | reason `drift-detected` | `resource.DriftDetected` |
  | reason `drift-proposed` | `drift.DiffProposed` |
  | reason `departure-orphaned` | `camp.Departed` (`orphans`) |

  Each body is `{ schema: "hobo.cd.reconcile-status/v1", observation, drift?, orphans? }`
  and is vetted against `#ReconcileStatusEvent` in
  [`data-models/reconcile.cue`](../../data-models/reconcile.cue).
- **Projections / read store**: the status stream is the materialized
  view of a Camp's status (the read store other modules query); `DesiredStateReader.status` (WP4), inventory (WP22) and
  posture (WP24) fold it. Checkpoints are the reconciler's snapshot of
  progress: a restart resumes after the committed position.

## Parse, don't validate

Wire records are the generated `cd_pb.ts` types; constrained values are
parsed once into derived types and never re-checked downstream:

- `parseDriftKind(drift_kind)` → `DriftKind` (`driftClass` + sorted `fields`);
  an unknown class parses to `unknown` and escalates.
- `parseRetainProperty(value)` → the sorted retained-field list.
- `parseObservation(json)` → `ReconcileObservationRecord` from a status body.
- `sanitizeObservation` produces the only observation shape that is reported
  (stamped with the lease fence, trimmed, secret-free); `isConvergedOn` is the
  single convergence predicate.
- Branded ids (`CampId`, `ReconcilerId`, `FenceToken`, `EventPosition`) come
  from the frozen ports and the journal; the transport never invents one.

## Loop

1. Claim or renew the Camp lease (TTL `CD_DEFAULTS.leaseTtlMs`). A held lease
   refuses with `lease-held`; the next attempt waits
   `backoffMs(reconcilerId, campId, attempt)` — jitter from a hash, no RNG.
2. Read the feed. The newest change wins; the first feed of each lease
   re-delivers the current change when nothing newer exists, so a restarted
   reconciler re-observes without waiting for a Set.
3. Fetch the resolved set. A missing or mismatched blob blocks with
   `resolved-set-missing` / `resolved-set-mismatch`; nothing is checkpointed.
   The split follows the thrown error's typed `code` (`resolved-set-digest-mismatch`,
   `blob-digest-mismatch`, `artifact-corrupt`, `artifact-digest-mismatch` mean mismatch;
   anything else is missing), never its message text.
4. **Observe first.** A failed observation blocks (I5). An observation that
   already proves the Set reports `Converged` and checkpoints (this is how a
   crash between execute and observe resumes without repeating a mutation).
   A target that runs the Set but diverged is **drift** and goes to step 6.
5. `mutate` — the single call site of `Realizer.converge`. It refuses
   `OBSERVE_ONLY` Camps, re-checks the lease, reports `ReconcileStarted`,
   converges, and checkpoints only after a `CONVERGED` observation of this Set.
6. Without a new change, re-observe every 60 s. Drift is routed by the
   `DriftPolicy`:

   | Class (`drift_kind`) | Default route |
   |---|---|
   | `modified[:fields]` | `reconcile` (re-apply the current Set) |
   | `deleted` | `reconcile`; a data resource `escalate`s |
   | `orphan` (owned, undeclared) | `reconcile` (swept) |
   | `external` (not ours) | `propose`; never re-applied |
   | anything else | `escalate` |

   More than 10 drifted resources escalates (blast radius). The same
   fingerprint as the last pass is suppressed (flapping). A fingerprint that
   recurs after a confirmed remediation is new drift, and escalates instead
   of oscillating (`maxRemediations`, default 1).

## Fleet and policy

- **Retained fields** (D22) come from a resolver component's `describe`
  (realizer copies them into `ResourceObservation.retained`), the in-tree
  table `RETAINED_FIELDS` (by resource kind) and the mapping-rule property
  `hobo.cd/retain` (in `realizationParameters`). A `modified:<fields>` drift
  whose fields are all retained is not drift; `modified` naming no fields
  stays drift (fail closed).
- **Observations** carry `kind`, `classification`, the declared `attributes`
  (trimmed to `observe_fields`, ≤ 16 KiB per resource, secret-scanned; an
  oversized value is truncated with its digest and an `attribute-truncated`
  reason, a value that no longer fits is dropped with `attribute-dropped`),
  `retained`, `claims` (attributed to the reconciler) and `handover`
  (secret-scanned).
- **`OBSERVE_ONLY`** Camps are read and reported (`OBSERVED`), drift is
  recorded, nothing is applied (architecture-tested).
- **Departure** (`SET_ORIGIN_DEPARTURE`) follows the `DepartureAction`
  (default `ORPHAN_DATA`): kept resources are passed to the realizer as `keep`,
  recorded in `camp.Departed`, and verified afterwards
  (`departure-keep-violated` if a realizer removed one).
- **`topology` Deltas** are ordinary Sets.

## Realizer adapters

- **Orchestrator** (`adapters/orchestrator.ts`): verifies the resolved set
  against the Set's content hash (I1), attests the apply worker with the
  injected host attestor (no fixture fallback — C3), diffs the desired graph
  against its fenced ledger and runs `runOrchestrator` on the **changed
  nodes only**; removed nodes are destroyed in reverse order unless kept.
  A rollback Set re-applies the predecessor's nodes (C4). A failed exec blocks
  the pass instead of running compensation (rollback is a Delta, D12). A
  stale fence stops before any mutation.
- **Hosting transition** (`adapters/hosting-transition.ts`): proposes the
  version transition `planFor(input)` returns, with the lease fence as the
  coordinator's writer fence, and advances at most `maxSteps` steps. Only a
  `SETTLED` state whose destination owns writes is `CONVERGED`; `RESTORED`,
  `BLOCKED` or settled-back states block with the coordinator's reason.

## Metrics (`TelemetrySink`)

`hobo.cd.reconcile.passes{status}`, `hobo.cd.reconcile.duration` (ms
histogram), `hobo.cd.reconcile.converged`, `hobo.cd.reconcile.blocked{reason}`,
`hobo.cd.reconcile.drift{fingerprint}`, `hobo.cd.reconcile.lease_refused`,
`hobo.cd.reconcile.mutations`; all carry `hobo.cd.camp`,
`hobo.cd.reconciler`, `hobo.cd.reconciler.mode`. Telemetry failures never
fail a pass.

## Runbook

| Symptom | Reason code | Action |
|---|---|---|
| Camp never converges; `lease_refused` climbs | `lease-held` | Another reconciler holds `cd:camp:<id>`. Find it in `cd-camp-status-<id>` (`reconcilerId`). Revoke it (the governed `reconciler.revoke` action) or wait one lease TTL (30 s). Never run two writers. |
| Reports refused after a failover of the conductor | `stale-fence` | Expected for the old process: it lost the lease and stopped before mutating. Stop the old process. |
| `ReconcileBlocked` right after a promotion | `resolved-set-missing` / `resolved-set-mismatch` | The resolved-set blob is missing or corrupt in the artifact store. Restore it (or re-apply the Set); the reconciler retries the same change. |
| `ReconcileBlocked` with `realize-failed` | `realize-failed` | Provider or credential failure. Fix it; the next pass resumes by observation (idempotent). To undo instead, roll back (a Delta through the gate). |
| `attestation-refused` | `attestation-refused` | The apply worker's host attestor keys or code digest do not verify. Fix the attestor configuration; nothing was applied. |
| `drift.DiffProposed` events | `drift-proposed` | Review the diff; approve a `drift-remediate` Delta or adopt the change in the declaration. |
| `ReconcileBlocked` with `drift-escalated` | `drift-escalated` | Drift oscillated, exceeded the blast radius, or deleted a data resource. Investigate before re-applying; restore data from backup if needed. |
| Many `attribute-truncated` / `attribute-dropped` | as named | The bound posture packs request too much; narrow `observe_fields`. |
| `departure-keep-violated` | `departure-keep-violated` | A realizer deleted a kept resource. Restore it from backup and fix the realizer to honour `keep`. |
| Camp shows `OBSERVED`, never converges | `observe-only` | The Camp is `OBSERVE_ONLY`. Promote it with `camp.manage` when adoption is complete. |
| `store-unavailable` / `lease-unsupported` | as named | The journal is down, or the store has no subscription leases. Run on `@hobo/storage-sqlite` / `@hobo/storage-postgres`. |
