# @hobo/evals

Rubric + **promotion-gate engine** (design PLAN-23):
schema-versioned rubric records, deterministic scored-run reports reusing
the `@hobo/conformance` suite/report vocabulary (schema id, `ok`,
machine-readable failure codes, golden first-diffs), and promotion verdicts
shaped as Gatekeeper **precomputed dimensions** so evals feeds gatekeeping
as a machine-readable reason gate value. The wire shapes live in
[`data-models/evals.proto`](./data-models/evals.proto) (boundary fixtured in
[`contracts/pacts/evals-promotion-verdict.pact.json`](./contracts/pacts/evals-promotion-verdict.pact.json)).
Non-goal: model hosting — evaluators are ports.

- `defineRubric(definition)` — parse, don't validate: raw rubric
  declarations (criteria with weights, pass thresholds, and
  boolean / scale / golden-match scoring kinds) lower onto parsed derived
  types (`Rubric`) or throw a typed `RubricParseError`; malformed weights,
  thresholds, or kind-specific fields never survive.
- `scoreRubric(rubric, observations)` — deterministic pure scoring into a
  frozen `RubricReport`: per-criterion scores, the weighted total, pass/fail
  against the rubric's threshold, and machine-readable failures. Raw
  observations parse by criterion kind or throw `ObservationParseError`.
- `matchGolden(expected, actual)` / `canonicalJson(value)` — golden-match
  scoring over expected/actual pairs by canonical (key-sorted) JSON, with
  the first diverging path reported the way conformance golden checks do.
- `defineTrainableGoldenRubric(region)` / `observeTrainableGolden(region)` /
  `scoreTrainableGoldenSuite(regions)` — the default **gold** suite
  (`hobo.evals.trainable-golden/v1`). Exact-match over contract examples
  and recorded traces for `"use training"` regions (ADR-0025). Not
  occupancy or Bindle health, and not a Bindle capability.
- `defineTrainableSilverRubric(evidence)` / `observeTrainableSilver` /
  `scoreTrainableSilverSuite` / `scoreTrainableGoldSilverSuites` — the
  default **silver** suite (`hobo.evals.trainable-silver/v1`). Property/fuzz
  oracles (seed-holds, deterministic, fail-closed, no pollution, bounded)
  over the same trainable gold seeds. Live functions run through
  `@hobo/fuzz` `fuzzTrainable`; the sidecar falls back to corpus evidence
  when no invoker is supplied. Unobserved gold seeds fail silver
  `seedHolds`. `canonicalJson` / `matchGolden` fail closed on circular and
  bigint values instead of throwing.
- `evaluatePromotionGate({rubricReport, thresholds})` — the gate verdict:
  structurally the same `{ok, reasons: [{code, message}]}` shape as the
  contracts package's `ResidencyGateVerdict`/`CanMigrateGateVerdict`
  precomputed dimensions; `asGateDimension(verdict)` is the tsc-checked
  upcast a caller hands to Gatekeeper composition.

This package emits no events: scoring is a pure function over observed
evidence. In the platform's command → event pipeline, a promotion attempt
is the command and the promotion actors append `eval.GatePassed` /
`eval.GateFailed` facts to the event store; materialized views /
projections (with snapshots feeding read stores) surface promotion history
and champion/challenger status — this package supplies only the
deterministic reports and verdicts those flows consume.
