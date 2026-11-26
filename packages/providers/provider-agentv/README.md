# @hobo/provider-agentv

The [agentV](https://agentv.dev/) live-eval grader (ADR-0025 optional provider;
IMPL-003 live-eval slice). `createAgentVLiveEvalGrader` grades **stored** agent
trajectories without re-running the agent, Microsoft-Trace-style: agentV's
deterministic assertion runners (`equals` / `contains` / `icontains` / `regex` /
`is-json`) and caller-wired `custom` scorers grade the recorded root-span output
per metric, producing the reward vector the optimization loop consumes.
See [`ADR.md`](./ADR.md).

## Honest scope

Implemented: metric lowering onto `@agentv/core` assertion runners (pinned
exact — the `agentv` npm package is CLI-only), per-metric scoring, and the
`AgentVGrade` + core `TrajectoryReward` (`source: "live-eval"`) outputs that
`@hobo/training-pipeline`'s `aggregateEvalResults` folds into an `EvalResult`.
LLM judging is deliberately not ambient: agentV `LlmGrader` judges enter only
through the `custom` escape hatch with caller-injected provider/keys —
secretless-first, no network calls of this package's own. The grader holds no
state and schedules nothing.

## Commands

```bash
pnpm --filter @hobo/provider-agentv run build
pnpm --filter @hobo/provider-agentv run typecheck
pnpm --filter @hobo/provider-agentv run lint
pnpm --filter @hobo/provider-agentv run test
```

## Parse, don't validate

`grade()` crosses one parser boundary: it re-parses even trusted callers with
core's `parseTrajectory` (a deep-frozen parsed `Trajectory` with CUE-mirrored,
ADR-0099 fail-closed invariants), and its outputs are frozen derived types —
the generated `AgentVGrade` and core `TrajectoryReward` messages — so consumers
of the reward never see raw grader DTOs. Parse, don't validate. Wire forms live
in `data-models/agent_v_grade.proto` with CUE constraints alongside.

## Position in the event architecture

The grader is a pure function over a stored trajectory; it hosts no actor and
appends nothing itself. In the platform loop, `RequestLiveEval` is the command;
each grade emits the `eval.Ran` fact (refusals ride `eval.GateFailed` via the
promotion gate); the Yard's eval actor owns grading cadence and calls this
grader; trajectories are read from and rewards/grades appended to the platform
event store, and the eval projection folds `eval.*` events into per-metric
score series for champion/challenger comparison.
