# @hobo/cloud — the Yard control-plane kernel + Planner

Production package for **S2-01** (Yard kernel) and **S2-02** (Planner + Matching)
of the [engineering build plan](../../docs/plans/0003-engineering-build-plan.md),
implementing [`docs/design/control-plane.md`](../../docs/design/control-plane.md).

A coherent vertical: a **Deploy command** becomes past-tense **events**, the pure
**Planner** resolves them to a content-addressed `DeploymentPlan` DAG, and a
**materialized view** (projection) reconstructs deployment state from the log.

Resource definitions may carry `commercialProductRefs` through manifest
registration and replay. `pricingCatalogHash` delegates to the actual
`@hobo/pricing` catalog content hash; `capabilityCatalogHash` hashes a separate
versioned capability document. Neither changes resource-definition
`catalogHashOf`, and product-ref lists are never used as pricing catalog hashes.

## Continuous Delivery plane (attested apply)

`src/cd/` is the **workload-attested, secret-free-by-construction** apply path
over a Gatekeeper-approved resolved Deployment Set — not an Argo-style controller.

Both **`mode: "simulate"`** (offline equip) and **`mode: "live"`** (injected
`IacProvider` / `Executor`) share the same contracts: attestation, short-lived
scoped credentials, Executor sandbox, secret-free status/diff, progressive
composition, and failure disposition.

1. **Resolved Set** (`createResolvedDeploymentSet`) — post-Matching plan + Gatekeeper allow.
2. **Attested apply worker** (`createAttestedApplyWorker`) — SVID + launch measurement;
   short-lived scoped credentials per resource, revoked after each step; no ambient keys.
   Live mode fails closed without injected IaC/Executor.
3. **Secret-free status/diff** — references only (`secretRef:` / `valueRef:`); closes
   ServerSideDiff-class leaks. Status after apply returns recorded scrubbed projections.
4. **Progressive composition** via Harness OpenDelivery (flag ramp ± gateway weight ±
   auto-rollback on SLO/Golden). Rollback zeros flag percent, gateway weight, and
   activates kill-switch. Optional residual analysis adapters (Flagger/Argo-shaped HTTP)
   are complete fail-soft ports.
5. **Failure path** — Incident → default **A2H** handoff (typed package + deadline
   obligation); opt-in self-heal only inside an ADR-0076 lane, proposing a Delta that
   re-enters Gatekeeper + Harness (never baseline mutation). Unknown blast radius
   fails closed to A2H.

```ts
import {
  createContractAssertedCdFixtures,
  createContinuousDeliveryPlane,
} from "@hobo/cloud";

const fx = createContractAssertedCdFixtures({ tenant: "acme" });
const plane = createContinuousDeliveryPlane({ mode: "simulate" });
const result = await plane.deliver(fx.set);
// result.apply.principal.attestationState === "attested"
// result.apply.secretFree === true
// result.apply.activeCredentialsAfter === 0
```

CLI: `hobo deploy status|logs|rollback`, `hobo incident status|open` — each drives
the shipped plane (real deliver events for logs; real A2H/self-heal dispositions).

## Architecture

- **Gateway** (`src/gateway/`) — command ingress. Authenticates + authorizes the
  principal, turns a `Deploy` command into facts, and serves read models.
  Commands are never stored; only past-tense events are appended.
- **Store** (`src/store/`) — the core **EventStore** port (an append-only event
  store) backed by runtime-local's sqlite engine in tests (Decision D6). The
  aggregate write path runs as a single-writer **actor** via the ActorHost lease.
- **Projections** (`src/projections/`) — built on `@hobo/data`'s `defineProjection`.
  The **DeploymentView** read store rebuilds from zero; a **snapshot** is only a
  cache, never a source of truth. Emits `projection.*`.
- **Registry** (`src/registry/`) — a catalog **projection** over provider
  `capabilityManifest()` publications (Decision D2), plus the `PlannerRegistry`
  the Planner consults.
- **Planner** (`src/planner/`) — the pure function
  `plan(bindle, config, registry) → DeploymentPlan` (6 steps): lower manifest IR →
  `ResourceIntent`; collect bind-edge DAG; resolve a Resource Definition per
  resource (recording `match.Decided`); capability negotiation via the provider
  `Capability.satisfies`; region/colocation; min-cost objective ranking with a
  stable tiebreak. Unsatisfiable resources emit `deployment.PlanRejected` with a
  machine-readable remediation.

### Records: parse, don't validate

Records, messages, data shapes, and objects are defined in protobuf
(`data-models/cloud.proto`) with CUE constraints (`data-models/cloud.cue`). The
TypeScript domain types are **parsed derived types** (parse, don't validate): the
constructors in `src/plan-types.ts` are the only way to build a plan value, so
downstream code never re-validates a raw record.

### Event catalog

`deployment.Requested` · `match.Decided` · `deployment.Planned` ·
`deployment.PlanRejected` · `provider.Registered` (per-resource subjects like
`match.Decided:<resource>` are carried in the fact body, since the core envelope
type pattern forbids a colon in the type string).

## Gates

```sh
unset NODE_OPTIONS
pnpm --filter @hobo/cloud run build      # tsc
pnpm --filter @hobo/cloud run test       # vitest
pnpm run architecture:guard              # boundary/records/PACT evidence
```
