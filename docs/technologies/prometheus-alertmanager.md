---
type: Technology Reference
title: "Prometheus Alertmanager"
description: "Alertmanager \"handles alerts sent by client applications such as the Prometheus server.\" It is a **separate process** from Prometheus: Prometheus *evaluates alerting rules and fire"
tags: [hobo, technologies]
---

# Prometheus Alertmanager

> **Technology** · The alert routing/grouping/silencing/inhibition layer for the Prometheus ecosystem. Source: [prometheus.io/docs/alerting](https://prometheus.io/docs/alerting/latest/alertmanager/) · [Configuration reference](https://prometheus.io/docs/alerting/latest/configuration/) · [prometheus/alertmanager (GitHub)](https://github.com/prometheus/alertmanager). Excerpts quoted for analysis (fair use).

## What it is
Alertmanager "handles alerts sent by client applications such as the Prometheus server." It is a **separate process** from Prometheus: Prometheus *evaluates alerting rules and fires alerts*; Alertmanager *takes those alerts and turns them into the right notifications to the right people*. Its job is to take "care of **deduplicating, grouping, and routing** them to the correct receiver integration such as email, PagerDuty, or OpsGenie," plus **silencing** and **inhibition** of alerts. It is the de-facto standard alerting backend in the Prometheus/CNCF observability stack.

## The alerting model (Prometheus + Alertmanager)
1. **Alerting rules** live in Prometheus: an `alert:` with an `expr:` (PromQL), a `for:` (pending duration before firing), plus `labels:` (e.g. `severity`) and `annotations:` (human text). When `expr` holds for `for`, the alert goes **firing**.
2. Prometheus **pushes** firing alerts to Alertmanager over its API (and re-sends while still firing; sends a **resolved** when the condition clears).
3. Alertmanager **dedups** identical alerts (e.g. from HA-paired Prometheus servers), **groups** related ones, applies **inhibition** and **silences**, then **routes** each group to **receivers** and sends notifications. Alerts carry a `status` of `firing` or `resolved`; each is identified by a `fingerprint` over its label set.

## Key features
- **Routing tree (`route`)** — a hierarchical tree; the **root route must match all alerts**. Each node has:
  - `receiver` — where matching alerts go.
  - `matchers` — label matchers selecting which alerts enter this node.
  - `group_by` — labels that define an alert *group* (e.g. `['alertname','cluster']`; `['...']` disables aggregation).
  - `group_wait` (default 30s) — wait before the first notification for a new group (lets related alerts batch).
  - `group_interval` (default 5m) — wait before notifying about *new* alerts added to an existing group.
  - `repeat_interval` (default 4h) — how long before re-notifying an already-sent, still-firing group.
  - `continue` (default false) — whether to keep matching sibling routes after a match.
  - `routes` — nested child routes (matched depth-first).
  - `mute_time_intervals` / `active_time_intervals` — bind named time intervals to mute/allow the node.
- **Grouping** — collapses many alerts of a similar nature into one notification, "especially useful during larger outages when many systems fail at once" — turning hundreds of alerts into a single actionable page.
- **Deduplication** — repeated/duplicate alerts (same labels, e.g. from redundant Prometheus instances) collapse to one, so you "don't get spammed by the same issue."
- **Inhibition (`inhibit_rules`)** — mute a **target** alert when a **source** alert is firing: `source_matchers`, `target_matchers`, and `equal` (label names that must match between source and target). E.g. a "whole cluster down" alert inhibits the per-node alerts for that cluster.
- **Silencing (silences)** — time-bounded mutes created at runtime (UI/API/`amtool`) via label matchers; incoming alerts matching an active silence are suppressed for its duration.
- **Receivers (`receivers`)** — named notification destinations; each bundles integration configs: `email_configs`, `slack_configs`, `pagerduty_configs`, `opsgenie_configs`, `webhook_configs` (generic HTTP — the integration hook), plus `victorops_configs`, `pushover_configs`, `sns_configs`, `telegram_configs`, `msteams_configs`, `discord_configs`, `webex_configs`, and more.
- **`global`** — shared defaults (SMTP, integration API URLs/keys, HTTP client config).
- **`time_intervals`** — named time windows (`times`, `weekdays`, `days_of_month`, `months`, `years`, `location`) referenced by routes for on-hours/maintenance windows.
- **`templates`** — Go-template files customizing notification content.
- **High availability** — Alertmanager runs as a **gossip-clustered** set of peers that share silences/notification state so a clustered deploy dedups and doesn't double-notify.

## Relevance to HoBo
HoBo already commits to **built-in SLOs with burn-rate alerts** and treats **alert routing as a provider capability** today: [Plan 14 §SLOs & alerting](../design/reliability-observability-cost.md#plan-05) says "Alert routing is a provider capability (`email`/webhook/PagerDuty)," and high-risk **policy gates** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)/[Plan 29](../design/contracts-policy-flags.md#plan-29)) "can post to the same channels for human approval." Alertmanager is the **reference design** for exactly that capability — its routing/grouping/inhibition/silencing model is the pattern HoBo's alerting should follow, and a real Alertmanager is a strong candidate to sit **behind a HoBo `alerting`/notification port** (the recurring "optional capability provider behind a WIT port" stance from [`README`](./index.md)).

**Where the model maps:**
- **Routing tree → policy-shaped fan-out.** HoBo's alert sources are heterogeneous — SLO burn-rate breaches ([Plan 5](../design/reliability-observability-cost.md#plan-05), declared via OpenSLO, see [`../standards/openslo.md`](../standards/openslo.md)), `resource.DriftDetected` ([Plan 5 §Drift](../design/reliability-observability-cost.md#plan-05)), the **runaway-spend circuit-breaker** `spend.CircuitTripped` ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)), and **policy obligations** that require human approval ([Plan 29](../design/contracts-policy-flags.md#plan-29)). A routing tree keyed on labels like `tenant`/`severity`/`camp` is the right structure to send each to the correct receiver — and HoBo already carries `tenant`, `actor`, and trace context in every envelope ([Plan 11](../design/data-plane.md#plan-11)), so the grouping/routing labels exist natively.
- **Grouping + dedup → storm control.** A failing deploy or a degraded provider can emit a burst of `resource.Failed`/`exec.Failed` events ([Plan 11](../design/data-plane.md#plan-11)) and trip a per-`(provider,region,operation)` circuit breaker ([Plan 5 §Provider resilience](../design/reliability-observability-cost.md#plan-05)). Grouping by `correlationId`/`deployment`/`provider` collapses that into one actionable notification instead of paging on every resource — exactly Alertmanager's outage-grouping value.
- **Inhibition → causal suppression.** HoBo's `causationId`/`correlationId` chain ([Plan 11](../design/data-plane.md#plan-11)) is richer than Alertmanager's `equal` label-matching: a "Camp unreachable" or "circuit open" alert should inhibit the downstream per-resource alerts it caused. The inhibition *pattern* is right; HoBo can drive it from real causality rather than label coincidence.
- **Silencing → maintenance + waivers.** Time-bounded silences map onto HoBo's `time_intervals` (maintenance windows) and onto **policy waivers** (`policy.WaiverApproved`, [Plan 29](../design/contracts-policy-flags.md#plan-29)) — an approved waiver is effectively a scoped, audited silence.
- **Health-driven reactions.** Beyond notifying humans, HoBo's gated-saga machinery ([Plan 5](../design/reliability-observability-cost.md#plan-05)) consumes the *same* breach signals to **auto-rollback canaries** and trigger AI **live-fix** ([Plan 23](../design/generated-stack.md#plan-23)). So Alertmanager-style routing feeds two sinks: humans (receivers) and the control plane (sagas).

**Recommendation / caveat.** Adopt Alertmanager's **conceptual model** (routing tree, grouping, dedup, inhibition, silencing, receivers) as HoBo's alerting contract, and offer **Alertmanager itself as a first-class provider** behind the alerting port (its `webhook_configs` and rich receiver set make integration cheap, and it's already in most tenants' stacks). The distinction to preserve: Alertmanager routes alerts derived from *PromQL on time series*, whereas HoBo's alerts also derive from **event-log facts** (drift, policy decisions, spend) — so HoBo's "alert source" is broader than Prometheus rules, and the routing layer must accept both metric-derived and event-derived alerts. Pair this with OpenSLO ([`../standards/openslo.md`](../standards/openslo.md)) as the *definition* of what burns and Alertmanager as the *routing* of the resulting alert.

## Sources
- [Alertmanager overview — prometheus.io](https://prometheus.io/docs/alerting/latest/alertmanager/)
- [Alertmanager configuration reference — prometheus.io](https://prometheus.io/docs/alerting/latest/configuration/)
- [Prometheus alerting rules — prometheus.io](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [prometheus/alertmanager — GitHub](https://github.com/prometheus/alertmanager)
- HoBo: [Plan 14 — Observability](../design/reliability-observability-cost.md#plan-05) · [Plan 5 — Reliability/HA](../design/reliability-observability-cost.md#plan-05) · [Plan 30 — Policy plane](../design/contracts-policy-flags.md#plan-29) · [Plan 6 — AI-native agent auth](../design/ai-native-agent-auth.md#plan-06) · [ADR-0039 — Billing/quota/cost](../design/adr/02-identity-security.md#adr-0039) · [Plan 11 — Event model](../design/data-plane.md#plan-11)
