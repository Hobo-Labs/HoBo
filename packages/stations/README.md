# `@hobo/stations`

**Station** is the hard control-plane isolation boundary a Conductor occupies
([ADR-0131](../../docs/design/adr/01-architecture-core.md#adr-0131)). App topology
stays **Bindle ⊂ Camp ⊂ Yard ⊂ Junction** — Station does **not** contain Yards.

This package owns Station aggregates, Rails (content-addressed profiles), local
Station client under `HOBO_HOME/stations/`, and StationService fold/events.

## Install / consume

Workspace package. Prefer importing from `@hobo/stations` after monorepo build:

```ts
import {
  station,
  initStation,
  createStationClient,
  createBootstrapRail,
  StationService,
} from "@hobo/stations";
```

## Authoring

```ts
import { station } from "@hobo/stations";

export const acme = station("acme-platform", {
  isolation: {
    tenant: "acme",
    residency: "us",
    airgap: false,
    trustDomain: "acme.hobo.local",
  },
  rails: ["rail-prod"],
});
```

CLI (ops/setup, not lifecycle verbs): `hobo station init|up|down|status|rails *`.

## Station capabilities (ADR-0155)

`stationCapability()` declares a schema-versioned facility a Station offers its
occupants (`hobo.station-capability/v1`; closed kind vocabulary; provenance
`default | discovered | declared`); declarations attach via
`station(..., { capabilities })`. `matchStationCapabilities()` matches a
declared set against host observations **fail-closed** (declared-but-unobserved
is missing) and produces a `hobo.station-capability-manifest/v1`, persisted
beside the Station data (`stationCapabilitiesPath` →
`HOBO_HOME/stations/<id>/capabilities.json`). Consumed by `hobo-code init`
machine discovery — see `docs/design/stations.md`.

```ts
import { matchStationCapabilities, stationCapability } from "@hobo/stations";

const git = stationCapability({
  kind: "vcs",
  slug: "git",
  title: "git on PATH",
  required: true,
  remediation: "install git",
});
const manifest = matchStationCapabilities({
  stationId: "station:local",
  declared: [git],
  observations: [
    { capabilityId: git.id, present: true, evidence: ["bin:/usr/bin/git"] },
  ],
});
```
Missing Station fails closed — run `hobo station init`. See
[`examples/self-host-station`](../../examples/self-host-station/README.md).

## Station capability coverage (ADR-0157)

`matchStationCapabilities()` above answers "what facilities does the **host**
under this Station offer". `aggregateStationCapabilities()` answers the sibling
question one layer out: **which ADR-0151 capability profiles can this Station
satisfy at all, through which Yards, on which providers — and which expected
profiles can it not satisfy.**

A **Yard is a catalog, not an inventory** (ADR-0157 decision 1): a binding row
says the Yard is *able to* allocate an offering, not that anything is selected,
pooled, or running. Several rows per profile is therefore the **normal** case —
Azure's `web` is legitimately Static Web Apps *and* App Service *and* Container
Apps *and* AKS. So the report states **coverage breadth** (how many distinct
offerings, in which Yards) and **never picks a winner**: selection stays
ADR-0151's job at resolution time (hard gates, then lexicographic ordering).
Ordering here is a canonical sort on identifiers, carrying no preference.

Catalogs are taken **structurally** (`StationYardCatalogInput` mirrors
`YardBindingInput` without importing `@hobo/yards`) — Station is not app-topology
containment (ADR-0131: a Station *seeds* a Yard, it does not contain one), so the
aggregation takes the data and leaves the layer dependency un-taken. The record
holds identifiers only, never realization parameters, so it cannot carry a
credential.

```ts
import {
  aggregateStationCapabilities,
  renderStationCapabilityCoverage,
} from "@hobo/stations";

const coverage = aggregateStationCapabilities({
  stationId: "station:acme",
  yards: [
    {
      yardName: "yard:azure-east",
      providerId: "azure",
      bindings: [
        { profile: "web.hosted/v1", productId: "azure:app-service" },
        { profile: "web.hosted/v1", productId: "azure:static-web-apps" },
        { profile: "data.postgres/v1", productId: "azure:flexible-server" },
      ],
    },
    {
      yardName: "yard:cf",
      providerId: "cloudflare",
      bindings: [{ profile: "web.hosted/v1", productId: "cf:workers" }],
    },
  ],
  expected: ["web.hosted/v1", "data.postgres/v1", "bucket.s3-compatible/v1"],
});

console.log(renderStationCapabilityCoverage(coverage)); // hobo station status digest
```

The deep-frozen report carries `served` (offerings per profile, sorted by
profile → yard → productId, with counts, yards and providers), `gaps` (expected
profiles no Yard can satisfy, each naming what to add), `singlySourced`
(profiles served by exactly one offering — a **resilience signal, not an
error**: one catalog edit away from a gap), `providerConcentration` (factual
dependency accounting, so "every capability here is Cloudflare" is visible
without arithmetic — counts and sole-source facts, never a score), and `ok`
(no gaps in the expected set). `renderStationCapabilityCoverage()` produces a
short deterministic plain-text digest with gaps first; it takes no TUI or
design-system dependency.

Parse-don't-validate and fail-closed: a bad profile grammar, a row constraining
neither `productId` nor `connectivityId`, a duplicate row or Yard, or a
malformed catalog is a typed `StationCapabilityCoverageError` (`code` +
`remediation`), never a silently skipped row — a dropped row would understate
coverage, which is a portability lie. The report is a pure function of its input
and carries **no timestamp**: nothing about coverage depends on when it was
computed, and a `generatedAt` would make two equal inputs compare unequal.

### Honesty: what coverage does and does not mean

Coverage means a Yard **declares** it can allocate an offering for the profile.
It is **not** evidence that a Resource Definition is registered, that the named
product exists in the catalog, that the provider matches, or that a deploy would
succeed. Those are resolution-time gates and surface as `YARD_BINDING_PRODUCT_UNKNOWN`,
`YARD_BINDING_PROVIDER_MISMATCH`, and `YARD_BINDING_EXCLUDED_ALL` (ADR-0157
decision 4) — not here. Aggregation deliberately does not infer a product's
provider from its id (ADR-0144 forbids naming-convention inference), so
`ok: true` reads exactly as "every expected profile has at least one declared
offering", and nothing stronger.

## Traffic routing synthesis

`applyRoutingObservations` merges provider `observe.health` / `observe.location`
signals into a topology before synthesis. Missing signals stay best-effort
(degraded notes); confirmed health/location can yield a non-degraded plan.

`synthesizeRoutingPlan` is the pure Station-side bridge from a portable topology
snapshot plus an existing `PolicyDecision` to a parsed `RoutingPlan`. Missing
Station context, a mismatched/denied policy decision, or a confirmed minimum-
availability violation returns a typed denial. Known-unhealthy backends are
excluded; unknown health/location signals produce a degraded best-effort plan
with explicit notes. Synthesis does not call clouds or take ownership of Junction overlay configuration. See
[ADR-0143](../../docs/design/adr/07-portability-extensibility.md#adr-0143).

## CI budget routing

For the hosted relay, publish the desired policy with
`createCiRelayClient().putDesiredPolicy(policy, {revision})`. Set its thresholds
in the SDK policy, then connect a scoped observation publisher to Broker:

```ts
import { createCiRelayClient } from "@hobo/ci-gh-actions/client";
import { createHostedCiBudgetRoutingBridge } from "@hobo/stations";

const bridge = createHostedCiBudgetRoutingBridge({
  accountId: "acme",
  tenantId: "acme",
  client: createCiRelayClient({
    origin: "https://ci.example.com",
    accountToken: () => readObservationToken(), // observations:write
  }),
});
// Deliver Broker's {type, data} facts and acknowledge only after success.
await bridge.accept(JSON.stringify({ type: signal.type, data: signal.data }));
```

The hosted bridge retries revision conflicts up to five times. Replaying an
already applied fact is idempotent. Policy thresholds and enabled providers
remain operator-owned; the signal publisher cannot change provider balances or
operator intent. The subscriber must retain and retry failed facts.

For the legacy self-hosted v1 relay, `createCiBudgetRoutingBridge()` turns tenant-scoped Broker
`budget.ThresholdCrossed` and `budget.Recovered` facts into eligibility changes
on a HoBo CI account. The relay selects the eligible offer with the lowest
projected cost after applicable free allocation, within account and provider budgets.
Offer IDs below refer to offers already configured on that account.

```ts
import type { BudgetSignal } from "@hobo/broker";
import { createCiRelayClient } from "@hobo/ci-gh-actions/client";
import { createCiBudgetRoutingBridge } from "@hobo/stations";

export function ciBudgetSubscriber(accountToken: () => Promise<string>) {
  const bridge = createCiBudgetRoutingBridge({
    client: createCiRelayClient({
      origin: "https://ci.example.com",
      accountToken,
    }),
    policy: {
      accountId: "acme",
      tenantId: "acme",
      normalOfferIds: ["github", "blacksmith", "depot", "k8"],
      thresholds: [
        { thresholdFraction: 0.8, offerIds: ["depot", "k8"] },
        { thresholdFraction: 1, offerIds: ["k8"] },
      ],
    },
  });
  return {
    deliver: (signal: BudgetSignal) =>
      bridge.accept(JSON.stringify({ type: signal.type, data: signal.data })),
    reconcile: () => bridge.reconcile(),
  };
}
```

Attach `deliver` to the existing Broker budget-fact subscription, passing only
its `{type, data}` projection. The host supplies the account-token callback from
its secret binding. A revision conflict propagates to the subscriber; retry the
same journal fact after rereading policy. Do not acknowledge a failed delivery.

The bridge rejects malformed and foreign-tenant facts before calling the relay.
It persists each threshold's cycle and crossed state in the account's revisioned
policy, so restart and duplicate delivery preserve ordering. The highest active
configured threshold selects the profile, including when different thresholds
arrive out of order. Recovery restores the next active profile or
`normalOfferIds`. An empty offer list explicitly pauses admission. Unknown offer
IDs fail without a policy write.

Call `reconcile()` after changing the configured profiles to apply them to the
persisted crossing state without inventing another Broker event. Changes affect
future execution eligibility; they do not migrate a running job. The bridge
preserves monetary snapshots and lease accounting. Its runtime dependencies are
the shared CI protobuf contracts and a structural policy-client port; it does
not import the Broker or GitHub Actions runtime.

Tests feed real `foldBudgetSignals()` output into the bridge and durable relay
policy, then exercise CI routing, recovery, replay and conflict handling. The
Station Pact artifact pins the policy read/write boundary. These tests require
no live provider account.

## Honesty

- Control-plane isolation primitive; not a multi-tenant hosted product by itself.
- Privileged access gateway helpers re-export from `@hobo/connectivity` where applicable.
- Live multi-Station federation remains out of this package’s local client path.

## Scripts

```sh
pnpm --filter @hobo/stations test
pnpm --filter @hobo/stations build
```

## Related

- `@hobo/broker` — pure Conductor (receipts pin `stationId` + `railHash`)
- `@hobo/connectivity` — overlay / PAM / policy foundations
- Design: ADR-0131, package map in `docs/design/package-namespaces.md`

## Budget-driven routing transitions

`createRoutingControlLoop` executes routing decisions under an explicitly declared
`topology.costRouting` (`stateless`, `active-active-eventual`, or
`pinned-with-replica`). A single-writer or undeclared topology cannot move on a
price signal. Budget signals are tenant-bound triggers; the fresh ledger and
financial supervisor authorize the actual transition.

A routing change requires `ledgerView`, `persistState`, and `beforeApply`.
`beforeApply(plan, phase, percent, reason)` must check the supervisor's verified
reservation and current policy before every provider effect; its reason separates
ordinary optimization, forced recovery, and source restoration. A forced unhealthy
incumbent bypasses optimization cooldown/flip limits and may use the explicit
`recoveryLedgerView` backed by a protected recovery allowance. Missing supervisor
capabilities refuse the move; the loop never invents a hard budget guarantee from
an empty ledger. Financial settlement and source retirement belong to the hosting
transition supervisor, not the traffic-routing port.

The host CAS-persists the generated `RoutingControlStateRecord` under its service
actor fence. `snapshot()` and `initialState` retain incumbent, stability history,
sustained savings evidence, and pending effect identity across restart. Provider
writes are serialized within one loop; `persistState(state, expectedStateVersion)`
must compare and advance `stateVersion` on every checkpoint under the cross-process
actor fence. This version is independent of the plan `revision`. After uncertain writes, new signals
return `reconciliation-required`; `reconcilePending()` checks the persisted approved plan artifact, current policy
and constraints, active/full provider status, and fresh scoped destination/source
health before accepting final applies or restorations. Intermediate interrupted ramps stay
pending for the supervising durable saga.

Non-progressive writes also require an explicit `healthGate`.

Progressive cutover requires a validated adapter-specific `precondition`, destination
`healthGate`, source `restorationHealthGate`, and an awaited `beforeApply`
admission/checkpoint hook. The prerequisite includes the exact immutable
`incumbentPlan` plus `incumbentPlanId`; its tenant/service/Station/Rail scope and
active/full provider status are checked before the first shift. Compensation
restores that artifact under a new operation identity, with the prior artifact
hash recorded, rather than rebuilding a plan from the candidate set. DNS changes
add TTL evidence; weighted routing does not invent DNS obligations. Availability
and resiliency are preserved in every phase, and infeasible final shapes refuse
before traffic moves. `minObservationSeconds` requires timestamped, distinct health
observations after that interval; the supervisor owns the timer/observation port.
The interval starts after native apply and active/full status confirmation;
authorization, checkpoint and adapter latency cannot count as healthy serving time.
Restart reconciliation establishes and persists a fresh observation baseline before
accepting an interrupted operation, then retains that baseline across health probes.
Structured observations expire after `maxObservationAgeSeconds` (default 30 seconds),
including during restart reconciliation. Provider acknowledgements and statuses must
identify the exact requested plan; acknowledgements also identify the adapter.
A boolean gate is an explicitly supplied trusted observation callback and cannot
satisfy a declared timed observation window.

Effects use the existing `@hobo/contracts` models: routing mutations are
`noRollback` and attempted once, while read-only status observations have bounded
retries. `contract.EffectInvoked`, `resilience.*`, `routing.ApplyRequested`, and
`routing.Observed` facts expose the boundary. The resilience applicator does not
implement wall-clock deadline or delay enforcement; durable supervision owns those
policies. Failed or ambiguous compensation reports recovery pending and never
claims `domain.RolledBack` until active/full restoration is observed.

`TrafficRoutingPort` capability limitations remain real: a weight-only adapter
that returns partial realization for availability or resiliency cannot complete a
cutover requiring those guarantees. Tests use explicit contract-backed adapters
for stronger guarantees; they do not certify live cloud behavior.
