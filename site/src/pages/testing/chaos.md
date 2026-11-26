---
layout: ../../layouts/Docs.astro
title: Chaos & availability
description: "Session-scoped fault injection, Crew synthetics, SLO projections, and shadow lanes — availability testing without unbounded blast radius."
---

# Chaos & availability

Availability testing is the only layer that *should* touch real camps. Everything else stays offline by construction.

## Session-scoped faults

Use boundary **fault** mode with a session tag so chaos stays personal:

- Your session sees the outage.
- Everyone else keeps the live path.
- Results are events — not a screenshot.

## Synthetics (Crew)

The **Endpoint Monitor** Crew operator probes camp endpoints continuously and emits burn/alert signals that feed the **SRE** operator. See [Crew: Endpoint Monitor](/HoBo/operations/endpoint-monitor/) and [Crew: SRE](/HoBo/operations/sre/).

## SLOs as projections

Availability targets are **materialized views** over the event log. Test them in CI by replaying history — not by scraping a dashboard.

## Shadow lanes

`.shadow(candidate)` sends real inputs to a candidate implementation, compares outputs, and **never** returns candidate output to callers. Availability testing for the next version, paid for by the current one.

## Resilience fault injection (offline)

For contract-level resiliency metadata (not live chaos), use [effect-aware fault injection](/HoBo/testing/effects/):

- Transient failures may retry under deterministic schedules.
- `policy.Decided` / terminal / cancellation **never** retry.

## Blast radius rules

- Prefer session tags over global fault flags.
- Prefer shadow over dual-writing production responses.
- Prefer replay/fork lanes for golden suite failures before production self-heal.

## Next

- [The Crew](/HoBo/crew/)
- [Conformance & golden](/HoBo/testing/conformance/)
