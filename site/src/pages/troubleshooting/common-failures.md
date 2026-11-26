---
layout: ../../layouts/Docs.astro
title: Common failures
description: "Common failure modes: doctor, can-deploy, Gatekeeper denials, STALE_FENCE, schema version, Station missing, and OPFS durability."
---

# Common failures

Start with **read-only diagnosis**, then gated mutate. Prefer CLI verbs that emit machine-readable reasons.

## Quick map

| Symptom | First command | Likely page |
|---|---|---|
| Local env weird | `hobo doctor` | this page · [CLI](/HoBo/reference/cli/) |
| Deploy blocked | `hobo verify` / `hobo can-deploy` | [Contracts](/HoBo/reference/contracts/) |
| Policy deny | inspect `policy.Decided` | [Policy](/HoBo/reference/policy/) |
| Append fails OCC | reload & retry | [EventStore](/HoBo/reference/eventstore/) |
| `STALE_FENCE` | re-acquire lease | [ActorHost](/HoBo/reference/actor-host/) |
| DB won’t open | schema version / OPFS | [Schema](/HoBo/reference/schema/) |
| Control plane refuses | `hobo station status` | [Stations](/HoBo/primitives/stations/) |
| Identity dual weird | `hobo identity status` | [Identity](/HoBo/security/identity/) |
| Agent can’t tool | scopes + MCP auth | [MCP](/HoBo/agents/mcp/) |

## Gatekeeper denied

1. Read `gatekeeper.Decided` reasons (`gate` field). 
2. Contracts → fix producer/consumer skew (`can-deploy`). 
3. Policy → change pack or satisfy obligation — **do not retry** denials. 
4. Cost → quota/budget. 
5. Effects/resilience → visibility only unless configured as hard gate.

## Durability failures

| Code | Action |
|---|---|
| `OPTIMISTIC_SEQUENCE_CONFLICT` | Reload aggregate; retry decide/append |
| `STALE_FENCE` / `MISSING_FENCE` | Lease discipline — not OCC retry |
| `UNSUPPORTED_SCHEMA_VERSION` | Upgrade runtime to match DB |
| `PERSISTENCE_UNAVAILABLE` | Browser without OPFS while durable required — change mode or environment |
| `SQLITE_BUSY` | Single-owner violation or short busy timeout — check writers |

## Station / broker

Missing Station fails closed. `hobo station init` then set `defaultStation` / `activeRail`. Broker receipts must pin `stationId` + `railHash`.

## Still stuck

- Replay the stream with `inspect` 
- Check Crew handoffs for open obligations 
- File evidence with `attest` exports — not screenshots of secrets 

## Related

[Doctor in CLI guide](/HoBo/guide/cli/) · [Errors](/HoBo/reference/errors/) · [Anti-patterns](/HoBo/testing/anti-patterns/)
