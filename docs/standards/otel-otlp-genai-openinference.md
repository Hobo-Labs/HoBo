---
type: Reference Standard
title: "OpenTelemetry · OTLP · OTel GenAI · OpenInference"
description: "Four interlocking telemetry standards HoBo treats as one family — the standards HoBo **emits at its boundary** instead of inventing proprietary telemetry:"
tags: [hobo, standards]
---

# OpenTelemetry · OTLP · OTel GenAI · OpenInference

> Telemetry-standards family (the data model, the wire protocol, the GenAI semconv, and the AI-span convention). Source: [opentelemetry.io](https://opentelemetry.io/) · [OTel GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/) · [Arize OpenInference](https://github.com/Arize-ai/openinference). Excerpts quoted for analysis (fair use).

## What it is

Four interlocking telemetry standards HoBo treats as one family — the standards HoBo **emits at its boundary** instead of inventing proprietary telemetry:

- **OpenTelemetry (OTel)** — the CNCF standard **data model + SDKs** for the three signals: **traces** (spans), **metrics**, and **logs**, plus shared **resource** and **context-propagation** (W3C Trace Context) semantics.
- **OTLP (OpenTelemetry Protocol)** — the **vendor-neutral wire protocol** (gRPC / HTTP-protobuf) for exporting those signals to any compatible backend.
- **OTel GenAI semantic conventions** — the `gen_ai.*` attribute namespace standardizing how **LLM/agent operations** are described as spans/metrics/events.
- **OpenInference** — Arize's **OpenTelemetry-aligned semantic convention + instrumentation libraries** for AI applications, using `openinference.*` / `llm.*` namespaces; emits OTLP and is the convention HoBo adopts for AI spans.

## Key features

### OpenTelemetry (model)
- **Signals:** Traces (a span = one operation with name, kind, timing, status, attributes, parent), Metrics (counters/gauges/histograms), Logs (structured records correlated to traces).
- **Span kinds:** `CLIENT`, `SERVER`, `INTERNAL`, `PRODUCER`, `CONSUMER`.
- **Resource** attributes (`service.name`, etc.) + **context propagation** tie spans into one distributed trace.

### OTLP (protocol)
- Transports over **gRPC** or **HTTP/protobuf**; the default export format across the OTel ecosystem.
- **Backend-neutral:** any OTLP-compatible backend (Tempo, Jaeger, Honeycomb, Datadog, Grafana, Arize Phoenix) ingests it — no vendor lock-in on the producer side.

### OTel GenAI semantic conventions (`gen_ai.*`) — experimental
- **Span name** format `{gen_ai.operation.name} {gen_ai.request.model}`; span kind `CLIENT` (or `INTERNAL` for in-process model calls).
- **Operation names** (`gen_ai.operation.name`): `chat`, `generate_content`, `embeddings`, `execute_tool`, `invoke_agent`, `create_agent`.
- **Key attributes:** `gen_ai.provider.name` (formerly `gen_ai.system`), `gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`, `gen_ai.agent.name`.
- Covers operation type, provider, model, request params, token usage, cost, finish reasons, tool calls, embeddings. Status: **experimental / still stabilizing** (the conventions moved to a dedicated `semantic-conventions-genai` repository).

### OpenInference (Arize) — OTel-aligned AI spans
- Required `openinference.span.kind` classifies each span as one of: **LLM, EMBEDDING, CHAIN, RETRIEVER, RERANKER, TOOL, AGENT, GUARDRAIL, EVALUATOR, PROMPT**.
- Attribute namespaces: `llm.*` (messages, params, tokens, cost), `embedding.*`, `input.value` / `output.value`, `retrieval.documents` / `document.*`, `tool.*`, `message.*`. Structured lists are flattened with indexed keys (e.g. `llm.input_messages.0.message.role`).
- **OTel-native and transport-agnostic** — ships drop-in auto-instrumentations that **emit OTLP spans** to any OTel backend; natively supported by **Arize Phoenix** but not tied to it.
- **Relationship to OTel GenAI:** OpenInference predates the `gen_ai.*` conventions and remains complementary; by 2026 the two namespaces are converging, with OpenInference instrumentations emitting both for backward compatibility.

## Relevance to HoBo

These standards underpin **two** HoBo concerns at once: ordinary observability **and** the AI training-data path — and HoBo's explicit stance is to **emit them, not reinvent them**.

- **Emit at the boundary, no lock-in.** [Plan 5](../design/reliability-observability-cost.md#plan-05) makes OTel/OTLP HoBo's baseline: traces across "deploys, workflows, steps, actor messages, and provider calls," "**Export via OTLP to any backend (Tempo/Jaeger/Honeycomb/Datadog)** — HoBo emits, it doesn't lock you into a backend." HoBo aligns its event/observability surface with these standards rather than a proprietary format.
- **OpenInference is the AI-span layer.** Because `"use training"` semantic functions need richer telemetry than RED metrics, HoBo layers **OpenInference on top of OTel** ([Plan 5](../design/reliability-observability-cost.md#plan-05), [Plan 23](../design/generated-stack.md#plan-23)): "every trainable-method (and agent/LLM/tool/retriever) call emits an OpenInference span … as a child of the same W3C trace." [ADR-0025](../design/adr/03-data-plane.md#adr-0025) records the decision and **rejected proprietary AI-span telemetry** "in favor of OpenInference (OTel-native, no backend lock-in)."
- **Telemetry IS the reward signal + trajectory capture.** A **trajectory** = an OpenInference span tree + I/O + the **reward** attached by live-evals ([Plan 5](../design/reliability-observability-cost.md#plan-05): "Trajectory = training data"; [Plan 23](../design/generated-stack.md#plan-23)). One emit feeds both the tenant's backend **and** HoBo's trajectory store that the [`training-engine`](../technologies/agent-lightning.md) consumes ([ADR-0025](../design/adr/03-data-plane.md#adr-0025)) — no separate lock-in path. Trajectory events are first-class: `training.TrajectoryCaptured` carries the "OTel/OpenInference span tree + I/O" ([Plan 11](../design/data-plane.md#plan-11)).
- **Feeds the SRE-agent direction.** Because HoBo emits OTLP to standard backends, an optional [HolmesGPT-style](../technologies/holmesgpt-sre-agent.md) investigation agent can read the same telemetry for root-cause analysis without a bespoke integration.
- **Open question to track.** [Plan 5](../design/reliability-observability-cost.md#plan-05) flags **OpenInference span-attribute retention vs sampling** and the **online-eval (LLM-judge) sampling rate / cost ceiling** as open — relevant because trajectory volume drives both telemetry cost and training-data quality.

## Sources

- [OpenTelemetry — opentelemetry.io](https://opentelemetry.io/)
- [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) · [GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) · [semantic-conventions-genai repo](https://github.com/open-telemetry/semantic-conventions-genai)
- [OpenInference — GitHub (Arize-ai)](https://github.com/Arize-ai/openinference) · [OpenInference semantic conventions](https://arize-ai.github.io/openinference/spec/semantic_conventions.html)
- HoBo: [Plan 5](../design/reliability-observability-cost.md#plan-05) · [Plan 23](../design/generated-stack.md#plan-23) · [Plan 11](../design/data-plane.md#plan-11) · [ADR-0025](../design/adr/03-data-plane.md#adr-0025)
