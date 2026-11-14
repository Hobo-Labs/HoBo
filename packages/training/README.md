# @hobo/training

The **built-in training engine** behind core's `hobo:training-engine` port
([ADR-0025](../../docs/design/adr/03-data-plane.md#adr-0025)):
an OPTO-style iterative optimizer — **propose → score → keep-best** over
candidate parameter sets (instruction framing + demo subset drawn from the
request's recorded trajectories) — plus OpenInference-aligned trace capture
into an in-memory sink the caller drains. The engine-side record shapes
(optimizer config, step trace span) live in
[`data-models/training_optimizer.proto`](./data-models/training_optimizer.proto)
with CUE bounds in
[`data-models/training_optimizer.cue`](./data-models/training_optimizer.cue);
the port boundary is fixtured in
[`contracts/pacts/training-engine-optimize.pact.json`](./contracts/pacts/training-engine-optimize.pact.json).
The port request/response records (`OptimizeRequest`, `TrainingCandidate`,
`Trajectory`) are core's — this package never redefines them.

## Internal-only (ADR-0025)

**The training surface is internal-by-default and never part of the public
SDK surface.** App code opts a method into training with the `"use training"`
directive / `training(fn, opts)` wrapper; it never imports, configures, or
sees this engine. The optimizer is an engine behind the `training-engine`
WIT port, selected per tenant/Camp; swapping it is a config change, not an
app-code change. **Microsoft Trace and Agent Lightning are optional future
providers of the same port** (`@hobo/provider-trace`,
`@hobo/provider-agent-lightning`) — documented pattern donors per ADR-0025,
not implemented here, and equally barred from the SDK surface (external
providers additionally never receive PII-classified trajectory content).

## Surface

- `createBuiltinTrainingEngine(config)` — parses the raw config and returns
  an object satisfying core's `TrainingEnginePort` plus `drainTraceSpans()`.
  Parse, don't validate: raw config lowers onto parsed derived types
  (`OptimizerConfig`) or throws a typed `TrainingOptimizerParseError`; the
  emitted candidate goes back out through core's `parseTrainingCandidate`
  constructor so no unchecked shape crosses the boundary.
- **Deterministic by construction** — the config **requires a seed**; a
  small seeded PRNG (splitmix32, no `Math.random`) drives every proposal, so
  the same seed over the same request replays the identical proposal
  trajectory, trace spans, and winner. Best score never regresses: a
  proposal only replaces the incumbent on a strict improvement.
- **Trace capture** — every step records one span (OpenInference span-kind
  label + attributes map, `sha256:` input digest, score, keep/reject
  decision) into the in-memory sink; spans are clockless so seeded runs
  replay byte-identical. No external tracing dependency.

## Event architecture

In the platform's command → event pipeline, `OptimizeRequest` is the
command; the training pipeline's actors run this engine and append
`training.*` events (candidate proposed/scored/promoted facts) to the event
store, with each candidate's provenance pinned to `sha256:` trajectory
hashes. Materialized views / projections (with snapshots feeding read
stores) serve candidate lineage and training telemetry; the drained trace
spans are the per-step evidence those views ingest. This package itself
appends nothing — it is the pure engine those actors call behind the port.
