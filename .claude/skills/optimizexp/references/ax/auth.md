---
type: Agent Skill Reference
title: "OptimizeXP AX — AUTH.md (WorkOS) and credentials"
description: "WorkOS auth.md open protocol for agent registration; product OAuth/agent auth; local coding-agent key residual hygiene."
tags: [hobo, optimizexp, ax, auth, secrets, workos, auth-md]
timestamp: 2026-07-31T00:00:00Z
---

# AX — AUTH.md (WorkOS open protocol)

Part of the broader **specs** surface: [specs.md](specs.md).

## What AUTH.md is (do not rebrand)

**auth.md** (often committed or hosted as `AUTH.md`) is an **open protocol authored by WorkOS**
for **agent registration** with applications — not a HoBo house style for “list our API keys.”

| Fact | Detail |
|---|---|
| Author | WorkOS (protocol author) |
| Status | Open protocol — **not** tied to WorkOS infrastructure |
| Analogues | Read like `agents.md` / `llms.txt`: Markdown agents parse for procedures |
| Hosting | App publishes at a well-known URL (typically `https://yourapp.com/auth.md`) |
| Job | Tell agents how to **register on behalf of a user**: flows, scopes, credential issue/revoke |
| Wire | Composes OAuth standards (e.g. Protected Resource Metadata / RFC 9728, ID-JAG assertions) |
| Spec / reference | https://workos.com/auth-md · https://github.com/workos/auth.md |

**Never** describe AUTH.md as “our repo pattern” or invent a competing “AUTH surface” name. Score
product and public agent-auth journeys against the **WorkOS auth.md** expectations first.

## Protocol surface (product / public)

Agents should be able to:

1. Discover how to register (prose + structured discovery via PRM / AS metadata where implemented).  
2. Pick a supported flow (**agent verified** vs **user claimed** — WorkOS docs).  
3. Obtain **scoped, short-lived, revocable** user-tied credentials over standard OAuth.  
4. Handle revoke / re-auth without standing privilege.

### HoBo product anchors

- Product identity/auth: the `hobo:auth` federation port and agent credential implementations in `packages/identity`.
- Public agent briefing: `site/public/llms.txt` — must not contradict auth posture.  
- When HoBo ships a public app/API agents call, the **auth.md / AUTH.md** for that origin should
  match WorkOS protocol intent (flows, scopes, register/claim endpoints) — not only a key table.

### Friction / uncertainty (protocol)

- App has agent-facing APIs but no discoverable auth.md  
- auth.md prose contradicts `/.well-known/oauth-protected-resource`  
- Scopes undocumented; agents guess standing API keys  
- “Agent ready” marketing without claim/register paths  

### Harms (protocol)

- Long-lived agent credentials with user full privilege  
- Encouraging shared/pooled free-tier identities across tenants  
- Secrets in auth.md or public agent briefs  

### Optimization moves (protocol)

1. Publish/maintain auth.md per WorkOS format for agent-callable origins.  
2. Align product identity design (secretless-first, short-lived, audited) with issued credentials.  
3. Link design ADRs from product docs; do not invent a parallel agent-auth DSL.  
4. Never imply WorkOS endorsement of HoBo; naming the open protocol is nominative fair use.

## Residual: coding-agent tooling keys (this design repo)

Separately, **this repository’s** root `AUTH.md` may also document **local coding-agent tooling**
keys (gbrain, SkillOpt live backends, zero-key setup). That content is **repo operator hygiene**,
not a redefinition of the WorkOS protocol.

| Concern | Where |
|---|---|
| WorkOS auth.md protocol (product agents ↔ apps) | This section (primary) |
| Local MCP/tool keys for humans hacking on HoBo | Root `AUTH.md` residual tables + `.env.example` |
| Full tooling narrative | `docs/agent-tooling.md` |

### Local residual goals

- Zero-key default for clone/setup (`--no-gbrain`)  
- Fail-closed MCP launchers with remediation ([mcp.md](mcp.md))  
- Env var **names** only; never paste secrets into bus/issues  

### Local residual probes

```bash
test -f AUTH.md
pnpm run doctor   # expects AUTH.md present; lists setup/MCP
bash scripts/setup-agent-tools.sh --help   # points at AUTH for keys/egress residual
```

## Metrics mapping

| Observation | Metrics |
|---|---|
| Product agent path needs standing API key with no auth.md discovery | friction ≥ 3, uncertainty ≥ 3 |
| auth.md missing while public agent APIs exist | friction ≥ 3 |
| AUTH.md mislabeled as HoBo-only invention in docs | uncertainty ≥ 2 (wrong mental model) |
| Local gbrain starts without key warning | harms ≥ 1–2, uncertainty ≥ 2 |
| Clear WorkOS protocol + residual local key table | friction ≤ 1 |

## Related

- [specs.md](specs.md) — standing contracts inventory  
- [mcp.md](mcp.md) — local MCP launchers  
- [model-routing.md](model-routing.md) — cloud backends that need keys  
- Product implementation: `packages/identity/src/`
- Protocol: https://workos.com/auth-md · https://github.com/workos/auth.md  
