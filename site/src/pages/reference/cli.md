---
layout: ../../layouts/Docs.astro
title: CLI surface
description: "Canonical hobo verbs by role: lifecycle, diagnosis, authoring, identity, progressive delivery, broker/station, and distribution (source: verbs.ts)."
---

# CLI surface

The `hobo` CLI is deliberately **small and stable**. The same canonical verb set appears as MCP tools. Docs examples use only this list.

## Lifecycle

| Verb | Role |
|---|---|
| `up` | Realize the object graph (build, plan, gate, provision, deploy) |
| `down` | Reverse |
| `dev` | Offline local Camp / inner loop |
| `plan` | Dry-run the up decision (approvable diff) |
| `verify` | Unified Gatekeeper preflight (read-only) |
| `can-deploy` | Producer/consumer compatibility diagnosis |

`up` still runs the same gate as `verify` automatically before mutation. Continuous delivery *observation* uses `deploy` (below), not a second ship verb.

## Identity, access, progressive

| Verb | Role |
|---|---|
| `login` | Authenticate / associate default broker |
| `claim` | Bind anonymous deployment to an account |
| `identity` | Continuous identity status / inspect |
| `access` | Elevated / cross-env access or break-glass |
| `connection` | Connection management (Station-bound) |
| `feature` | Flags / progressive delivery (Harness) |
| `deploy` | CD status / logs / rollback (attested apply plane) |
| `incident` | CD failure disposition / A2H |
| `trails` | Continuous migration recipes (`status` \| `plan` \| `inspect`) |
| `station` | Station **ops/setup** (not app lifecycle) |
| `yard` | Bare-metal Yard install / inspect |
| `broker` | Conductor config + resolve + matrix |
| `serve` | Local control-plane HTTP+SSE for the Yard game UI |

## Authoring

| Verb | Role |
|---|---|
| `new` | Scaffold |
| `collect` | Resource collection → manifest IR |
| `codegen` | Regenerate project bindings (`--check` fails on drift) |
| `build` | Compile to wasm components (OCI fallback) |
| `stub` | Contract-backed stub behind a WIT port |
| `generate` | Generation pipeline entry |
| `sandbox` | Isolated lane; out-of-scope boundaries from contracts |
| `test` | Contract-backed sandbox test lane (not a jest replacement) |

## Observe & operate

| Verb | Role |
|---|---|
| `inspect` | Projections / time-travel (`run`, `deploy`, `topology`, …) |
| `logs` | Live-tail Camp Streamer |
| `replay` | **Session Replay** — `list` \| `get` \| `open` \| `summarize` \| `retention` \| `doctor` |
| `doctor` | Environment / credential / portability hazards (incl. messaging readiness) |
| `messaging` | Inspect messaging capability and delivery-guarantee readiness |
| `drift` | Drift + governed remediation |
| `runbook` | Execute runbooks (writes still policy-gated) |
| `attest` | Signed evidence exports from audit facts |
| `erase` | Crypto-shred subject + projection rebuild |
| `derivative` | Derived implementation upgrade / conformance |

## Distribution

| Verb | Role |
|---|---|
| `add` | Install provider or listing (sig + provenance + conformance) |
| `registry` | Registry admin; signed offline bundle import |
| `import` | Adopt estate in place — never destroy/recreate on import |

## Station context

For `station`, `broker`, `connection`, and station-aware `up` / `login`:

1. `--station` / `--station-uri`
2. `HOBO_STATION` / `HOBO_STATION_URI`
3. `profile.defaultStation`
4. Fail closed with remediation `hobo station init`

Receipts pin `stationId` + `railHash`.

## Policy mapping

Control-plane verbs map to `hobo:<resource>:<verb>` policy actions (**deny-by-default**). Unmapped verbs fail conformance.

## Related

[The hobo CLI](/HoBo/guide/cli/) · [MCP](/HoBo/agents/mcp/) · [Stations](/HoBo/primitives/stations/) · [Trail map](/HoBo/guide/status/)
