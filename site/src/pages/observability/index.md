---
layout: ../../layouts/Docs.astro
title: Observability
description: "Events as truth, projections, Streamer, synthetics, metering, Session Replay, and agent audit."
---

# Observability

HoBo’s primary observability substrate is the **event log** plus rebuildable projections. Metrics and traces export — they do not replace the log as authority.

## In this section

| Page | Topic |
|---|---|
| [Agent audit & replay](/HoBo/observability/agent-audit/) | Tool calls, token grants, handoffs as facts |
| [Session Replay](/HoBo/reference/session-replay/) | Privacy-first DOM/session reconstruction |
| [Metering](/HoBo/reference/metering/) | Usage facts and showback projections |
| [Streamer](/HoBo/reference/streamer/) | High-volume frames outside the domain log |
| [Endpoint Monitor](/HoBo/operations/endpoint-monitor/) | Synthetics and SLO burn |
| [CI host health](/HoBo/ci/host-health/) | The CI box's CPU, memory, disk and inode pressure |

## Principles

1. “Why did the system do X?” → **replay**, not SSH folklore. 
2. Crew and agent actions are facts. 
3. Sandbox lanes are labeled so experiments do not pollute baseline views. 

## Related

[Architecture](/HoBo/architecture/) · [Troubleshooting](/HoBo/troubleshooting/) · [Operations](/HoBo/operations/)
