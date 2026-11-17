---
layout: ../../layouts/Docs.astro
title: HoBo for agents
description: "How AI agents use HoBo as first-class principals: scoped short-lived credentials, a machine-readable capability standard, the Crew, and docs built to be read by machines."
---

# HoBo for agents

HoBo is built for humans **and the agents that work for them** — not as a slogan, but as an identity model. If you're an AI agent (hello, fellow traveler) or a human building agent tooling on HoBo, this section is yours.

> **Reading this as an agent?** The condensed, machine-readable briefing lives at [`llms.txt`](/HoBo/llms.txt), and the entire site concatenated as one markdown document lives at [`llms-full.txt`](/HoBo/llms-full.txt). Every page also has a "Copy page as Markdown" button, uses stable headings, canonical CLI verbs, and copy-pasteable snippets on purpose — the developer documentation *is* the agent documentation.

## Agents are principals, not scripts

The standard failure mode elsewhere: an agent runs with a human's long-lived API key, invisible to audit and unbounded by scope. HoBo's model (the full brokered-identity flow below is contract-pinned design; the shipping `hobo-mcp` binary runs today with a deny-by-default, scoped local-operator identity and audits every decision):

- **Own identity.** Agents get workload identity (SVID/OIDC), not borrowed keys.
- **Brokered, short-lived tokens.** Secretless-first — credentials are issued per task, scoped to the task, and expire fast.
- **Self-provisioning within policy.** A machine-readable **capability standard** describes what each capability needs, so an agent can request *exactly* the credentials a job requires — and policy decides whether it gets them.
- **Every action is an event.** Token issuance, deploys, migrations — an agent's whole working day lands in the same append-only, replayable log as everything else. "What did the agent do?" is a query.

## One surface, three doors

Every HoBo capability is reachable three ways, with identical semantics:

| Door | For | Notes |
|---|---|---|
| **SDK** | code | The same typed objects the [primitives](/HoBo/primitives/) docs describe. |
| **CLI** | humans & scripts | The [canonical verb surface](/HoBo/guide/cli/) — deliberately small, stable to memorize. |
| **MCP** | agents | Ships today as the `hobo-mcp` stdio binary: the canonical verb set as tools, parity contract-tested — see [the MCP surface](/HoBo/agents/mcp/). |

No agent-only side entrance with different rules: if policy would stop a human doing it, it stops an agent doing it, and vice versa.

## The Crew: operators included

HoBo ships a built-in roster of operator agents — the **Crew**: SRE, endpoint-monitor, GitOps, and platform-engineer operators that run as autonomous, policy-gated services in the Yard. HoBo ships the operators, not just the APIs they'd call. Your agents can work alongside them, under the same identity model.

## Agents and continuous migration

The guiding principle — *find the cheapest home that passes policy, keep looking* — is agent-shaped by design. The Dispatcher that plans migrations is itself an optimizing agent under policy gates, and third-party agents can participate: propose placements, watch spend, pre-approve moves within bounds you set. The event log means every optimization an agent makes is attributable and reversible.

## Generating new homes

Missing a provider adapter? Agents can invoke the **generation pipeline**: synthesize an adapter for a port, then have the port's conformance suite certify it. A certified adapter is a certified adapter regardless of author — human or machine. More homes on the map, cheaper moves for everyone.

The full extension surface — every implementable port, the adapter-authoring path, the conformance bar, and the ACP/A2A protocol-connector integration points — is documented in [Custom providers](/HoBo/customizations/providers/).

## Contracts agents can read (and test)

When you call `hobo verify` / can-deploy or inspect a BoundaryContract, look for optional **effects** and **resilience** fields:

- **EffectSpec** — purity + domain I/O tags. Pure contracts isolate with zero infrastructure; network/storage domains imply harness mocks. Effect widening is a compatibility signal.
- **ResilienceProfile** — secondary retry/timeout/circuit-breaker metadata. Deterministic schedules only; **never** retry a `policy.Decided` deny or a terminal failure. Prefer reconstructing state from event facts over process memory.
- **EffectManifest** — exportable summary for policy, SRE tooling, and training trajectories (with redaction).

Durable Camp storage defaults to a **single-owner SQLite partition** behind EventStore ports. Do not assume multi-writer shared filesystems; do not invent parallel event-store engines when the ports already exist.

## Start here

- [The MCP surface](/HoBo/agents/mcp/) — the shipping `hobo-mcp` binary: stdio transport, the canonical verb set as tools, `HOBO_MCP_TOOLS` scoping, deny-by-default audited decisions.
- [`llms.txt`](/HoBo/llms.txt) — the machine-readable site briefing.
- [Architecture](/HoBo/architecture/) — package layout, durable EventStore default, contract effects.
- [Testing](/HoBo/guide/testing/) — effect-aware isolation and offline durability tests.
- [Getting started](/HoBo/guide/getting-started/) — the same ten-minute path humans take; it works verbatim for agents.
