# @hobo/training-pipeline — Architecture Evidence

The champion/challenger **promotion gate** (ADR-0025 / ADR-0125,
[generated-stack.md](../../docs/design/generated-stack.md), IMPL-003). A
trained challenger promotes over the standing champion only through the same
three-lens gate as any generation-pipeline impl: **conformance** (the hard
PACT/conformance contract) is green, **eval** thresholds are met over enough
samples, and **policy** allows the change. The fourth lens, Trace, rides the
event log rather than the decision record.

## Schema and constraints

- Record shapes are the **generated** proto types: the gate's inputs and
  output (`EvalResult`, `PromotionThresholds`, `LensFlags`,
  `ChampionChallenger`, `PromotionDecision`) come from
  [`data-models/promotion_decision.proto`](./data-models/promotion_decision.proto);
  codegen is opted in via `data-models/buf.yaml` and generated types live in
  `src/_generated/`. No record type is hand-declared in parallel.
- CUE constraints bound every protobuf type in
  [`data-models/promotion_decision.cue`](./data-models/promotion_decision.cue)
  (scores and metric floors in the unit interval, non-empty refs, a
  specified outcome), and the fixtures under
  [`data-models/fixtures/`](./data-models/fixtures/) are `cue vet`-ed by the
  codegen gate.
- PACT boundary evidence for the promotion-gate edge lives under
  [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

Untrusted eval inputs cross one parser boundary: `parseEvalResult` and
`parsePromotionThresholds` build deep-frozen **parsed/derived** generated
types that enforce the CUE-mirrored invariants (scores in `[0, 1]`, non-empty
rubric refs), and `evaluatePromotionGate` consumes only those derived domain
types, never raw DTOs. The `PromotionDecision` it returns is itself a frozen
generated message, so a downstream consumer parses the decision once and
trusts its shape thereafter.

## Event architecture

The gate is a pure function over recorded eval results; the promotion loop
around it is event-sourced (Plan 23 / `event-families.md`):

- **Command** — `RequestPromotion` submits a challenger candidate and its eval
  results for the gate decision.
- **Event** — `promotionEventNames` maps the decision to past-tense facts: a
  promote emits `training.Promoted` and `impl.Promoted`; a refusal emits
  `eval.GateFailed`.
- **Actor** — the Yard's promotion actor owns champion/challenger state and
  calls this gate; the gate itself holds no state.
- **Event store** — eval results are read from, and promotion decisions
  appended to, the platform event store (the trajectory/eval trail rides the
  event log, ADR-0099).
- **Materialized view / projection** — the promotion projection folds
  `training.*`/`eval.*` events into current champion-per-method for the
  dashboard.
- **Snapshot** — the promoted training artifact is the snapshot the runtime
  applies at instantiation (ADR-0125 apply-at-load).
- **Read store** — champion/challenger eval comparisons query the training
  read store; the standing champion id is fetched from it into the gate.
