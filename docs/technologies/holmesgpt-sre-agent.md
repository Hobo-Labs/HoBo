---
type: Technology Reference
title: "HolmesGPT / CNCF SRE Agent"
description: "**HolmesGPT** is an open-source (**Apache 2.0**) **AI agent for investigating production incidents and finding root causes**, originally built by Robusta with major contributions f"
tags: [hobo, technologies]
---

# HolmesGPT / CNCF SRE Agent

> AI SRE / root-cause investigation agent (CNCF Sandbox). Source: [HolmesGPT/holmesgpt](https://github.com/HolmesGPT/holmesgpt) · [CNCF blog](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/). Excerpts quoted for analysis (fair use).

## What it is

**HolmesGPT** is an open-source (**Apache 2.0**) **AI agent for investigating production incidents and finding root causes**, originally built by Robusta with major contributions from Microsoft, and accepted into the **CNCF Sandbox in October 2025** — the reference implementation of the cloud-native "**SRE Agent**" direction. It works with "any stack — Kubernetes, VMs, cloud providers, databases, and SaaS platforms."

It is **agentic**: rather than a one-shot prompt, it runs an **investigation loop** that "actively decides what data to fetch, runs targeted queries, and iteratively refines its hypotheses — all while staying within your environment," combining **observability telemetry, LLM reasoning, and structured runbooks** to accelerate root-cause analysis and suggest next actions.

## Key features

- **Agentic investigation loop** — iteratively calls tools, gathers data from multiple sources, correlates findings, and builds a coherent root-cause analysis; **memory-safe execution** with per-tool limits and streaming.
- **Toolsets / data sources (50+ integrations)** — pluggable connectors the agent calls during an investigation:
  - **Observability & monitoring:** Prometheus, Grafana, Datadog, Loki, New Relic, Elastic/OpenSearch, Splunk, Tempo, VictoriaMetrics/VictoriaLogs, Coralogix.
  - **Containers & infra:** Kubernetes, OpenShift, Docker, Helm, AKS, Crossplane.
  - **Cloud:** AWS (RDS, instances), Azure, GCP.
  - **Databases:** PostgreSQL, MySQL, MongoDB, SQL Server, ClickHouse, Azure SQL.
  - **Queues / CI-CD / ticketing:** Kafka, RabbitMQ, ArgoCD, Jenkins, GitHub, GitLab, PagerDuty, OpsGenie, Jira, ServiceNow; knowledge bases like Confluence/Notion.
- **Runbooks** — structured, human-authored investigation procedures the agent follows to standardize and steer root-cause analysis for known alert types.
- **Bidirectional alert workflows** — can "fetch alerts from AlertManager, PagerDuty, OpsGenie, or Jira — and write findings back" to those systems or Slack.
- **MCP (Model Context Protocol) support** for extending the agent with additional tools/integrations.
- **Provider-agnostic LLM** — OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Gemini, and others via configurable endpoints.
- **Deployment** — CLI and HTTP API; runnable without Kubernetes.

## Relevance to HoBo

HolmesGPT is the canonical **"investigate failure"** agent — a strong fit as the **optional engine behind the SRE operator's diagnosis port** ([Plan 40](../design/operators-sre.md#plan-40)/[Plan 40](../design/operators-sre.md#plan-40)), and a model for how an SRE agent should consume telemetry HoBo already emits.

- **Pairs with AI live-fix.** HoBo's **AI live-fix** ([Plan 23](../design/generated-stack.md#plan-23) §Live-fix, [Plan 5](../design/reliability-observability-cost.md#plan-05)) triggers an AI-proposed fix when "a failing trace or SLO/health breach" occurs, then validates it through the gated canary/rollback saga. HolmesGPT supplies the missing front half: **root-cause investigation** that turns a failing trace/alert into a diagnosis before a fix candidate is proposed.
- **Drift & incident response.** HoBo detects **drift** and emits `resource.DriftDetected` ([Plan 5](../design/reliability-observability-cost.md#plan-05) §Drift detection & self-healing); a HolmesGPT-style agent could investigate *why* drift or an SLO breach happened, correlating across the same observability sources HoBo exports to.
- **Consumes HoBo's emitted telemetry — no new path.** HolmesGPT reads Prometheus/Grafana/Loki/Tempo/Kubernetes; HoBo **emits OTel/OTLP and OpenInference at its boundary** ([Plan 5](../design/reliability-observability-cost.md#plan-05), [docs/standards/otel-otlp-genai-openinference.md](../standards/otel-otlp-genai-openinference.md)) to exactly those backends. An SRE-agent provider would investigate over standards HoBo already speaks, not a proprietary feed.
- **Fits as a provider behind a port, gated.** Consistent with HoBo's stance ([ADR-0025](../design/adr/03-data-plane.md#adr-0025)), an "investigate failure" capability belongs **behind a WIT port as an optional provider**, with its output feeding the gated live-fix/GitOps flow rather than acting autonomously. HolmesGPT's **runbooks** also align with HoBo's **Agent/GitOps pipelines** ([Plan 25](../design/platform-engineering.md#plan-25)) — codified investigation/remediation steps under review.
- **Standards alignment.** Both lean on **CNCF + OpenTelemetry** primitives; adopting HolmesGPT keeps HoBo in the cloud-native ecosystem rather than building a bespoke diagnosis engine.

## Sources

- [HolmesGPT — GitHub](https://github.com/HolmesGPT/holmesgpt)
- [CNCF — HolmesGPT: Agentic troubleshooting built for the cloud native era](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)
- [CNCF — Auto-diagnosing Kubernetes alerts with HolmesGPT and CNCF tools](https://www.cncf.io/blog/2026/04/21/auto-diagnosing-kubernetes-alerts-with-holmesgpt-and-cncf-tools/)
- HoBo: [Plan 5](../design/reliability-observability-cost.md#plan-05) · [Plan 23](../design/generated-stack.md#plan-23) · [Plan 25](../design/platform-engineering.md#plan-25) · [Plan 5](../design/reliability-observability-cost.md#plan-05) · [ADR-0025](../design/adr/03-data-plane.md#adr-0025)
