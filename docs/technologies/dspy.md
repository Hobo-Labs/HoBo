---
type: Technology Reference
title: "DSPy"
description: "**DSPy** (\"Declarative Self-improving Python,\" from Stanford NLP) is a framework for **\"programming — not prompting — language models.\"** Instead of hand-tuning prompt strings, you"
tags: [hobo, technologies]
---

# DSPy

> Declarative framework for programming language models. Source: [dspy.ai](https://dspy.ai/) · [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy) · [optimizers docs](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md). Excerpts quoted for analysis (fair use).

## What it is

**DSPy** ("Declarative Self-improving Python," from Stanford NLP) is a framework for **"programming — not prompting — language models."** Instead of hand-tuning prompt strings, you write a typed, modular program: declare **Signatures** (what a step does, in terms of input/output fields), compose them into **Modules** (parameterized LM-calling components), and then **compile** the program with an **optimizer** that searches for the prompts, instructions, and few-shot demonstrations (and optionally weights) that maximize a metric on your data.

The shift is from brittle prompt strings to a **declarative, compilable pipeline**: the same program can be re-optimized for a new model, new data, or a new metric without rewriting prompts by hand.

## Key features

- **Signatures** — a declarative spec of a transformation, e.g. `"question -> answer"` or a typed class with `InputField`/`OutputField`. The signature states *what* should happen; DSPy figures out the prompt.
- **Modules** — composable, learnable building blocks parameterized by a signature:
  - `dspy.Predict` (basic LM call), `dspy.ChainOfThought` (adds reasoning), `dspy.ReAct` (tool-using agent loop), `ProgramOfThought`, `Retrieve`, etc. Modules compose into larger programs (a `dspy.Module` subclass with a `forward`).
- **Optimizers (teleprompters)** — search prompts/demos/weights against a `metric`. All share the interface `optimizer = dspy.Optimizer(metric=..., **cfg); optimized = optimizer.compile(program, trainset=...)`:
  - **LabeledFewShot** — builds few-shot demos straight from labeled data (no metric needed).
  - **BootstrapFewShot** — uses a teacher module to **generate demonstrations** for each stage, keeping examples that pass the metric.
  - **BootstrapFewShotWithRandomSearch** — repeats bootstrapping with random search over candidate programs.
  - **KNNFewShot** — selects nearest-neighbor demos per input (no metric required).
  - **COPRO** — generates and refines **instructions** per step via coordinate ascent.
  - **MIPRO / MIPROv2** — jointly optimizes **instructions *and* few-shot examples** using Bayesian optimization across modules.
  - **GEPA** — reflective prompt evolution: the LM reflects on the program's trajectory to identify what worked / didn't and proposes improved prompts.
  - **SIMBA** — samples challenging examples, then self-reflects to generate improvement rules.
  - **BootstrapFinetune** — distills a prompt-based program into **weight updates** (fine-tuning).
  - **Ensemble** / **BetterTogether** — combine multiple programs, or sequence prompt- and weight-optimization.
- **Metric-driven** — most optimizers require a `metric(example, prediction) -> score|bool` that defines "better"; the optimizer maximizes it.
- **Model/provider-agnostic** — programs target a configured `dspy.LM`; recompile to retarget a model. Apache-2.0, large open-source ecosystem.

## Relevance to HoBo

DSPy is the **declarative compile/optimize** approach in HoBo's optimization trio — a candidate engine behind the **same `training-engine` port** as [Trace](./microsoft-trace.md) and [Agent Lightning](./agent-lightning.md).

- **Maps to the port, not the SDK.** [ADR-0025](../design/adr/03-data-plane.md#adr-0025) names Trace and Agent Lightning explicitly; DSPy is a natural third adapter behind the same **`training-engine` WIT port**, kept **internal and swappable** under the same rule (optimizer choice is config, never app code). DSPy's compile-time prompt/demo search is an alternative to OPTO's in-place rewrite and RL.
- **Signatures ≈ HoBo's semantic-function grounding.** A `"use training"` method ([Plan 23](../design/generated-stack.md#plan-23)) must carry **intent + typed contract + rubric** ([ADR-0025](../design/adr/03-data-plane.md#adr-0025)). That is essentially a DSPy **Signature** (typed I/O + instruction) plus a **metric** (the rubric). HoBo's contract (must-never-break) bounds the search; the rubric is the metric DSPy compiles against.
- **The rubric is the metric.** HoBo's **live-evals** attach a reward to each trajectory ([Plan 5](../design/reliability-observability-cost.md#plan-05) / Plan 23); a DSPy optimizer would consume that same reward as its `metric` — `BootstrapFewShot`/`MIPROv2`/`GEPA` searching prompts and demos to maximize the live-eval score.
- **Trajectories as a trainset.** HoBo's captured trajectories (OpenInference span tree + I/O + reward, [Plan 11](../design/data-plane.md#plan-11) `training.TrajectoryCaptured`) are exactly the labeled examples a DSPy `compile(trainset=...)` call needs; the stub's recorded traces ([Plan 23](../design/generated-stack.md#plan-23)) seed an initial trainset.
- **Forge generation/repair.** [Plan 23](../design/generated-stack.md#plan-23) reuses the `training-engine` for generate→validate→repair; a DSPy compile pass is one valid way to synthesize/repair a candidate against the conformance + trace-diff signal before the shared gate.
- **Contrast with the siblings.** DSPy = **declarative, metric-driven compile/optimize of a typed pipeline (prompts/demos, optionally weights)**; [Trace](./microsoft-trace.md) = **auto-diff/OPTO in-place rewrite via richer feedback**; [Agent Lightning](./agent-lightning.md) = **RL trainer decoupled from execution**.

## Sources

- [DSPy — dspy.ai](https://dspy.ai/)
- [DSPy optimizers documentation](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md)
- [MIPROv2 API](https://dspy.ai/api/optimizers/MIPROv2/)
- [stanfordnlp/dspy — GitHub](https://github.com/stanfordnlp/dspy)
- HoBo: [ADR-0025](../design/adr/03-data-plane.md#adr-0025) · [Plan 23](../design/generated-stack.md#plan-23) · [Plan 11](../design/data-plane.md#plan-11) · [Plan 5](../design/reliability-observability-cost.md#plan-05) · [Plan 23](../design/generated-stack.md#plan-23)
