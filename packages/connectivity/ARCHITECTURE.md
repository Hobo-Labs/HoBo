# @hobo/connectivity — Architecture

## Goals

- One hierarchical, **DNS-valid** naming function for local + overlay + public.
- Soft multi-tenancy (tenant IDs + PolicyEngine) as the default isolation model.
- Metering hooks on lifecycle paths so billing is an aggregator, not a rewrite.
- Graceful local DevX: portless optional; offline port-based path unchanged.

## Binding modes

```mermaid
flowchart TB
  subgraph Naming["HoBo naming (pure)"]
    N[getNamedEndpoint / sanitizeDnsLabel]
  end

  subgraph Local["Local binding mode"]
    D[hobo dev]
    Y[serveBindleOnLocalYard / multi-host serve]
    P[portless? optional]
    S[Real Node / Wasm servers]
    D --> Y --> S
    Y --> N
    Y -.->|if present| P
    P -->|HTTPS front| S
  end

  subgraph Overlay["Cross-cloud overlay mode"]
    O[OverlayNetwork port]
    TS[Tailscale primary]
    NB[Netbird alternative]
    J[Junction agent]
    B[Broker]
    L[Dev laptop]
    O --> TS
    O --> NB
    J --> O
    B --> O
    L --> O
    J --> N
  end

  Naming --> Local
  Naming --> Overlay
```

## Pluggable DNS

```mermaid
flowchart LR
  CFG["dns.public.managedBy"]
  CFG -->|hobo| M[PublicDnsManager.reconcile]
  CFG -->|cloud-provider / none| SUG[suggest only]
  M --> PROV[DnsProvider]
  PROV --> MEM[memory]
  PROV --> DC[dnscontrol plan export]
  PROV --> CF[cloudflare / route53 / …]
  M -->|CNAME to gateway only| GW[Funnel / CF Tunnel / exit node]
  M --> MET[MeteringBus]
  SUG --> MET
```

**Rule:** public records never target raw overlay IPs.

## Multi-tenant, policy, metering

```mermaid
flowchart TB
  T[Tenant / TenantScoped resources]
  PE[PolicyEngine]
  ACL[tag-acl engine v1]
  FUT[Future: OPA/Rego / ABAC]
  PE --> ACL
  PE -.-> FUT

  LIFE[Lifecycle: junction.join / overlay.join / name / DNS]
  LIFE --> PE
  LIFE --> MB[MeteringBus]
  MB --> MEMS[In-memory sink]
  MB --> LOG[Log sink]
  MB -.-> BILL[Future billing aggregator]

  T --> LIFE
```

### How full SaaS builds on this

| Concern | Foundation today | Next phase |
|---------|------------------|------------|
| Tenants | `Tenant`, `TenantId`, `tenantContextFromEnv` | Org membership, invites, SSO |
| Isolation | Soft **and** hard (`TenantIsolationRegistry`: dedicated overlay + control-plane partitions) | Multi-process shard routing / separate clusters |
| Policy | Tag ACL + OPA HTTP/CLI + **rego-lite** JSON documents | Per-tenant OPA bundle distribution |
| Billing | Aggregator + **durable ledger** + Stripe PaymentIntent REST | Tax, dunning, hosted checkout UX |
| DNS | Cloudflare + Route53 (**SigV4**), Tailscale **API** MagicDNS, Netbird management DNS, heartbeat dynamic DNS | Multi-region failover automation |
| Credentials | DPoP from `@hobo/fleet/keys`; audience-bound **JWT-SVID** elevated capabilities through `@hobo/identity` | SPIRE Workload API fetch drop-in |

```mermaid
flowchart LR
  HB[Junction heartbeat]
  FN[Funnel / reverse proxy]
  GW["*.ts.net gateway"]
  DNS[PublicDnsManager]
  CF[Cloudflare]
  R53[Route53]
  HB --> FN --> GW --> DNS
  DNS --> CF
  DNS --> R53
  HB --> MET[MeteringBus]
  MET --> BILL[BillingAggregator]
```

## Package layout

