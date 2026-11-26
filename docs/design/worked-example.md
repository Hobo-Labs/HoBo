---
type: Reference
title: "End-to-End Worked Example"
description: "```bash"
tags: [hobo, design]
---

# End-to-End Worked Example

## Plan 19

> **Authoring (closure builder + IfC collection).** The v1 authoring path is an explicit
> closure-builder `bindle.ts`: resources are assembled as provider-agnostic manifest objects,
> their permissions remain inferred from use, `.allow()` only narrows, service code still compiles to
> a **wasm component**, and the topology is collected from the closure-builder corpus ([Plan
> 20](./wasm-runtime-wit.md#plan-20)/[Plan 21](./authoring-resources-wiring.md#plan-21)). HoBo keeps
> app-host code outside Bindle assembly: `b.api(() => api.run())` records an inert workload boundary,
> not a request router or runtime process.
> ```ts
> // bindle.ts - v1 closure-builder corpus
> import { bindle } from "@hobo/bindles";
> import type { OrderEvent } from "./shared/types";
> import myApi from "./src/api";
>
> export default bindle("snapshop", (b) => {
>   const cache = b.cache();
>   const orders = b.queue<OrderEvent>();
>   const api = b.api(() => myApi.run()).dependsOn(cache, orders);
>
>   return { cache, orders, api };
> });
> // `hobo collect` consumes this corpus → hobo.manifest/v1 with dependsOn edges.
> ```
> **Stub → AI-implement (Plan 23):** a `payments` capability can ship as `service("payments").stub()` so checkout runs end-to-end on day one; the generation pipeline later generates the real component, validated against conformance + the recorded stub traces, and promotes it through a gated rollout. Everything else in the narrative below (deploy to one cloud → multi-cloud split → provider tuning → agent-operated → generation pipeline) is unchanged.

> **Dynamic configuration (Plan 25/26):** the developer never picks infra for `db` — a **platform engineer** writes **Resource Definitions** and the *same* `bindle.ts` resolves differently per **environment type**:
> ```ts
> // platform/resource-defs.ts
> defineResource({ type: "database", engine: "postgres", class: "ha",
>   provider: aws, driver: "terraform", with: aws.rds({ multiAz: true }),
>   match: { envType: "production" } });               // prod → managed HA RDS
> defineResource({ type: "database", engine: "postgres",
>   driver: "container", with: { image: "postgres:16" },
>   match: { envType: "ephemeral" } });                // preview → cheap in-cluster
> ```
> `hobo up --camp prod` → matches the HA definition; `hobo up --camp preview` (an **ephemeral** Camp, auto-TTL) → matches the in-cluster one. Each choice emits a **`match.Decided`** event (score + rejected candidates) so the dashboard answers "*why did preview get the cheap DB?*". A **Pipeline** can open the prod **Delta** behind an **approval gate**; if the cluster is private, Executors run behind the **HoBo Relay**. The app code and `bindle.ts` are untouched throughout.

> **Contracts & policy gates (Plan 29/30):** later, the team ships `api@v3` that drops `tenantId` from `order.created`. `hobo verify --target prod` **blocks**: the contract plane's `can-deploy` finds `worker@v2` (running in prod) still consumes `tenantId` (`compat.GateFailed`), and the policy plane flags the new public endpoint with an *obligation* ("allow but require auth middleware"). The verification report replays the gate events and can include a dry-run remediation proposal — for example a **dual-publish migration window** + an auth binding. After the shim + a green eval gate on the updated classifier, `hobo verify` passes and the prod Delta promotes as a canary (the policy obligation). Nothing here is a separate CI tool — it's the same event-sourced graph.

> **Data plane ([Plan 32](./data-plane.md#plan-32)):** snapshop's domain data is **event-sourced by default**. The `reserve`/`charge` steps in §1 use `ctx.bindings.db.reserve(...)` — that direct DB call is the *escape-hatch* form ([raw/adopted access](./data-plane.md#plan-32)); the default domain write is **command → aggregate → event**, and reads come from **projections** a data architect maps onto any backend.
> ```ts
> // domain.wit — the canonical domain schema (Plan 24 / ADR-0051) → generates TS types + protobuf event bodies
> //   record order { id: string, status: order-status, total: u64 }   enum order-status { placed, confirmed, shipped }
>
> // src/api/orders.ts — WRITE: a command runs inside the Order aggregate (an actor; ADR-0053)
> import { command, view } from "@hobo/data";
> export const placeOrder = command("Order.Place", { key: (i: PlaceOrder) => i.id }, (input, ctx) => {
>   if (ctx.state.status) throw new Conflict("order exists");         // invariant vs the aggregate's write-model fold
>   ctx.emit("OrderPlaced", { id: input.id, total: input.total });   // appended under the aggregate's lease + optimistic seq
> });
>
> // READ: a reactive, projection-backed view (Plan 32) — no table, no SQL, backend-neutral by logical name
> export async function myOrders(userId: string) {
>   "use query";
>   return view("orders").where({ userId, status: "placed" }).order("createdAt").paginate({ limit: 20 });
> }
> ```
> The `orders` **projection** folds `Order.*` events into a read model; a **platform/data engineer** picks its sink exactly like the `db` definition in the dynamic-configuration model above — `defineResource({ type: "projection-sink", paradigm: "relational", match: { envType: "production" } })` in prod, the native log-backed projection in preview — recorded in **`match.Decided`**. App code names `view("orders")`, never a backend, and the `OrderConfirmed` saga (§1) is unchanged (it already reacts to domain events). *Developers don't know how orders are stored or queried; the architect has full control* — the data-plane thesis, shown end to end.

> **The Crew operates, generates & heals it ([Plan 40](./operators-sre.md#plan-40)–[44](./operators-sre.md#plan-40)):** snapshop runs itself. The **Platform Engineer** agent generates and self-heals the storefront's *infrastructure* — projections off `view("orders")`, handlers, and AI-generated adapters behind ports ([Plan 23](./generated-stack.md#plan-23)); the **UX Designer** generates the developer's product UI from intent + `design.md` via the `ui-render` port ([ADR-0056](./adr/03-data-plane.md#adr-0056) — in scope per [ADR-0064](./adr/07-portability-extensibility.md#adr-0064)); the **GitOps** agent promotes staging→prod only when `can-deploy` is green ([Plan 25](./platform-engineering.md#plan-25)/[Plan 29](./contracts-policy-flags.md#plan-29)). Then prod `checkout` latency burns its SLO:
> ```txt
> Endpoint Monitor → slo.BudgetBurned(checkout.latency)
> SRE: incident.Opened(SEV2) → diagnose (HolmesGPT behind a port) → classify: provider-degraded (db)
>   → auto-fix? low-risk + reversible + in-budget + conformance-green
>      → live-fix: fail db over to prod-azure as a canary (Plan 23/5)
>   → policy gate (Plan 30): prod write → allowed as canary w/ auto-rollback
>   → incident.Resolved; postmortem generated by replaying incident:<id>; the failing trace = a regression test
> ```
> A SEV1 the SRE can't classify **escalates** — an on-call obligation with a deadline pages up the ladder ([Plan 29](./contracts-policy-flags.md#plan-29)/[Plan 40](./operators-sre.md#plan-40)). And snapshop is **patchable**: swapping the SRE's diagnosis engine (HolmesGPT → built-in) or forking the `runtime-postgres` backend is a signed, conformance-gated plugin — no app edit ([Plan 23](./generated-stack.md#plan-23)). *Developers wrote app logic; the Crew runs, generates, heals, and explains it.*

### 1. Scaffold & build locally (no cloud)
```bash
npx hobo new snapshop -t fullstack && cd snapshop && hobo dev
```
`bindle.ts` — the *what* (agnostic):
```ts
import { bindle } from "@hobo/bindles";
import type { OrderEvent } from "./shared/types";
import api from "./src/api";
import site from "./src/site";

export default bindle("snapshop", (b) => {
  const db = b.data({ engine: "postgres", require: "managed" });
  const images = b.objectStore();
  const orders = b.queue<OrderEvent>();

  const apiService = b.api(() => api.run()).dependsOn(db, images, orders);
  const webSite = b.web(() => site.render()).dependsOn(apiService);
  return { db, images, orders, api: apiService, site: webSite };
});
```
Returned keys such as `api` and `orders` are generated authoring aliases only. Deployment identity,
manifest resource IDs, and physical naming seeds come from HoBo-generated IDs, so alias renames do
not become provider resource names. The HOBO-537 author-flow proof registers this closure-builder
corpus as the v1 SDK conformance path.
`src/api/checkout.ts` — the *runtime* (durable workflow + choreography saga):
```ts
import { step } from "@hobo/runtime";
import { saga, emit } from "@hobo/events";

const reserve = step(async (o: Order, ctx) => ctx.bindings.db.reserve(o));
const charge  = step(async (o: Order) => paymentApi.charge(o), { retries: 5 });

export async function checkout(order: Order) {
  "use workflow";
  await reserve(order);
  await charge(order);
  await emit("OrderConfirmed", { orderId: order.id });   // ambient, like sleep/start
  return { status: "confirmed" as const };
}

export const fulfillment = saga("fulfillment")
  .on("OrderConfirmed", (e, ctx) => ctx.emit("ShipmentRequested", { orderId: e.orderId }))
  .compensate("ChargeCaptured", (e, ctx) => ctx.emit("RefundRequested", e)); // on later failure
```
`hobo dev` runs this against `@hobo/runtime-local`: Postgres in a container, a local object store, an in-memory queue. The developer drives a checkout; `hobo inspect run <id>` shows the workflow/step timeline; killing and restarting `hobo dev` **replays** the run to the same state (durability proven before any cloud).

### 2. Map to one provider ("just host it on Azure")
A **Yard** owns provider selection; a **Camp** is provider-neutral until attached (no separate config file, [ADR-0011](./adr/01-architecture-core.md#adr-0011), [yard-first-placement](./adr/yard-first-placement.md)):
```ts
import { camp } from "@hobo/camps";
import { yard } from "@hobo/yards";
import { azure } from "@hobo/provider-azure";
import { pulumi } from "@hobo/iac-pulumi";
import { postgresRuntime } from "@hobo/runtime-postgres";
import shop from "./bindle";   // the provider-agnostic Bindle above

export const prod = camp("prod", {
  runtime: postgresRuntime({ url: process.env.DATABASE_URL }),
});
export const azureYard = yard("azure", {
  provider: azure({ region: "eastus" }),   // Yard owns cloud selection
  iac: pulumi(),
  camps: [prod],
});
// Deploy Bindle → Yard/Camp (Camp does not own the Bindle)
// e.g. deploy(shop, { yard: azureYard, camp: prod })
```
```bash
hobo login            # dev obtains an SVID (OIDC); no cloud keys pasted
hobo plan --camp prod # dry run (provider inferred from Yard)
```
`hobo plan` output (illustrative): resolves `db→Azure Flexible Server (managed ✓)`, `images→Blob`, `orders→Service Bus`, `api→Container Apps`, `site→edge`; **estimated cost $X/mo**; all colocated in `eastus` (no cross-cloud egress). Then:
```bash
hobo up --camp prod --strategy canary
```
Under the hood ([Plan 4](./control-plane.md#plan-04), [Plan 11](./data-plane.md#plan-11)): Gateway emits `deployment.Requested` → Planner `deployment.Planned` under the Yard provider → ResourceActors provision in DAG order (`db`, `images`, `orders` in parallel → then `api` → then `site`), each via Pulumi Automation API inside a Firecracker Executor holding a **short-lived Azure token brokered from the dev's SVID** — no static secret anywhere. Outputs (conn strings) wire into `api` as secret refs. Canary shifts traffic with a health gate before going 100%. Every step is an event; the dashboard shows the live timeline and the credential audit.

### 3. Optimize a boundary (mapping overrides under the Yard, no app edits)
Marketing wants the storefront on the edge and the team has a Cosmos commitment. Change **only** mapping overrides under the Yard provider (not Camp-owned cloud pins):
```ts
export const prod = camp("prod", {
  runtime: postgresRuntime({ url: process.env.DATABASE_URL }),
  // resourceMappings / defineResource overrides under the Azure Yard —
  // e.g. pin snapshop.db → azure.cosmos; edge tier → cloudflare.workers
});
// Cross-cloud edge split is a second Yard + Junction (or Trail re-home),
// not camp({ defaultProvider, tiers: { edge: cloudflare } }).
```
The `bindle()` (provider-agnostic) and all of `src/` are untouched. `hobo plan` now shows `site→Cloudflare` (via the edge Yard/Junction path), `db→Cosmos`, flags a **cross-cloud egress edge** `site↔api` with its estimated cost ([Plan 12](./security-networking.md#plan-12), [Plan 5](./reliability-observability-cost.md#plan-05)), and connects them over mTLS keyed by workload SVIDs. `hobo up` reconciles: only the changed resources are re-provisioned; the rest are diff-empty no-ops. **Camps re-home across Yards via Trails**, not by editing Camp-local provider fields.

### 4. Provider-specific tuning (the escape hatch)
Black-Friday prep — tune just the API tier, still cloud-portable:
```ts
// bindle.ts (the only app-side change, additive + typed)
apiService
 .with(aws.fargate({ autoscale: { min: 3, max: 50 } }),
       azure.containerApps({ minReplicas: 3, maxReplicas: 50 }));
```
Only the resolved provider's block applies; targeting the other cloud needs no further edits ([Plan 2](./sdk-api.md#plan-02)).

### 5. An agent operates it (zero developer effort)
> This is the *ad-hoc external* agent path. The **built-in Operator Crew** ([Plan 40](./operators-sre.md#plan-40), shown in **the Crew addendum** above) runs the same surface continuously and autonomously — the SRE operator *is* the always-on version of the flow below.

The team points an MCP client (Claude) at the Yard. The ops agent:
1. `search_registry("database postgres managed")` → reads Capability Manifest; finds a cheaper region.
2. `plan` a region move → sees cost delta + egress impact.
3. The move would exceed its `spendCapUsd`, so the **policy gate** opens a `require-approval` hook → a human approves in the dashboard.
4. `deploy` → the agent obtains scoped tokens via the broker (no keys), reconciles, and watches `inspect_run`/`tail_logs`; if a step regresses, the canary gate auto-rolls back and the agent reports why.
Every agent action, token grant, and approval is an event in the `CredentialAudit` trail ([Plan 6](./ai-native-agent-auth.md#plan-06), [Plan 5](./reliability-observability-cost.md#plan-05)).

### 6. A missing provider appears on demand
The team wants a niche EU host with no `@hobo/provider-*` yet:
```bash
hobo generate https://niche-eu-cloud.example.com/docs
```
The **generation pipeline** generates a candidate provider, runs it sandboxed against `@hobo/conformance` for the ports snapshop uses, and on pass publishes a signed plugin to the Registry. the `camp()` mapping can now target it like any first-party provider ([Plan 6](./ai-native-agent-auth.md#plan-06), [Plan 9](./generated-stack.md#plan-09)).

### What this proves
A single, untouched application description (`bindle.ts` + `src/`) ran locally, shipped to one cloud, split across three, was tuned per-provider, operated by an agent under guardrails, and extended to a brand-new provider — **agnostic by default, optimizable on demand, AI-native throughout, fully auditable.** That is the thesis of HoBo, demonstrated end to end.
