# @hobo/training-pipeline

The champion/challenger promotion gate (ADR-0025 / ADR-0125, IMPL-003).
`aggregateEvalResults` folds graded samples into an `EvalResult`, and
`evaluatePromotionGate` decides promote-or-refuse through the three-lens gate:
conformance green, eval thresholds met over enough samples, and policy allows
the change. `promotionEventNames` maps the decision to the platform's
past-tense event names.

Aggregation records a sample count for each metric. A required metric must
have its own count and meet `minSamples`; trajectories that omit that metric
do not contribute to its count. Older results without per-metric counts remain
readable, and cannot satisfy a metric floor until their counts are supplied.

## Trajectory capture (OTel / OpenInference span emission)

`createTrajectoryCapture` starts/ends spans around agent actions — `AGENT`
step, `TOOL` call, `LLM` call, `EVALUATOR` run (any OpenInference span kind) —
producing OTel-shaped span records (`traceId`/`spanId`/`parentSpanId`, name,
start/end times, status) whose attributes follow the OpenInference semantic
conventions (`openinference.span.kind`, `input.value`/`input.mime_type`,
`output.value`/`output.mime_type`). W3C trace context propagates end to end:
an inbound `traceparent` is joined (`parseTraceContext`/`formatTraceparent`),
and every span handle exposes the `traceparent` to hand downstream.

Finished spans leave through the `SpanExporterPort`;
`createInMemorySpanExporter` collects them for tests and assembly.
`createOtlpSpanExporter({ endpoint })` sends them as OTLP/HTTP JSON to the
specified trace endpoint. The exporter buffers spans in memory until `flush()`
or `shutdown()` is called. Configure `maxBatchSize`, `maxBufferedSpans`,
`timeoutMs`, resource attributes, and request headers when needed. A full
buffer makes span completion fail so the caller can flush and retry it.
`shutdown()` stops accepting spans and flushes; after a delivery failure,
call `flush()` to retry the retained batch. Delivery can occur more than once
if the collector accepts a request whose response is lost. If the collector
reports partial success, `flush()` throws `OtlpPartialSuccessError` with its
rejected count; the batch is not resent because the response does not identify
which spans were accepted. Captured input, output, and other span attributes
are included in the export.
`assembleTrajectory` (or `capture.toTrajectory`) lowers the span records to
the generated `Trajectory` wire shape (`@hobo/core`
`data-models/training_engine.proto`) and re-ingests them through core's
`parseTrajectory`, so a captured trajectory is exactly the stored record
`@hobo/provider-agentv` grades — capture → grade → aggregate → promotion gate
is a closed loop. `trajectoryCapturedEvent` wraps the result as a
`training.TrajectoryCaptured` fact riding the same `training.*` family as
`promotionEventNames`, with the trajectory's traceparent on `meta`.

## Honest scope

Implemented: the pure gate function, eval aggregation, threshold/eval-result
parsers, the decision-to-event-name mapping, and trajectory capture (span
records via a port, trajectory assembly, and the `training.TrajectoryCaptured`
envelope). The fourth lens (Trace) rides the event log, not the decision
record. Deliberately not here: no training run, no eval execution, no event
store — the gate is a pure function over recorded eval results; the
event-sourced promotion loop around it (the Yard's promotion actor) lives in
the runtime, not in this package.

## Commands

```bash
pnpm --filter @hobo/training-pipeline run build
pnpm --filter @hobo/training-pipeline run typecheck
pnpm --filter @hobo/training-pipeline run lint
pnpm --filter @hobo/training-pipeline run test
```

## Parse, don't validate

Untrusted eval inputs cross one parser boundary: `parseEvalResult` and
`parsePromotionThresholds` return deep-frozen derived types over the generated
proto messages (`EvalResult`, `PromotionThresholds`, `LensFlags`,
`ChampionChallenger`), enforcing the CUE-mirrored invariants (scores in
`[0, 1]`, non-empty refs); failures throw `PromotionGateParseError`.
`evaluatePromotionGate` consumes only those parsed values and returns a frozen
`PromotionDecision` — parse, don't validate. Wire forms live in
`data-models/promotion_decision.proto` with CUE constraints alongside.

Trajectory capture has the same boundary discipline: `parseTraceContext`
rejects malformed traceparents, `parseCapturedSpan` rejects unfinished spans,
pre-epoch or end-before-start timestamps, bad ids, and unknown kinds (all as
`TrajectoryCaptureParseError`), and `assembleTrajectory` re-parses every span
record before the result round-trips core's generated `Trajectory` shape via
`parseTrajectory`.

## Position in the event architecture

The gate itself hosts no actor and holds no state. In the platform loop,
`RequestPromotion` is the command; a promote emits `training.Promoted` and
`impl.Promoted`, a refusal emits `eval.GateFailed` (via `promotionEventNames`);
the Yard's promotion actor calls this gate; eval results are read from and
decisions appended to the platform event store; a promotion projection folds
those events into current-champion state, and the promoted training artifact is
the snapshot applied at instantiation.
