# `@hobo/cd/freight`: the Freight ledger

Freight is the immutable, content-addressed unit HoBo CD promotes (D2): one
Bindle's declaration hash, its artifact digests by kind, where it came from,
and its provenance. This folder owns the ledger that records it, the
`hobo.freight-manifest/v1` boundary every build writes, and the D18 retention
decision. It is work package WP1.

| Export | What it does |
|---|---|
| `createFreightLedger` | Record, yank, approve, qualify, look up by id or alias, list, and the retention sweep `retire`. Implements the frozen `FreightLedger` port. |
| `parseFreightManifest` | The parse boundary for `hobo.freight-manifest/v1` (bytes, JSON text or a record). Returns a normalized record or a typed refusal. |
| `writeFreightManifest` | The canonical document (sorted keys, no whitespace). `hobo build` (WP15) and any CI write Freight with it. |
| `freightIdentity` / `freightAlias` | The `sha256:` id and the deterministic two-word alias. |
| `planRetention` | The pure D18 decision the sweep applies. |
| `FREIGHT_REASON`, `FREIGHT_METRIC` | Refusal codes and metric names (wire contract). |

## Design

- **Parse, don't validate.** Nothing reaches the journal unparsed. The parsed
  manifest is normalized: an UNSPECIFIED subject reads as `BINDLE`, artifacts
  are sorted by name, provenance by statement digest. The parsed types are
  the generated `cd_pb.ts` records; `data-models/freight.cue` carries the same
  constraints, and `test/freight/cue.test.ts` checks that the two agree.
- **Identity.** The id is `sha256:` over the canonical JSON of schema version,
  subject, Bindle, declaration hash, and each artifact's name, kind and digest.
  Coordinates, labels, source and provenance are recorded metadata. The same
  bytes reached through any ingress path, or through a digest-preserving
  mirror, are one Freight. A config-only change (a new declaration hash with
  the same artifacts) is new Freight.
- **Commands and events.** Each command (`record`, `yank`, `approve`,
  `qualify`, `retire`) folds the per-Freight stream `cd-freight-<id>` and
  appends one fact (`freight.Recorded/Yanked/Approved/Qualified/Retired`) with
  expected-seq CAS and a per-fact idempotency key. A retried command records
  nothing twice (I12). A concurrent writer causes a re-read, never an
  overwrite. The stream acts as the actor's state: there is no other mutable
  copy.
- **Event store and projections.** The `DurableEventStore` (SQLite by
  default, Postgres when multi-node) is the only store. `list` and
  `getByAlias` read a projection, an in-memory read store over
  `freight.Recorded` that catches up from its last journal position and is
  rebuilt on start. No snapshot is needed: a Freight stream holds a handful of
  facts.
- **Fail closed.** An unreadable event makes that Freight unusable. A
  desired-state or promotion event the sweep cannot read aborts the whole
  sweep (`hobo.cd.freight.retention.aborted`), and nothing is retired. A
  `set.Created` or `policy.BindingChanged` that names no Camp (no `camp_id`
  and not on a `cd-camp-*` stream) aborts too. One that names no Freight (a
  binding restore) adds nothing to the history.
- **Governance (I10).** `approve` (`freight.approve`) and `yank`
  (`freight.yank`) need the `CdAuthorizer`. The frozen factory signature does
  not pass one, so the ledger accepts an optional `authorizer` and refuses
  both without it (`freight-action-ungoverned`). A proposal-only principal,
  such as an agent, can neither approve nor yank. `record` is governed by the
  ingress that calls it (`FreightIngest`, `FreightSources`). `retire` is the
  system retention sweep: the frozen `CdAction` union has no
  `freight.retire` and `FreightRetiredRecord` has no decision-id field, so
  the sweep is governed by the compose-owned job that schedules it (WP18),
  and the journal records the sweep's principal as the event actor. A
  frozen-contract follow-up could add both.
- **Idempotency.** A retried `approve` gets a fresh decision id from the
  authorizer, so an existing approval with the same Camp, approver, reason
  and expiry is returned instead of a second `freight.Approved`.
- **Retention (D18).** The sweep keeps:
  - the Freight each Camp currently runs (the latest `set.Created` per Camp);
  - the Rail each Camp has bound (the latest `policy.BindingChanged` per
    Camp, D24), kept as a separate `<camp>#rail` history so a Bindle Set
    never pushes a Rail out of rollback depth or the reverse;
  - the `keep_per_camp` predecessors in each Camp's Set and Rail history;
  - anything under a legal-hold label (a policy key `k` or pair `k=v`, plus
    the built-in `hobo.cd/legal-hold`);
  - Freight with an in-flight promotion or an unexpired approval;
  - Freight younger than `keep_unpromoted_ms`.

  It retires the rest by appending `freight.Retired`. Nothing is deleted:
  yank evidence and provenance stay in the journal. Proto3 zero values read
  as the `CD_DEFAULTS` values, and an empty `bindle` sweeps every Bindle.

## Promoted proofs

- `release-artifact-provenance-retention-contract`: provenance and yank
  evidence are retained through retirement (`retention.test.ts`, "retirement
  keeps the yank evidence and provenance"). Retention classes map to D18's
  keep rules.
- `slsa-provenance-certification-contract`: see `../ingest/README.md`.

## Metrics

All metrics are counters on `TelemetrySink`, with a `tenant` attribute:

- `hobo.cd.freight.recorded` (`origin`, `bindle`)
- `hobo.cd.freight.refused` (`operation`, `code`)
- `hobo.cd.freight.yanked`
- `hobo.cd.freight.qualified` (`pipeline`, `node`)
- `hobo.cd.freight.approved`
- `hobo.cd.freight.retired` (`bindle`, value = count)
- `hobo.cd.freight.retention.aborted` (`reason`)

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `freight-artifacts-unverified` with `artifact-digest-mismatch` | The bytes at a coordinate are not the declared digest. | Treat as possible tampering. Republish the artifact from the build, or fix the manifest, and resubmit. Never edit the digest to match. |
| `freight-manifest-invalid` | The document is not `hobo.freight-manifest/v1`. | Emit it with `writeFreightManifest`. The reason's `subject` names the field. |
| `freight-secret-in-record` | A coordinate, label or source field carries a credential. | Rotate the credential. Move it to a `credentialRef`. |
| `freight-action-ungoverned` on approve | The ledger was composed without an authorizer. | Pass the `CdAuthorizer` to `createFreightLedger` (WP18 compose). |
| `freight-proposal-only` | An agent or other proposal-only principal tried to approve or yank. | A granted principal applies the proposal. |
| `freight-journal-unreadable` | A Freight event body cannot be decoded. | Restore the stream from backup. Until then the Freight is unusable, by design. |
| `hobo.cd.freight.retention.aborted` rises | The sweep found an unreadable `set.Created` or `env.PromoteRequested`. | Find the event by position in the reason, repair it, and rerun the sweep. Nothing was retired. |
| Freight unexpectedly retired | The rules above all said retire. | Retirement is final. Recording the same build again returns the retired record (same id). Promote newer Freight. To keep Freight longer, add a legal-hold label at build time or raise `keep_per_camp`. |
| Alias lookup returns nothing | No Freight, or two Freight share the alias. | Use the `sha256:` id. Aliases are for humans. |
