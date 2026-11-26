---
layout: ../../layouts/Docs.astro
title: The MCP surface
description: "HoBo's shipping MCP control surface: the hobo-mcp stdio binary serves the canonical CLI verb set as tools, with verb/tool parity contract-tested, deny-by-default auth, and every decision audited."
---

# The MCP surface

HoBo exposes its control plane over **MCP (Model Context Protocol)** — and this surface **ships today**. The `hobo-mcp` binary serves every canonical CLI verb as an MCP tool over stdio, and every tool call dispatches through the *same command registry* as the `hobo` binary itself. Anything the [CLI verb surface](/HoBo/guide/cli/) can express, an agent can call over MCP. It isn't a chat integration bolted onto the side — it's a second transport into the same surface.

## Running it

`hobo-mcp` ships alongside the `hobo` binary and speaks the MCP **stdio transport** — newline-delimited JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`). Point any MCP client at the binary:

```json
{
  "mcpServers": {
    "hobo": { "command": "hobo-mcp" }
  }
}
```

Like the CLI, it defaults to the **local lane**: `plan`, `up`, and `down` converge against an offline Yard runtime with a durable SQLite journal — no cloud account required. Live deploy lanes are **credential-gated by environment**: Cloudflare (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`), Vercel (`VERCEL_TOKEN`), or live IaC credentials.

## Tools = the canonical verbs

The tool surface is **derived from the canonical CLI verb set**, one tool per verb — `up`, `down`, `plan`, `dev`, `station`, `trails`, `replay`, and the rest (see [the hobo CLI](/HoBo/guide/cli/)). Parity is a contract, not a convention: a structural parity check fails whenever the tool set diverges from the verb set, so there is no MCP-only subset and no MCP-only side door in either direction. A tool call becomes `hobo <verb> --json` over the shared dispatch path, and the result is the same JSON envelope the CLI emits, returned as inert data.

Tool inputs accept `cwd` (resolve the project directory), `camp` (target camp), and `args` (extra verb arguments).

## Auth: deny by default, audited always

Authorization is checked **before** dispatch, and every decision is recorded:

- **Deny-by-default scopes.** Each tool maps to a capability scope. A call outside the caller's scope is refused (`MCP_SCOPE_DENIED`); a tool that isn't part of the derived surface is refused (`MCP_UNKNOWN_TOOL`). Fail closed, never fall through.
- **Every decision is an audit event.** Allow or deny, each tool-call decision is recorded with the principal, tenant, tool, effect, and reason attached.
- **Scope down with `HOBO_MCP_TOOLS`.** Set a comma-separated verb list (e.g. `HOBO_MCP_TOOLS=plan,inspect,logs`) and the served surface shrinks to exactly those tools — every other verb is out of scope for that server process.
- **Local-operator trust model.** Over stdio, `hobo-mcp` acts with the invoking user's authority — the same trust model as running `hobo` directly — bounded by the scoped tool surface above. `HOBO_MCP_SUBJECT` / `HOBO_MCP_TENANT` name the principal and tenant the audit trail records.

## What agents typically do with it

| Task | Tool |
|---|---|
| "Deploy this bindle" | `up` — the same convergence loop as `hobo up`; local lane by default |
| "What would change, and roughly what would it cost?" | `plan` — read-only dry run |
| "Tear the preview back down" | `down` |
| "What happened on the last run?" | `inspect` / `logs` |
| "Anything drifting?" | `drift` |

## Designed, not yet shipped

The fuller agent-identity design — workload identity (SVID/OIDC), brokered short-lived per-task credentials, and a machine-readable capability standard for scope discovery — is contract-pinned design, tracked on [the trail map](/HoBo/guide/status/). What ships now is the surface above: full verb/tool parity, deny-by-default scoping, and audited decisions.

## Reading the docs as an agent

This site is maintained as a first-class agent surface:

- [`llms.txt`](/HoBo/llms.txt) is the canonical machine-readable briefing — start there.
- Headings are stable; CLI examples use only canonical verbs; code snippets are complete enough to run, not fragments.
- The [primitives](/HoBo/primitives/) pages define the exact vocabulary the tool surface uses — bindle, camp, yard, junction mean the same thing to the parser as to you.
