---
type: Agent Skill Reference
title: "OptimizeXP AX — specs and standing contracts"
description: "Standing contract files agents must discover: WorkOS AUTH.md/auth.md, AGENTS.md, UI tokens, llms.txt."
tags: [hobo, optimizexp, ax, specs, agents-md, auth, design-md, workos]
timestamp: 2026-07-31T00:00:00Z
---

# AX — specs & standing contracts

Agents treat **repo files as data**, but **standing contracts** must be findable, consistent, and
small enough to load first. This section audits those surfaces. Call standards by their **real
names** (WorkOS auth.md, UI tokens, llms.txt) — do not invent house brands for external protocols.

## Spec inventory

| Spec | Standard / role | Offline probe |
|---|---|---|
| `AUTH.md` / `auth.md` | **WorkOS open protocol** for agent registration (flows, scopes, credentials) — not a HoBo invention | file present; product origins should publish per https://workos.com/auth-md |
| `AGENTS.md` | Standing agent instruction brief (ecosystem convention) | file exists; linked from CLAUDE.md |
| `CLAUDE.md` | Claude-oriented include / summary | points at AGENTS / skills |
| `docs/agent-tooling.md` | Full coding-agent tooling narrative (repo) | linked from AGENTS |
| `site/src/styles/global.css` | Implemented visual tokens | `pnpm run design:lint` |
| `site/public/llms.txt` (+ full dump) | Public agent briefing for the product site | file exists; no internal secrets |
| Nested `AGENTS.md` | Folder law (`src/draft/**`, etc.) | only when path is in scope |
| `docs/design/**` | Product design suite | OKF / design lints as needed |

Detail: [agents-md.md](agents-md.md) · [auth.md](auth.md) (WorkOS auth.md) · UI `../ux/design-md.md`.

## Goals

- Correct attribution of external standards (especially WorkOS auth.md)
- Specs name **next commands** / discovery paths, not only philosophy
- Optional/cloud paths are marked opt-in
- Residual local key tables (if co-located in AUTH.md) are **labeled residual**, not the protocol definition

## Friction smells

- Product agent APIs with no discoverable auth.md
- Auth only buried in a long tooling doc with no AUTH.md / auth.md
- UI tokens fail contrast checks
- AGENTS.md and a skill contradict (gates, install, MCP)
- Specs require reading 500+ lines before a first green command

## Uncertainty smells

- Docs call AUTH.md a “HoBo repo pattern” or “our AUTH surface” (wrong — WorkOS open protocol)
- “Secretless” claimed while `.env` examples demand plaintext keys without residual framing
- llms.txt claims ship status that the trail map contradicts
- Folder AGENTS overrides root without saying so

## Harms smells

- Specs instruct pasting secrets into prompts, bus, or issues
- Specs imply vendor endorsement (including WorkOS) or unsafe multi-tenant key sharing

## Optimization moves

1. Treat **AUTH.md as WorkOS auth.md protocol** for product/agent registration; residual local tooling keys only when clearly labeled.  
2. Doctor may require AUTH.md present; remediation cites the protocol, not a proprietary name.  
3. Progressive disclosure: short tables in AGENTS; detail in docs/agent-tooling.  
4. Check implemented UI tokens and rendered surfaces.
5. When specs change, update the other linked specs in the same diff (docs freshness).

## Evidence for optimizexp

- Transcripts of `pnpm run doctor`, setup `--help`  
- Paths: `AUTH.md`, `AGENTS.md`, `site/src/styles/global.css`
- Diffs that correct AUTH.md attribution or remove AGENTS↔skill contradictions  
