---
layout: ../../layouts/Docs.astro
title: The hobo CLI
description: "The canonical hobo command surface: lifecycle up/down, local loop, identity, delivery, authoring, governance, and ops verbs — MCP parity with the verb set in verbs.ts."
---

# The `hobo` CLI

The CLI is deliberately small — a hobo carries one stick, not a toolbox. **`up` and `down` are the only lifecycle verbs**: ship, promote, roll back, migrate, and even self-host bootstrap are flags on the same convergence loop, not separate commands. Every documented example on this site sticks to this canonical surface.

## Lifecycle

```bash
hobo up
hobo up --camp prod
hobo up --camp prod --to <revision>
hobo up --rollback
hobo up ./platform --seed
hobo down --camp pr-123
```

`up` realizes the current object graph: build, plan, gate, provision, deploy. `down` tears it back in reverse dependency order. `up` always reruns the applicable gate before mutation — a stale preflight can never authorize a deploy. Continuous migrations run this same loop; there is no separate `migrate` verb.

## The full verb surface

| Verb | Role | Semantics |
|---|---|---|
| `up` / `down` | lifecycle | Realize / tear down the object graph. |
| `dev` | local loop | Offline local-runtime camp; serve api/web handlers in-process. |
| `new` | local loop | Scaffold a runnable SDK program. |
| `login` / `claim` | identity | Dev identity (OIDC/SVID path); bind an anonymous deployment to an account. |
| `connection` | identity | Durable Connections (create / authorize / list / get / revoke / rotate). |
| `identity` | identity | Continuous identity migration status / inspect (zero Bindle config). |
| `access` | identity | Elevated / cross-env access or break-glass (short-lived, audited). |
| `feature` | delivery | OpenFeature flags / canary / experiment (`list` \| `eval` \| `set` \| `kill` …). |
| `deploy` | delivery | Attested continuous-delivery **status / logs / rollback** (not a second lifecycle). |
| `incident` | delivery | CD failure disposition: A2H handoff or sandboxed self-heal. |
| `plan` | read-only | Dry-run the `up` decision: plan, matching, cost, warnings. |
| `verify` | read-only | Unified Gatekeeper preflight. |
| `can-deploy` | read-only | Producer/consumer compatibility matrix. |
| `inspect` | read-only | Projections and time-travel views (`run`, `deploy`, `topology`, …). |
| `logs` | read-only | Live-tail Camp streams. |
| `doctor` | diagnostics | Environment, credential, connectivity, and portability hazards. |
| `messaging` | diagnostics | Messaging capability + delivery-guarantee readiness. |
| `codegen` / `build` / `collect` / `stub` | authoring | Bindings, wasm components, manifest IR, contract-backed stubs. |
| `drift` | diagnostics | Drift report + governed remediation paths. |
| `add` / `registry` | distribution | Install providers after sig/provenance/conformance; registry admin. |
| `import` | migration | Adopt an existing estate in place — never destroy/recreate on import. |
| `generate` | generation | Request the provider-generation loop for a missing backend. |
| `sandbox` / `test` | test loop | Isolated lanes; out-of-scope boundaries served from contracts. |
| `attest` / `erase` | governance | Signed evidence exports; crypto-shred with projection rebuild. |
| `broker` | governance | Conductor resolve / config / matrix (placement plane). |
| `yard` | control plane | Install and inspect the default bare-metal Yard. |
| `station` | control plane | Station ops/setup (`init` \| `up` \| `down` \| `status` \| `rails *`) — not lifecycle. |
| `serve` | control plane | Local control-plane HTTP+SSE for the Yard game UI. |
| `replay` | observability | Session Replay list/get/open/summarize/retention/doctor. |
| `derivative` | extensibility | Manage derived HoBo implementations. |
| `runbook` | SRE | Execute or replay incident runbooks under policy. |

## Not lifecycle (and not missing)

Where other tools invent ceremony commands, HoBo folds them into the model:

- **Lifecycle shipping** is only `up` / `down` (plus flags). A separate “deploy command” as *lifecycle* is rejected.
- **`deploy` as a verb still exists** — it is the continuous-delivery *observe* surface (`status` / `logs` / `rollback`), not a second ship path.
- `destroy`, `teardown`, `rollback`, and `promote` as standalone commands are rejected; use `down` or `up --rollback` / promotion via convergence.
- `train`, `crew`, and `fleet` are SDK code and projections, not CLI verbs.

## Status

The **canonical verb set** is on the composed `hobo` surface today and maps **1:1** to [`hobo-mcp`](/HoBo/agents/mcp/) tools (parity is contract-tested). Lifecycle is `up` / `down`; `hobo deploy` is **observe-only** delivery status, not the ship verb. The default path is the **local lane**: offline Yard runtime, durable SQLite journal, no cloud account. Live deploy lanes are credential-gated (Cloudflare, Vercel, or live IaC credentials). Some advanced flags (`--to`, `--rollback`, `--seed`) and deeper multi-cloud depth are still maturing — see [the trail map](/HoBo/guide/status/). Global flags that work everywhere: `--json`, `--camp`, `--cwd`, `--verbose`, `-q`, `--help`.
