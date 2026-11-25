# @hobo/provider-agentv — Architecture Evidence

The [agentV](https://agentv.dev/) live-eval grader (ADR-0025 optional
provider; GAPS IMPL-003 live-eval slice). agentV is an MIT-licensed,
local-first agent-evaluation framework; this package uses its TypeScript SDK
(`@agentv/core`, pinned exact — the `agentv` npm package is CLI-only) to
grade **stored** agent trajectories without re-running the agent,
Microsoft-Trace-style: deterministic assertion runners (equals / contains /
regex / is-json) and caller-wired custom graders (including agentV's
`LlmGrader` judges — the caller injects provider/keys, never ambient,
secretless-first) score the recorded root-span output per metric. The
per-metric scores are the reward vector the runtime optimization loop
consumes; the overall score rides the core `TrajectoryReward`
(`source: "live-eval"`), and `@hobo/training-pipeline`'s
`aggregateEvalResults` folds a graded sample into the `EvalResult` the
three-lens promotion gate decides on. Engine-internal: selected behind the
platform's eval boundary per tenant/Camp, never part of the SDK surface.

## Schema and constraints

- Record shapes are the **generated** proto types: the reward is core's
  `TrajectoryReward` (built via `create(TrajectoryRewardSchema, …)`); this
  package's own
  [`data-models/agent_v_grade.proto`](./data-models/agent_v_grade.proto)
  describes the per-trajectory grade (score, per-metric named scores,
  pass, reason). Codegen is opted in via `data-models/buf.yaml`; generated
  types live in `src/_generated/`.
- CUE constraints bound every protobuf type in
  [`data-models/agent_v_grade.cue`](./data-models/agent_v_grade.cue)
  (scores and named scores in the unit interval, non-empty case id and
  reason), and the fixtures under
  [`data-models/fixtures/`](./data-models/fixtures/) are `cue vet`-ed by the
  codegen gate.
- PACT boundary evidence for the grade edge lives under
  [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

`grade()` crosses one parser boundary: it re-parses even trusted callers
with core's `parseTrajectory` (a deep-frozen parsed generated `Trajectory`,
CUE-mirrored invariants incl. ADR-0099 fail-closed payloads), and its
outputs are frozen **parsed/derived types** — generated messages
(`AgentVGrade`, `TrajectoryReward`) — so downstream consumers of the reward
never see raw grader DTOs.

## Event architecture

The grader is a pure function over a stored trajectory; the live-eval loop
around it is event-sourced (Plan 23 / `event-families.md`):

- **Command** — `RequestLiveEval` submits a captured trajectory for grading.
- **Event** — each grade emits the `eval.Ran` fact; gate refusals ride
  `eval.GateFailed` (via `promotionEventNames`), promotions ride
  `training.Promoted`/`impl.Promoted`.
- **Actor** — the Yard's eval actor owns grading cadence and calls this
  grader; the grader itself holds no state.
- **Event store** — trajectories are read from, and rewards/grades appended
  to, the platform event store (trajectories ride the event log, ADR-0099).
- **Materialized view / projection** — the eval projection folds `eval.*`
  events into per-metric score series for champion/challenger comparison.
- **Snapshot** — the aggregated `EvalResult` snapshot feeds the promotion
  gate (`aggregateEvalResults`, `@hobo/training-pipeline`).
- **Read store** — promotion thresholds query the eval read store for the
  standing champion's metric floors.
