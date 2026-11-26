---
type: Technology Reference
title: "Microsoft Agent Lightning"
description: "**Agent Lightning** is Microsoft's open-source framework for **training and optimizing AI agents** — billed as \"the absolute trainer to light up AI agents.\" Its defining design is "
tags: [hobo, technologies]
---

# Microsoft Agent Lightning

> Agent training framework (RL / optimization trainer). Source: [docs](https://microsoft.github.io/agent-lightning/stable/) · [Trainer reference](https://microsoft.github.io/agent-lightning/stable/reference/trainer/) · [microsoft/agent-lightning](https://github.com/microsoft/agent-lightning) · [paper (arXiv 2508.03680)](https://arxiv.org/abs/2508.03680). Excerpts quoted for analysis (fair use).

## What it is

**Agent Lightning** is Microsoft's open-source framework for **training and optimizing AI agents** — billed as "the absolute trainer to light up AI agents." Its defining design is **Training-Agent Disaggregation**: it **decouples agent execution from model training**, so an existing agent (built with any framework, or none) can be made optimizable "with ZERO CODE CHANGE (almost)."

The agent runs as it normally would and **emits execution data**; a separate training side consumes that data and produces improved models/prompts. Because execution and training are split over a client/server boundary, "it is possible to scale your RL training without interfering with your production agent." It "embraces Algorithms like Reinforcement Learning, Automatic Prompt Optimization, Supervised Fine-tuning and more," and can "selectively optimize one or more agents in a multi-agent system."

This decoupled model is the one HoBo cites for the **"capture trajectories in the runtime, train out-of-band"** approach.

## Key features

- **Training-Agent Disaggregation** — a three-component architecture:
  - **Agent Runner** runs your agent (CPU / app logic and tools);
  - **LightningStore** collects execution data through standardized interfaces (the trajectory store);
  - **Algorithm layer** trains models on GPU, using **LightningRL** — a **hierarchical RL** scheme that decomposes multi-step agent behavior, supporting multiple agents, complex tool use, and **delayed feedback**.
- **Framework-agnostic, near-zero-code** — wraps agents built with LangChain, OpenAI Agents SDK, AutoGen, CrewAI, LangGraph, Microsoft Agent Framework, or plain Python.
- **Multiple optimization algorithms** — Reinforcement Learning (e.g. PPO/GRPO-style), Automatic Prompt Optimization (APO), and Supervised Fine-tuning.
- **Optional `llm_proxy`** to intercept LLM calls for capture/serving.

### Trainer API surface

The **`Trainer`** class is the single high-level entry point that wires Algorithm ↔ Runner ↔ Store. From the [Trainer reference](https://microsoft.github.io/agent-lightning/stable/reference/trainer/):

- **Constructor** (keyword-only) — `Trainer(*, dev=False, n_runners=None, max_rollouts=None, initial_resources=None, tracer=None, adapter=None, store=None, runner=None, strategy=None, port=None, algorithm=None, llm_proxy=None, n_workers=None, max_tasks=None, daemon=True, triplet_exporter=None, hooks=None)`. Notable params:
  - `algorithm` — the training algorithm instance; `runner` — runner impl (defaults to `LitAgentRunner`); `store` — the LightningStore persistence;
  - `strategy` — the **ExecutionStrategy** backend (shared-memory vs client/server); `n_runners` — parallel runner count; `max_rollouts` — per-runner rollout cap;
  - `adapter` — converts traces into algorithm-consumable data; `tracer` — telemetry collection; `hooks` — lifecycle callbacks; `initial_resources` — bootstrap resources; `port` — HTTP port for client/server.
- **`fit(agent, train_dataset=None, *, val_dataset=None)`** — runs the full algorithm/runner training loop until datasets are exhausted, `max_rollouts` triggers exit, or an exception/interrupt occurs.
- **`dev(agent, train_dataset=None, *, val_dataset=None)`** — fast synchronous debug variant (requires a `FastAlgorithm`); exercises the same store/runners/hooks/telemetry plumbing as `fit()`.
- **ExecutionStrategy** implementations — `SharedMemoryExecutionStrategy` (single process, worker threads) and `ClientServerExecutionStrategy` (separate processes over HTTP; `role` = `"algorithm"` | `"runner"` | `"both"`, with `server_host`/`server_port`, `n_runners`, graceful/terminate timeouts).
- **`build_component(spec, *, expected_type, ...)`** — factory accepting an instance, class, import-path string, config dict, or factory callable, used to resolve the Trainer's pluggable components.

## Relevance to HoBo

Agent Lightning is the **RL-trainer** member of the trio behind HoBo's **`training-engine` port**, and its disaggregated architecture mirrors HoBo's own control-plane/data-plane split almost exactly.

- **Named optional, internal provider.** [ADR-0025](../design/adr/03-data-plane.md#adr-0025) makes Agent Lightning (`@hobo/provider-agent-lightning`) an **optional adapter behind the `training-engine` WIT port**, per-tenant/Camp, and **never on the SDK surface**: "From Agent Lightning: decouple execution from training — the running method emits trajectories; a separate trainer/store optimizes via RL (GRPO/PPO), APO, or SFT. This mirrors HoBo's data-plane/control-plane split."
- **Architectural fit is 1:1.** [Plan 23](../design/generated-stack.md#plan-23) states it plainly: "the Camp's runtime runs the method, the Yard's training-engine optimizes it offline/async. **HoBo may use Agent Lightning itself as the provider behind the port** to run the trainer." HoBo's runtime = Agent Lightning's **Agent Runner**; HoBo's **trajectory store** (riding the event log) = **LightningStore**; the Yard-side trainer = the **Algorithm layer / LightningRL**.
- **Trajectories are the interchange unit.** HoBo defines a *trajectory* = OpenInference span tree + I/O + a **reward** from live-evals ([Plan 5](../design/reliability-observability-cost.md#plan-05) / Plan 23). That is precisely the rollout data LightningStore collects and the `adapter` feeds the algorithm; "the live-eval score is … what Agent Lightning's RL maximizes."
- **Decoupling = scale without runtime risk.** Agent Lightning's promise that you can "scale your RL training without interfering with your production agent" is exactly why HoBo trains **out-of-band in the Yard** while the Camp keeps serving — no training cost on the request path.
- **Same trust gate, no new path.** A trained candidate goes through HoBo's **existing gated promotion** (sandboxed conformance + eval thresholds + policy + champion/challenger/shadow), emitting `training.*` events ([Plan 11](../design/data-plane.md#plan-11): `training.TrajectoryCaptured`, `training.RewardObserved`, `training.CandidateProposed`, `training.Promoted`).
- **Contrast with the siblings.** Agent Lightning = **RL trainer, decoupled from execution** (best fit for "capture in runtime, train offline"); [Microsoft Trace](./microsoft-trace.md) = **auto-diff/OPTO in-place rewrite**; [DSPy](./dspy.md) = **declarative compile/optimize**. All three plug into the *same* port.

## Sources

- [Agent Lightning — overview docs](https://microsoft.github.io/agent-lightning/stable/)
- [Agent Lightning — Trainer API reference](https://microsoft.github.io/agent-lightning/stable/reference/trainer/)
- [microsoft/agent-lightning — GitHub](https://github.com/microsoft/agent-lightning)
- [Agent Lightning: Train ANY AI Agents with Reinforcement Learning (arXiv 2508.03680)](https://arxiv.org/abs/2508.03680)
- HoBo: [ADR-0025](../design/adr/03-data-plane.md#adr-0025) · [Plan 23](../design/generated-stack.md#plan-23) · [Plan 11](../design/data-plane.md#plan-11) · [Plan 5](../design/reliability-observability-cost.md#plan-05)
