# `@hobo/cd/placement` — Placement (WP22: D20, I18, I19)

`createPlacementEngine` implements the frozen `PlacementEngine` port. A
`PlacementRecord` selects Camps from Rail-bound Camp sets; `decide` produces a
`PlacementDecisionRecord` with groups and every candidate's exclusion codes.

## Event architecture

| Stream | Events | Body |
|---|---|---|
| `cd-placement-<name>` | `placement.Defined` | `PlacementRecord` |
| | `placement.Decided` | `PlacementDecisionRecord` (idempotency key = `decisionId`) |
| `cd-placement-score-<score>` | `placement.ScoresReported` | `ScoreSnapshotRecord` (idempotency key = `digest`) |

Placement names may not start with `score-`, so the two families never share
a stream. Commands: `define` (`placement.define`), `reportScores`
(`placement.scores`), `decide`. Read model: `get`, `decision` (cached; cold
lookups scan `placement.Decided`).

- **Actor, event store, read store:** the engine is a command handler over
  the durable event store; `get`/`decision` are projections over the
  placement streams (read store = the in-memory decision cache, rebuilt from
  `placement.Decided`). Its input `snapshot` is the inventory's canonical,
  digest-addressed view.
- **Parse, don't validate:** `parsePlacement` and `parseScoreSnapshot`
  return derived types (`ParsedPlacement`, `ParsedScoreSnapshot`) or typed
  refusals; `decide` only ever sees recorded, parsed records.

## `decide` (`decide.ts`, pure)

`decidePlacement(placement, snapshot, scores, subject, railDelivery,
approvedProviders, exclude, count, atMs)`:

1. Candidates: the inventory snapshot of the Placement's sets that the
   Station's Rail binds (`delivery.camp_sets`) ∩ the predicate. Unbound sets
   are invisible; each is named in a `set-not-bound` decision reason.
2. Exclusion codes per candidate: `observe-only`, `excluded` (caller's
   `exclude`, e.g. a failover source), `taint-not-tolerated`, `claim-missing`,
   `provider-not-approved`, `residency-conflict:<code>` (from `@hobo/core`
   `evaluateResidency` against **declared** regions; an unmapped or missing
   region fails closed). Claims never satisfy residency (I19).
3. Rank by Σ weight × score over the latest unexpired snapshot per score
   (`valid_until > atMs`, `reported_at ≤ atMs`), then Camp id. Expired
   snapshots are ignored, never extrapolated.
4. Select: seed each spread key's `min_groups` with the best Camp of a new
   value, then fill to `count` (0 = all eligible) in rank order without
   exceeding any `max_groups`. Eligible Camps left out get `count-limit` or
   `spread-max-groups:<key>`. Impossible spreads or counts are refused with
   `placement-unsatisfiable` whose `subject` names the unmet key (`provider`,
   `count`, `candidates`, …).
5. Groups: named groups by selector in declaration order (capped by
   `max_size` / `max_size_percent`), then the rest chunked by
   `default_group_size` (or its percent; default 10 %, at least one). A named
   group that matches nothing is omitted and named in a `group-empty` reason.
   `mandatory` is left `false`: the fan-out's `mandatory_groups` decides it.

The decision records the inventory digest, the digests of the snapshots it
used, and a deterministic `decisionId` over every input, so permuting inputs
or retrying yields a byte-identical record (I18).

## Telemetry

`hobo.cd.placement.defined`, `hobo.cd.placement.scores_reported`,
`hobo.cd.placement.decisions` (`outcome=decided|refused`),
`hobo.cd.placement.selected_camps` (histogram). The engine takes an optional
`telemetry` sink (the frozen factory signature has none).

## Typed failures

| Code | Remediation |
|---|---|
| `placement-invalid` (subject = field) | fix the definition (spread key, sizes, groups, schema version) |
| `selector-unsupported` | select Camps by labels, env types, jurisdictions or ids |
| `score-invalid` / `score-expired` | finite values; `valid_until` in the future and ≤ 24 h away |
| `placement-not-found` | define the Placement first |
| `placement-unsatisfiable` (subject = key) | add eligible Camps, relax spread, lower count |
| `proposal-only`, `policy-denied` | ask a granted principal |

Refusals that fail closed on absent evidence: `rail-providers-unknown` (the
composition did not supply the Rail's `approvedProviders`; provider approval
cannot be evaluated, so nothing is placed) and `inventory-invalid` (the
snapshot lists a Camp id twice).

Decision reasons (not refusals): `set-not-bound`, `set-unknown` (a bound set
has no definition and contributes no Camps), `group-empty`.

Idempotency: the decision id covers every recorded input including the decide
instant, because score expiry and toleration windows depend on it. A retry at
the same instant appends nothing; a retry at a later clock reading is a new
decision.

## Runbook

- **`placement-unsatisfiable`.** Read `subject`: a spread key means the
  eligible Camps cover too few distinct values; `count` means too few eligible
  Camps; `candidates` means none. Inspect the inventory (`hobo` CLI / control
  API `inventory list`) for taints and the Rail's bound Camp sets.
- **A Camp you expected is not selected.** Its candidate row lists the
  exclusion codes. `taint-not-tolerated`: see the inventory runbook.
  `residency-conflict:*`: its declared Yard regions are outside the subject's
  allowed jurisdictions; claims cannot change that.
- **Decision differs between replicas.** It cannot for the same recorded
  inputs; compare `inventoryDigest` and `scoreSnapshotDigests`. Differing
  digests mean the inventory or scores changed between the calls.
- **`rail-providers-unknown` refuses every decision.** Wire
  `approvedProviders: (stationId) => rail.approvedProviders` into
  `createPlacementEngine` in the composition.
