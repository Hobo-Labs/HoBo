# `@hobo/connectivity`

Multi-tenant connectivity foundations for HoBo: **DNS-valid hierarchical naming**, optional **local named HTTPS** (portless), **cross-cloud overlay** (Tailscale primary / Netbird alternative), **pluggable public DNS**, **PolicyEngine**, and **metering/usage events**.

## TrafficRouting

`TrafficRoutingPort` is the portable multi-backend routing-intent seam from
[ADR-0143](../../docs/design/adr/07-portability-extensibility.md#adr-0143). It is
adjacent to public DNS and overlay exposure: Stations coordinate plans; Junctions
continue to own Tailscale/overlay configuration.

```ts
import { parseRoutingPlan } from "@hobo/core";
import { createSimpleTrafficRouting } from "@hobo/connectivity";

const routing = createSimpleTrafficRouting();
const result = await routing.apply(parseRoutingPlan({
  planId: "plan:checkout",
  intent: {
    service: "checkout",
    tenantId: "local",
    rules: [{
      weightStrategy: "static",
      backends: [{ id: "backend:local", service: "checkout", weight: 100 }],
    }],
  },
  backends: [{ id: "backend:local", service: "checkout", weight: 100 }],
  createdAt: new Date().toISOString(),
}));
// result.realized === "full"
```

| Adapter | Offerings (declared) | V1 realization |
|---------|----------------------|----------------|
| Simple | `inprocess.weighted` | Offline baseline; deterministic static weighted selection |
| Cloudflare | `lb.lifecycle`, `lb.weighted`, `lb.health`* | Create pools+LB when unmapped; update when mapped; revoke deletes LB |
| Funnel | `overlay.funnel`, `overlay.funnel.multi` | Multi-backend weighted selection + public Funnel tip (require multi-public opt-in) |
| Vercel | `edge.canary`, `edge.path`, `edge.header` | Rolling Releases + project routes (stage/promote); injectible `fetch`; Pact |
| Lakebed | `inprocess.weighted`, `driver.route-bind` | Dual layer: in-process multi-backend + optional `lakebed:traffic-route` driver |

\* health when monitors/observations configured.

**Offerings + fallback ladder:** see
[`docs/traffic-routing-providers.md`](./docs/traffic-routing-providers.md).
Profiles export as `BUILTIN_TRAFFIC_ROUTING_PROFILES`. Core APIs:
`resolveTrafficRouting` / `matchTrafficRoutingOfferings`.

No adapter requires Kubernetes. **No always-deny stubs.** Missing credentials or
platform-unsupported fragments return `partial`/`none` with concrete `unmet`
notes; credentials never enter plans, metering events, or result notes.
Cloudflare brownfield maps (`poolIdsByBackend` / `loadBalancerIdsByPlan`) still
work; lifecycle create needs `accountId`. Provider effects remain authoritative
if best-effort metering delivery fails; active `planId` is idempotent and
conflicting content fails closed.

## Quick starts

### 1. Hierarchical naming (pure)

```ts
import { getNamedEndpoint } from "@hobo/connectivity";

getNamedEndpoint({ resource: "web", app: "myapp", env: "local", mode: "local" });
// → https://web.myapp.local.hobo.localhost  (canonical name)
// Live local serve without portless uses http + backend port:
// → http://web.myapp.local.hobo.localhost:4173

getNamedEndpoint({ resource: "web", app: "myapp", env: "prod", mode: "overlay" });
// → https://web.myapp.hobo.test  (prod segment omitted)

getNamedEndpoint({
  resource: "web", app: "myapp", env: "dev", tenant: "acme", mode: "overlay",
});
// → https://web.myapp.dev.acme.hobo.test
```

Schema: `{resource}.{app}.{env?}.{branch?}.{project?}.{tenant?}.hobo.{tld}`  
`hobo` is a **zone label**, never a TLD. Bare `.hobo` is never emitted.

### 2. Local named mode (`hobo dev`)

```bash
# Port-based default (unchanged when portless is absent):
pnpm hobo dev --once --json

# Optional named HTTPS front-end:
#   1. Install vercel-labs/portless
#   2. portless trust   # one-time local CA
#   3. HOBO_PORTLESS=1 hobo dev
# Force off: HOBO_PORTLESS=0
```

`DevServeResult` / serve results include `namedEndpoints` and `primaryNamedUrl`.  
Without portless, the named URL is `http://{resource}.{app}.local.hobo.localhost:{backendPort}`
so it hits the same loopback listener as `127.0.0.1` (browsers resolve `*.localhost`).
`https://…hobo.localhost` (implied :443) is only advertised when portless is bound.  
MCP discovers them via `hobo inspect` (`data.namedEndpoints` / `primaryNamedUrl`).

### 3. Overlay mode (junction / laptop)

```ts
import {
  createTailscaleOverlay,
  createJunctionAgent,
  createTagAclPolicyEngine,
  createMeteringBus,
  createInMemoryMeteringSink,
} from "@hobo/connectivity";

const sink = createInMemoryMeteringSink();
const metering = createMeteringBus([sink]);
const policy = createTagAclPolicyEngine({ metering });
const overlay = createTailscaleOverlay({ metering, policy });

const agent = createJunctionAgent({
  config: { tenantId: "acme", name: "junction-aws-1", role: "junction", env: "dev", cloud: "aws" },
  overlay,
  policy,
  metering,
});
await agent.start();
```

Example Tailscale ACL tags:

```jsonc
// tagOwners / ACLs (sketch)
{
  "tagOwners": {
    "tag:broker": ["autogroup:admin"],
    "tag:junction": ["autogroup:admin"],
    "tag:dev-laptop": ["autogroup:admin"]
  },
  "acls": [
    { "action": "accept", "src": ["tag:dev-laptop"], "dst": ["tag:broker:*", "tag:junction:*"] },
    { "action": "accept", "src": ["tag:junction"], "dst": ["tag:broker:*"] }
  ]
}
// HoBo also stamps tenant:<slug>, role:<role>, env:<env>, cloud:<cloud>
```

### 4. Public DNS modes

```yaml
# Platform owns DNS (HoBo only suggests entrypoints):
dns:
  public:
    managedBy: cloud-provider   # or "none"
    provider: route53

# HoBo manages entrypoint records via a swappable provider:
dns:
  public:
    managedBy: hobo
    provider: dnscontrol        # or memory | cloudflare | …
    zone: example.com
    allowedGatewaySuffixes: [".ts.net", ".cfargotunnel.com"]
```

```ts
import {
  createPublicDnsManager,
  createDnsControlProvider,
  createMemoryDnsProvider,
} from "@hobo/connectivity";

// cloud-provider / none → applied:false, returns suggested CNAME to gateway only
// hobo + provider → upserts CNAME; refuses raw overlay IPs
```

DNSControl is preferred for TypeScript ecosystems; octoDNS is a valid alternative. Dotnify is experimental and not primary.

### 5. Multi-tenant sketch

```ts
import { parseTenantId, getNamedEndpoint } from "@hobo/connectivity";

const tenant = parseTenantId("acme");
// Control-plane resources carry tenantId; policy denies cross-tenant by default.
getNamedEndpoint({
  resource: "api", app: "payments", env: "staging", tenant, mode: "overlay",
});
// → https://api.payments.staging.acme.hobo.test
```

Set `HOBO_TENANT`, optional `HOBO_PROJECT` / `HOBO_BRANCH` / `HOBO_ENV` for local promotion context.

## Overlay credential minters (HoBo Fleet)

`createTailscaleCredentialMinter` and `createNetbirdCredentialMinter`
implement the `OverlayCredentialMinter` port of `@hobo/fleet`: the fleet
authority calls one per `ACTIVE` device to mint a single-use overlay join
credential through the provider's API, with the `fetch` it is given. They do
not use or change the overlay clients in `src/overlay/`. Details, request
shapes and failure handling are in
[`src/minters/README.md`](src/minters/README.md).

- **Single use, not ephemeral.** Tailscale keys are `reusable: false`,
  `preauthorized: true`; NetBird setup keys are `one-off` with
  `usage_limit: 1`. Both use `ephemeral: false`, so a device is not removed
  when it goes offline.
- **NetBird's one-day minimum.** NetBird refuses a setup-key `expires_in`
  under 86400 s, so a NetBird join credential lives for one day rather than
  the 10 minutes asked for (`max(ceil(ttlMs / 1000), 86400)`). It still cannot
  be replayed once the device has joined.
- **Failures** (token read, network, non-2xx, redirect, 10 s timeout, a reply
  without key or expiry) are `unavailable`; neither the token nor the
  credential appears in any message, detail or log line.
- **Assumption A13: not tested, fallback taken.** No provider account or
  provider-recorded interaction was available, so the consumer pacts in
  `test/minters/pacts/` are written from the providers' API references and
  the `[A13]` cases skip until recordings are committed under
  `test/minters/recorded/`. A13 is listed in the root `fleet-fallbacks.json`.

## How to test

```bash
pnpm --filter @hobo/core test
pnpm --filter @hobo/connectivity test
pnpm --filter @hobo/hobo test   # local yard parity still offline
```

| Scenario | Expectation |
|----------|-------------|
| Local without portless | Port URLs unchanged; hierarchical names still emitted; one-line portless hint |
| Local with portless | `primaryNamedUrl` https://…hobo.localhost preferred in discovery |
| Junction start without tailscale | Degraded join, metering `junction.join`, notes explain install |
| DNS `managedBy: none` | Suggest only, no zone write |
| DNS `managedBy: hobo` + gateway | CNAME upsert + usage event |
| Cross-tenant policy | Deny + `policy.evaluate` usage event |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for Mermaid diagrams covering local named mode, overlay mode, pluggable DNS, and multi-tenant / policy / metering foundations.

## Next-step surfaces (landed)

| Surface | How |
|---------|-----|
| MagicDNS split | `overlay.configureMagicDns({ domains: ["hobo.test"], nameservers: [...] })` |
| Funnel gateway | `overlay.publishFunnel({ backendUrl, tenantId })` → `*.ts.net` only |
| Cloudflare DNS | `createCloudflareDnsProvider({ apiToken, zoneId, fetchImpl? })` |
| Route53 DNS | `createRoute53DnsProvider({ accessKeyId, secretAccessKey, signRequest?, allowUnsigned? })` |
| OPA/Rego policy | `createOpaPolicyEngine({ opaUrl?, regoModulePath? })` + `SAMPLE_HOBO_AUTHZ_REGO` |
| Billing aggregator | `createBillingAggregator()` as a `MeteringSink` → `closePeriod()` invoices |
| Traffic routing | `createSimpleTrafficRouting()` offline; Cloudflare, Funnel, production Vercel (RR + routes), dual-layer Lakebed |
| Hard multi-tenant | `createTenantIsolationRegistry()` with `soft` \| `hard-overlay` \| `hard-control-plane` |
| Dynamic DNS heartbeats | `createJunctionDynamicDnsRegistrar` / `createJunctionAgent({ publicDns, dnsTargets })` |

```ts
import {
  createBillingAggregator,
  createCloudflareDnsProvider,
  createJunctionAgent,
  createOpaPolicyEngine,
  createPublicDnsManager,
  createTailscaleOverlay,
  createTenantIsolationRegistry,
  tenantFromSlug,
} from "@hobo/connectivity";

// Hard isolation
const isolation = createTenantIsolationRegistry();
isolation.registerTenant(tenantFromSlug("acme", "hard-control-plane"));

// OPA policy + billing sink
const billing = createBillingAggregator();
const policy = createOpaPolicyEngine({ opaUrl: process.env.HOBO_OPA_URL });
const overlay = createTailscaleOverlay({ policy });
const dns = createPublicDnsManager({
  config: { managedBy: "hobo", provider: "cloudflare", zone: "example.com" },
  provider: createCloudflareDnsProvider({
    apiToken: process.env.CF_API_TOKEN!,
    zoneId: process.env.CF_ZONE_ID,
  }),
});
const agent = createJunctionAgent({
  config: {
    tenantId: "acme",
    name: "junction-aws-1",
    overlayNetworkId: "overlay-acme",
    dnsTargets: [{ resource: "web", app: "myapp", backendUrl: "http://127.0.0.1:7071" }],
  },
  overlay,
  policy,
  publicDns: dns,
});
await agent.start();
await agent.heartbeat(); // Funnel + CNAME reconcile
const invoice = billing.closePeriod({
  tenantId: "acme" as never,
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
});
```

## Production-shaped crypto & providers

| Surface | Implementation |
|---------|----------------|
| Route53 | Built-in **AWS SigV4** (no SDK); list + change RR sets |
| DPoP | Real **ES256 P-256** mint + verify (RFC 9449); keys under `HOBO_HOME/keys/` |
| JWT-SVID | Audience-bound short-lived SPIFFE JWTs (HS256 local / ES256 issuer keys) |
| Tailscale MagicDNS | Control-plane **API** split DNS when `TS_API_KEY` set + local `--accept-dns` |
| Netbird | Management HTTP: enroll, peers, DNS nameserver groups |
| Billing | Durable JSONL ledger + **Stripe PaymentIntent** REST provider |
| Policy | OPA HTTP → `opa eval` → **rego-lite** JSON documents |

## Residual / operational follow-ons

- Multi-process control-plane sharding for hard isolation across clusters
- SPIRE Workload API fetch as drop-in replacement for local JWT-SVID mint
- WebAuthn ceremony for human claim step-up (human-only; agents never hold passkeys)
- Netbird agent gRPC path if management HTTP enroll is disabled on your build

## Environment network isolation (ADR-0133)

Cross-env traffic is **denied by default**. Isolation classes: `local-dev`, `preview`, `development`, `staging`, `production`, `ephemeral`.

```ts
import {
  createTagAclPolicyEngine,
  EnvMembershipService,
  mintElevatedAccessCapability,
  DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK,
} from "@hobo/connectivity";

const membership = new EnvMembershipService({ tenant: "acme" });
membership.assign({
  principalId: "user:alice",
  isolationClass: "development",
  assignedBy: "cp-admin",
});
const engine = createTagAclPolicyEngine({
  envIsolation: { membership, enforceMembershipIntegrity: true },
});
// env:development → env:production denies without elevated capability
```

Policy pack id: `hobo.env-network-isolation/v1` (Rail `policyPacks`).

Conformance: `pnpm --filter @hobo/connectivity exec vitest run test/pure/env-network-isolation.test.ts`

Elevated access CLI: `hobo access request --env production --reason "..." --duration 30m`

Local-dev is air-gapped: `hobo dev` does not join remote overlays.


### Privileged Access Gateway

```ts
import {
  createTeleportPamGateway,
  mintElevatedAccessCapability,
} from "@hobo/connectivity";

const elev = mintElevatedAccessCapability({
  subject: "user:alice",
  isolationClass: "production",
  issuedBy: "cp-admin",
  evidence: { kind: "dual-approval", ref: "a1" },
  allowDefaultSecret: true,
});
const gw = createTeleportPamGateway({
  isolationClass: "production",
  elevatedHmacSecret: process.env.HOBO_SVID_HMAC_SECRET,
});
await gw.start({ stationId: "s1", tenant: "acme", isolationClass: "production", trustDomain: "yard" });
const session = await gw.brokerSession({
  subject: "user:alice",
  target: "ssh:db",
  preferSecretless: true,
  elevatedToken: elev.token,
});
// session.sessionToken is short-lived and verifiable; audit drained to Yard sink
```
