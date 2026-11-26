---
type: Technology Reference
title: "agentV"
description: "Local-first AI agent evaluation and optimization framework: multi-objective scoring from YAML specs or the TypeScript SDK, deterministic and LLM graders, trajectory assertions, portable trace artifacts."
tags: [hobo, technologies]
---

# agentV

> Local-first agent-evals framework ("evals that make agents better — no server, no signup"). Source: [agentv.dev](https://agentv.dev/), [docs](https://agentv.dev/docs/), [GitHub (EntityProcess/agentv, MIT)](https://github.com/EntityProcess/agentv). Quoted briefly under fair use.

## What it is

An MIT-licensed, actively maintained evaluation + optimization framework for
AI agents. Eval cases live as YAML in Git; runs produce portable JSON/JSONL
artifacts (`grading.json`, `transcript.json`) with normalized scores in
`[0, 1]` and per-metric `named_scores`. Ships as the `agentv` CLI and the
`@agentv/core` TypeScript SDK (the npm `agentv` package is CLI-only — SDK
consumers import `@agentv/core`).

## Key features

- **Graders as plain code or LLM judges** — deterministic assertion runners
  (`runEqualsAssertion`, `runContainsAssertion`, `runRegexAssertion`,
  `runIsJsonAssertion`, …) returning `{ score, assertions }`; custom
  assertions via `defineAssertion()`; `LlmGrader` judges configured with
  named providers and env-interpolated keys (never inline).
- **Multi-objective scoring** — weighted rubrics, composite graders,
  per-metric `named_scores`, verdicts derived from a configurable threshold
  (`scoreToVerdict`, default 0.8).
- **Trajectory assertions** — tool-used / tool-sequence / step-count /
  goal-success checks over a provider-neutral normalized transcript.
- **Offline grading of stored traces** — grade existing agent sessions
  without re-running them (`--transcript`, or SDK grading over recorded
  output); OTel/OpenInference correlation via `external_trace` metadata
  rather than native ingestion.
- **Local-first** — no server; results are files in Git-friendly bundles.

## Relevance to HoBo

- **Adopted behind the platform's eval boundary** as the live-eval grader
  provider: [`@hobo/provider-agentv`](../../packages/providers/provider-agentv/ADR.md)
  grades **stored** trajectories (no agent re-run) with `@agentv/core`'s
  deterministic runners plus caller-wired custom/LLM graders, emitting the
  core `TrajectoryReward` (`source: "live-eval"`) and a generated
  `AgentVGrade` with the per-metric reward vector — the feedback signal the
  [Microsoft Trace](./microsoft-trace.md)-style optimization loop consumes
  ([ADR-0025](../design/adr/03-data-plane.md#adr-0025) engines-behind-ports;
  never on the SDK surface).
- **Feeds the gated promotion pipeline**: per-trajectory grades aggregate
  via `aggregateEvalResults` (`@hobo/training-pipeline`) into the generated
  `EvalResult` the three-lens promotion gate decides on
  ([Plan 23](../design/generated-stack.md#plan-23); `eval.Ran` /
  `eval.GateFailed` facts per [event-families](../design/event-families.md)).
- **Gap HoBo owns**: agentV has no always-on online harness or native
  OTel/OpenInference ingestion — HoBo's runtime drives per-trace grading and
  keeps trajectory capture (OTel + OpenInference spans) as its own slice
  (GAPS IMPL-003 remainder).

## Sources

- <https://agentv.dev/> · <https://agentv.dev/docs/>
- <https://agentv.dev/docs/graders/custom-assertions/> · <https://agentv.dev/docs/graders/llm-graders/> · <https://agentv.dev/docs/graders/trajectory-assertions/>
- <https://agentv.dev/docs/reference/result-artifacts/>
- <https://github.com/EntityProcess/agentv> · <https://www.npmjs.com/package/agentv>
