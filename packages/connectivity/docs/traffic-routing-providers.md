# TrafficRouting offerings & custom providers

Portable multi-backend routing intent ([ADR-0143](../../../docs/design/adr/07-portability-extensibility.md#adr-0143)).
This document is the extension surface for built-in and custom providers.

## Offering catalog

| Offering | Meaning |
|---|---|
| `lb.lifecycle` | Create/update/delete LB + pools |
| `lb.weighted` | Weighted multi-backend |
| `lb.health` | Provider health checks drive steering |
| `lb.locality` | Geo/latency steering |
| `edge.path` / `edge.header` / `edge.canary` | Edge L7 / deployment canary |
| `dns.weighted` / `dns.failover` | Yard DNS policy (ADR-0035) |
| `overlay.funnel` / `overlay.funnel.multi` | Funnel public tip (+ multi select) |
| `inprocess.weighted` | Station/control-plane weighted select |
| `driver.route-bind` | Deploy-driver route resource |
| `mesh.optional` | Opt-in k8s mesh only |
| `observe.health` / `observe.location` | Synthesis observations |
| `resiliency.edge` | Edge timeout/retry |

Core types: `TrafficRoutingProviderProfile`, `matchTrafficRoutingOfferings`,
`resolveTrafficRouting` in `@hobo/core`.

## Default fallback ladder

```text
1. Native primary (lb.*, edge.*)
2. DNS policy (dns.*)
3. Overlay Funnel (overlay.funnel*)
4. In-process (+ driver.route-bind)
5. mesh.optional only if explicitly registered
```

Negotiation: `prefer` → partial with `missing`/`fallbacks`; `require` → none + remediation.

## Per-cloud matrix (v1)

| Provider | Native offerings | Fallbacks |
|---|---|---|
| simple | `inprocess.weighted` | — |
| cloudflare | `lb.lifecycle`, `lb.weighted`, `lb.health`*, `observe.health`* | dns → inprocess |
| vercel | `edge.canary`, `edge.path`, `edge.header` | inprocess |
| lakebed | `inprocess.weighted`, `driver.route-bind` | — |
| funnel | `overlay.funnel`, `overlay.funnel.multi`, `inprocess.weighted` | inprocess |
| aws/gcp/azure | declare `lb.*`, `dns.*`, `observe.health` (preview) + `inprocess.weighted` floor | inprocess |

\* health offerings when monitors/observations configured.

Provider packages export `*_TRAFFIC_ROUTING_PROFILE` for Matching.

Built-in profiles: `BUILTIN_TRAFFIC_ROUTING_PROFILES` from `@hobo/connectivity`.

## Custom provider checklist

**Required**

1. Export a `TrafficRoutingProviderProfile` constant declaring the offerings (e.g. `AWS_TRAFFIC_ROUTING_PROFILE`)
2. `TrafficRoutingPort` with `apply` / `status` / `revoke?`
3. Honest `full | partial | none` + concrete `unmet`
4. Injectable transport for HTTP providers + Pact where applicable
5. No credentials in plans, notes, or metering

**If you claim…**

| Offering | Also implement |
|---|---|
| `lb.lifecycle` | Create/update/delete resources (not update-only stubs) |
| `lb.health` / `observe.health` | Health observation source; feed Station via `applyRoutingObservations` |
| `overlay.funnel.multi` | Multi-backend selection + documented public-tip policy |
| `driver.route-bind` | Driver-program resource emission |

**Minimum provider (no native LB):** declare `inprocess.weighted` and compose
`createSimpleTrafficRouting()` (or equivalent).

## Resolution API

```ts
import {
  resolveTrafficRouting,
  type TrafficRoutingProviderProfile,
} from "@hobo/core";
import { BUILTIN_TRAFFIC_ROUTING_PROFILES } from "@hobo/connectivity";

const result = resolveTrafficRouting(BUILTIN_TRAFFIC_ROUTING_PROFILES, {
  features: ["lb.weighted", "lb.lifecycle"],
  negotiation: "prefer",
});
// result.kind === "resolved" → provider + strategy offerings
```
