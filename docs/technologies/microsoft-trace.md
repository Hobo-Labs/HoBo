---
type: Technology Reference
title: "Microsoft Trace"
description: "Microsoft **Trace** is a Python framework for **end-to-end optimization of AI systems** — the agent code, prompts, tools, retrievers, and hyperparameters around an LLM, not just th"
tags: [hobo, technologies]
---

# Microsoft Trace

> AI-optimization framework / library. Source: [microsoft/Trace](https://github.com/microsoft/Trace) · [docs](https://microsoft.github.io/Trace/) · [paper "Trace is the Next AutoDiff" (NeurIPS 2024)](https://arxiv.org/abs/2406.16218). Excerpts quoted for analysis (fair use).

## What it is

Microsoft **Trace** is a Python framework for **end-to-end optimization of AI systems** — the agent code, prompts, tools, retrievers, and hyperparameters around an LLM, not just the model weights. The research framing: while neural nets get automatic differentiation (PyTorch), "the broader AI systems built around them … remain handcrafted through extensive engineering." Trace closes that gap by treating an AI workflow as an **optimizable computational graph** and optimizing it **without gradients**.

Its mathematical core is **OPTO (Optimization with Trace Oracle)**: an optimizer receives an **execution trace** plus **feedback** on the output (a numerical loss, natural-language critique, or a runtime/compiler error) and iteratively updates the trainable parameters. Execution traces "are akin to back-propagated gradients in AutoDiff." The authors describe Trace as "a new AutoDiff-like tool for training AI systems without using gradients."

It is the optimizer HoBo's design explicitly cites for the **auto-diff / OPTO** approach to evolving in-place implementations.

## Key features

- **PyTorch-like programming model.** Wrap values and functions to build a dynamic graph:
  - `node(value, trainable=True)` declares a **trainable parameter** (a prompt string, a code snippet, a hyperparameter); the library auto-traces operations on nodes to build the graph.
  - `@bundle(...)` (the `trace_op` / bundle decorator) wraps an arbitrary Python function so its execution is captured as an optimizable graph node — code becomes a learnable component.
- **General feedback, not just scalars.** `.backward(feedback)` propagates feedback through the graph; feedback may be a numerical reward, natural-language text, or an error message — "generalizing the back-propagation algorithm by capturing and propagating an AI system's execution trace."
- **Propagates "Minimal Subgraphs"** (the relevant slice of the trace) rather than gradients, and can recover gradients where applicable.
- **Swappable LLM-based optimizers** (change optimizer without changing the program):
  - **OptoPrime** — the flagship Trace optimizer; an LLM-based generative optimizer (reported ~2–3× faster than TextGrad), competitive across prompt optimization, hyperparameter tuning, code debugging, and robot control.
  - **OPRO** ("LLMs as Optimizers") and **TextGrad** ("automatic 'differentiation' via text") provided as alternatives.
- **Dynamic graphs** — the graph can change with inputs/parameters across iterations (suits agentic control flow).
- **LLM backend** via **LiteLLM** (API-key management + caching); **AutoGen v0.2** supported as an alternative backend.
- **License: MIT**; Python ≥ 3.9. Demonstrated on LLM agents, prompt optimization, hyperparameter tuning, code debugging, and robot control (the paper reports a ~1000× sample-efficiency win on a control task).

## Relevance to HoBo

Trace is one of the three optimization approaches HoBo names for the engine behind its **`training-engine` port** — and it is the one HoBo's own docs cite for the **OPTO / auto-diff** style.

- **Named optional, internal provider.** [ADR-0025](../design/adr/03-data-plane.md#adr-0025) makes Microsoft Trace (`@hobo/provider-trace`) an **optional adapter behind the `training-engine` WIT port**, selected per tenant/Camp and **never part of the SDK surface**. "From Trace: treat the graph of trainable methods as an optimizable computational graph; feedback propagates back and rewrites trainable parameters in place (OPTO)." HoBo also ships a **built-in default** OPTO/prompt-rewrite optimizer, so Trace is swap-in, not a hard dependency.
- **Maps cleanly onto `"use training"`.** A method marked `"use training"` ([Plan 23](../design/generated-stack.md#plan-23)) is exactly a Trace **trainable node**: the body/prompt is the parameter, the **contract** is the hard boundary, and the **rubric/live-eval reward** is the feedback `.backward()` consumes. The "stub → implement → trace → auto-evolve → live-fix" loop is Trace's iterate-against-feedback loop with HoBo's promotion gate bolted on.
- **The reward IS the feedback signal.** HoBo attaches a reward to each trajectory from **live-evals** (Plan 23 §Live-evals); that score "is what Trace propagates." Trace's tolerance for non-scalar feedback (NL critiques, contract/conformance failures, trace diffs) matches HoBo's signals exactly.
- **Forge generation/repair reuse.** [Plan 23](../design/generated-stack.md#plan-23) routes conformance-assertion failures and trace diffs to the **`training-engine` optimizer (OPTO/Trace)** as the repair feedback — "same optimizer, same gate" for both generation and evolution.
- **Why it sits behind a port (not in the SDK).** Trace pulls in LiteLLM/AutoGen and ML machinery; surfacing that would violate HoBo's agnostic-SDK stance ([ADR-0025](../design/adr/03-data-plane.md#adr-0025) "Alternatives considered"). The port lets HoBo adopt Trace internally without SDK churn.
- **Contrast with the siblings.** Trace = **auto-diff/OPTO over a graph, in-place parameter rewrite**; [DSPy](./dspy.md) = **declarative compile/optimize** of a typed pipeline; [Agent Lightning](./agent-lightning.md) = **RL trainer decoupled from execution**. All three are candidate engines behind the *same* port — see [ADR-0025](../design/adr/03-data-plane.md#adr-0025).

## Sources

- [microsoft/Trace — GitHub](https://github.com/microsoft/Trace)
- [Trace documentation](https://microsoft.github.io/Trace/)
- [Trace is the Next AutoDiff (arXiv 2406.16218)](https://arxiv.org/abs/2406.16218)
- [Microsoft Research blog — Tracing the path to self-adapting AI agents](https://www.microsoft.com/en-us/research/blog/tracing-the-path-to-self-adapting-ai-agents/)
- HoBo: [ADR-0025](../design/adr/03-data-plane.md#adr-0025) · [Plan 23](../design/generated-stack.md#plan-23) · [Plan 23](../design/generated-stack.md#plan-23)