- Ports live in `@hobo/core` (`naming`, `tenant`, `policy-engine`, `metering`, `dns`, `overlay`, extended `BindingSource`).
- Implementations live here so adapters and the composition root (`@hobo/hobo`) stay free of hard Tailscale/DNS SDK deps.
- Local serve paths call `attachNamedEndpoints` and expose results on `BareMetalServeResult` / `DevServeResult`.

## Parse, don't validate

Untrusted inputs at package boundaries are parse, don't validate: DNS labels, tenant ids, and overlay peer descriptors are parsed once into derived domain types (`NamedEndpoint`, `TenantId`, lease ids) before policy or metering. Downstream code receives those derived domain types rather than re-checking raw strings. Secretless connector options are similarly parsed into a frozen `SecretlessLease` public view — credential material is closed over internally and is never part of the derived public type.

## Event architecture

- **Command** — join overlay / register named endpoint / open secretless lease / renew lease / close lease / reconcile public DNS.
- **Event** — lifecycle facts (join, name registration, lease opened/renewed/closed, DNS reconciled) with refs and endpoints only — never credentials.
- **Actor** — Junction agent / connectivity host / secretless connector aggregate apply events in order.
- **Event store** — accepted facts append to the platform event store (credential-adjacent leases share never-compact security-audit retention when joined to `secret.Accessed` / `token.*`).
- **Materialized view / projection** — named-endpoint inventory, active leases, metering aggregates.
- **Snapshot** — in-memory lease maps and endpoint registries are the snapshot of those projections.
- **Read store** — `listLeases`, `getNamedEndpoint`, metering sinks serve the read store without replaying the raw event log.

## Traffic routing intent

```mermaid
flowchart LR
  ST[Station synthesis] --> PLAN[RoutingPlan]
  PLAN --> RESOLVE[resolveTrafficRouting offerings]
  RESOLVE --> SIMPLE[Simple inprocess.weighted]
  RESOLVE --> CF[Cloudflare lb.lifecycle + weighted]
  RESOLVE --> FUNNEL[Funnel multi + public tip]
  RESOLVE --> VERCEL[Vercel edge canary/path]
  RESOLVE --> LAKEBED[Lakebed inprocess + driver.route-bind]
  RESOLVE --> FALLBACK[Fallback ladder DNS/Funnel/inprocess]
  SIMPLE --> FACTS[routing.plan.* metering facts]
  CF --> FACTS
  FUNNEL --> OV[Existing OverlayNetwork]
  FUNNEL --> FACTS
  VERCEL --> FACTS
  LAKEBED --> FACTS
  LAKEBED --> DRV[lakebed-deploy driver program]
```

TrafficRouting coordinates backend-selection intent only. Providers **declare
offerings**; Matching/`resolveTrafficRouting` applies prefer/require + the
fallback ladder. `OverlayNetwork`, Funnel, and `PublicDnsManager` retain
connectivity and exposure ownership. Partial realization is explicit. Custom
providers: see `docs/traffic-routing-providers.md`.

## Secretless connector (ADR-0027 + ADR-0130)

Residual classical credentials (Postgres, generic TCP) are mediated: the workload dials only a stable **named endpoint**; the connector holds short-lived material closed over, performs the handshake, and shuttles bytes. Public lease objects never expose `credentialMaterial`. Preferred path remains identity federation; mediation is for protocols that cannot be pure keyless.

## Environment network isolation (ADR-0133)

```mermaid
flowchart TB
  subgraph Soft["Soft floor (always on)"]
    PE[PolicyEngine TagAcl / rego-lite]
    TAG["env: tags"]
    MEM[EnvMembershipService]
    PE --> TAG
    PE --> MEM
  end
  subgraph Hard["Hard floor (optional)"]
    REG[EnvNetworkIsolationRegistry]
    OV[Distinct overlay per class]
    REG --> OV
  end
  subgraph Elevated["Elevated path"]
    CAP[ElevatedAccessCapability JWT]
    BG[BreakGlass dual-control]
    CAP --> PE
    BG --> PE
  end
```

Modules under `src/env-isolation/`: types, membership, grants, elevated-capability, registry, compose, policy-pack, local-airgap, evaluate. Junction agents require `config.env` and refuse cross-env federation by default. Compose with `TenantIsolationRegistry` via `assertComposedIsolation` (harder axis wins).
