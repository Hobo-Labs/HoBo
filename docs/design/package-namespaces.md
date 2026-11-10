---
type: Reference
title: "Package Namespace Map"
description: "This note is the canonical import-ownership map for HoBo TypeScript packages. It"
tags: [hobo, design]
---

# Package Namespace Map

This note is the canonical import-ownership map for HoBo TypeScript packages. It
backs ADR-0087 and gives docs, generators, and boundary lint one table to check.

## Namespace Rules

- `hobo:sdk` is the WIT package contract. It is not the same thing as npm
  `@hobo/sdk`.
- `@hobo/bindles` is the app authoring idiom layer. It owns the explicit
  `bindle(name, builderFn)` closure builder, resource catalog builder methods,
  app config references, connector helpers, and fluent bindle composition.
- `@hobo/runtime` is the app runtime authoring layer. It owns workflow, step,
  handler, actor, hook, training, and runtime error primitives.
- `@hobo/data` owns CQRS read/write model helpers. `@hobo/events` owns messaging
  and choreography helpers.
- `@hobo/camps`, `@hobo/yards`, and `@hobo/junctions` own topology factories.
  They stay separate from `@hobo/bindles` so topology placement is visible in
  imports.
- `@hobo/sdk` is the operator and self-host SDK. It owns provider/resource
  implementation contracts, policy packs, runbooks, dispatchers, generated
  provider helpers, and chaos tooling. App authors should
  not import application resources from `@hobo/sdk`.
- `@hobo/core` is the shared type substrate for generated bindings and package
  internals. It does not expose app authoring factories.

## Canonical Import Table

| Symbol or family | Package | Importer | Boundary rationale |
|---|---|---|---|
| `bindle(name, builderFn)`, `.allow`, `.with` | `@hobo/bindles` | app authors | App manifest assembly belongs with the resource idiom layer; app-host behavior belongs to imported app/framework code. |
| `sessionReplay({ enabled?, sampleRate? })` | `@hobo/bindles` | app authors | Session Replay platform annotation for every **App Kit** (default-on at construction; opt out with `enabled: false`). Runtime wrap/inject lives in `@hobo/replay` ([ADR-0137](./adr/03-data-plane.md#adr-0137)). |
| closure builder methods (`b.api()`, `b.web()`, `b.kv()`, `b.bucket()`, `b.queue()`, `b.topic()`, `b.secret()`, `b.data()`, `b.service()`) | `@hobo/bindles` | app authors | Explicit Bindle v1 resource methods stay inside the closure builder and do not take resource name arguments. Names come from the record keys the builder returns. |
| standalone IfC resource factories (`api`, `kv`, `bucket`, `queue`, `topic`, `secret`, `data`, `schedule`, `websocket`, `job`, `web`, `service`, `flag`, `auth`, `crypto`, `notify`, `guardrail`, `ui`, `experiment`) | `@hobo/bindles` | app authors | Plan 21 catalog (19 factories); frozen in `packages/bindles/contracts/bindles-public-api.snapshot.json`. `search` is not a factory (ADR-0034). Golden evals are an always-on same-Camp sidecar (default suite plus optional project / trainable overlays), not a factory. Legacy names such as `database`, `objectStore`, `rollout`, `slo`, and `trainable` are not part of this catalog. |
| `connector` | `@hobo/bindles` | app authors | Connector binding is an app-level external dependency declaration, not operator topology. |
| `config`, `secretRef`, `env`, `fromBinding` | `@hobo/bindles` | app authors | Config references are app authoring values that resolve through bindles. |
| `secret` | `@hobo/bindles` | app authors | Managed secret resources are catalog resources; `secretRef` is the config-value reference. |
| `workflow`, `step`, `handler`, `cron`, `sleep`, `actor`, `start`, `createHook`, `training`, `from`, runtime errors | `@hobo/runtime` | app authors | Runtime control flow is separate from resource declaration. |
| `command`, `view`, `projection`, `repo` | `@hobo/data` | app authors | CQRS helpers are data-plane authoring, not runtime control flow. |
| `emit`, `subscribe`, `saga` | `@hobo/events` | app authors | Messaging and choreography stay in the events namespace. |
| `camp` | `@hobo/camps` | platform authors and app/platform topology docs | Camp placement is topology, not an app resource catalog primitive. |
| `yard`, `domain` | `@hobo/yards` | platform authors | Yard tenancy, placement, and admission attach policy without builder-level approval shortcuts. |
| `junction` | `@hobo/junctions` | platform authors | Junction routing stays explicit at topology edges. |
| Session Replay (tracker, privacy, dual fixtures, player, retention) | `@hobo/replay` | app authors + platform + agents | Privacy-first session reconstruction on every **App Kit** by default; composed over Stations/Junctions/Trails/Harness; not control-plane event-log replay ([ADR-0137](./adr/03-data-plane.md#adr-0137)). |
| App Kit taxonomy (`APP_KIT_KINDS`, `isAppKitKind`, …) | `@hobo/bindles` | app authors + platform | Bindle-declared application surfaces (api/web/service/ui/websocket/job/wasm-component). Prefer **Kit** over "membrane type" at authoring; WIT membrane stays `@hobo/wit` / ADR-0069. |
| Trails (continuous migration recipes, can-trail, history, dual fixtures) | `@hobo/trails` | app authors + platform | App-owned versioned Trails compose platform `identity.continuous` (hands-off). Continuous identity itself remains Matching/policy-driven with zero Trail authoring ([ADR-0134](./adr/02-identity-security.md#adr-0134)). |
| Coding harness / distributed compute (`hobo-code` binary) | `@hobo/code` | app authors + agents | Standalone binary `hobo-code` (dispatch default; flat verbs). Elevates codegen (HOBO-152) and hobo-code-dsl (HOBO-394); mediated isolation + gated promotion + distributed hive ([ADR-0139](./adr/03-data-plane.md#adr-0139)). Programmatic agent runs use AI SDK `HarnessAgent` + builtin `@ai-sdk/harness-*` adapters (or in-repo HarnessV1 for CLI/Eve/SDK); TTY seating stays mux. Not a `hobo <verb>`. For Bindle `dev` / `/hobo …` it loads sibling `@hobo/hobo` in-process (`serveProjectOnLocalYard`, `createComposedHoboCli`) — same components the composed `hobo` binary wires; **does not require `hobo` on PATH**. |
| `defineResource`, `dispatcher`, `runner`, `runbook`, `generateProvider` | `@hobo/sdk` | provider authors and self-host operators | Provider/runtime implementation hooks are not app authoring factories. `dispatcher()` here is the operator **authoring factory** over the `@hobo/dispatcher` engine. |
| Dispatch decision engine (`dispatch.Decided`/`dispatch.Reservation*`, registry, reservation ledger, replay) | `@hobo/dispatcher` | control plane + stations + broker | ADR-0071 credit/budget-aware deterministic selection — a pure function of (registry, `CreditLedgerView@seq`, request); promoted from the maximize-credits proof. |
| CI allocation routing, portable pipelines, durable reservations | `@hobo/ci` | CI relay operators + backend authors | Reuses `@hobo/dispatcher`; Worker-safe execution contract is `@hobo/ci/execution`, Node ledger and scheduler are explicit subpaths. |
| Actions relay and bound command execution; Azure Pipelines self-hosted config; Dagger and Cloudflare CI executors | `@hobo/ci-gh-actions`, `@hobo/ci-ado`, `@hobo/ci-dagger`, `@hobo/ci-cf` | CI integrations + tests | Interchangeable implementations of the portable CI execution contract; GitHub workflow routing uses the Actions relay. |
| `policyPack`, `rule`, `waiver`, `chaos` | `@hobo/sdk` | operators | Governance and resilience tooling target operator workflows. |
| shared schemas and branded IDs | `@hobo/core` | package internals, generated code | Stable internal substrate without app factory ownership. |
| EventStore / DurableEventStore ports, positions, fence errors | `@hobo/core` | package internals, runtimes | Shared internal contract substrate; not app authoring. |
| `CloudProvider` port (`Capability`, `ResourcePlan`, `CapabilityPortKind`, …) + `ActorHost` port (`ActorLease`, `ActorStateHandle`) | `@hobo/core` | provider/runtime adapters | ADR-0156: adapters may import only core, so the contracts they implement live in core; provider packages re-export for back-compat. `CapabilityPortKind` is the capability-port string — distinct from core's structural `PortKind`. |
| `createExtensionRegistry`, `parseExtensionPointId`, `parsePluginManifest`, `parsePluginPackageJson` (`hobo.plugin/v1`) | `@hobo/core` | hosts + composition roots | ADR-0156: one registration algebra (explicit duplicate policy, sealed option, id-sorted listing) and the PURE plugin-manifest parser; catalog of extension points in [extension-points.md](./extension-points.md). |
| `definePlugin`, `assertPluginExports` | `@hobo/sdk` | plugin authors | ADR-0156 authoring factory over the core manifest parser; emits the package.json `hobo` fragment. Types in core, ergonomics in the operator SDK (ADR-0087). |
| `loadHoboPlugin`, `registerPluginExtensions` | `@hobo/hobo` | operators + CLI | The effectful plugin loader at the composition root: explicit-specifier dynamic import, export verification, then the normal `registerInstallable` → `provider.Registered`/`provider.Approved` lifecycle — never a Matching bypass. |
| SQLite schema, migrations, journal semantics | `@hobo/storage-sqlite` | runtime adapters | Driver-neutral default engine logic; not the public portability boundary ([ADR-0135](./adr/03-data-plane-sqlite-default.md)). |
| generated WIT bindings | `@hobo/wit` | package internals, generated code | WIT contract materialization, not the ergonomic authoring API. |
| host event-store/runtime-journal WIT | `hobo:storage@0.1.0` via `@hobo/wit` | component hosts | Engine-neutral storage capability; no SQL/paths cross the membrane. |
| local runtime harness | `@hobo/runtime-local/testing` | tests | Local test runtime is intentionally separate from production runtime imports. |
| Node SQLite EventStore + storage worker | `@hobo/runtime-local` | Camp local runtime | Native single-owner partition adapter. |
| Browser SQLite WASM + OPFS EventStore | `@hobo/runtime-browser` | browser hosts | Worker + OPFS policy; transient fallback only when allowed. |
| Station factories, Rails, local Station client, PAM hooks, CI budget-signal bridge, traffic-routing control loop + progressive cutover saga + offering registry | `@hobo/stations` | operators + CLI | Station is control-plane isolation (ADR-0131), not Bindle/Camp/Yard topology; routing synthesis/cutover per ADR-0143. |
| Trail definitions, can-trail, recipe runner, migration executor surface, tenant-move protocol, schema-apply / dual-run port *shapes*, upgrade preflight evidence | `@hobo/trails` | app authors + platform | Continuous migration recipes ([upgrade-migration-engine](./upgrade-migration-engine.md)); engine-neutral by gate — it imports `@hobo/data-core` and never a `@hobo/data-<engine>` package at runtime (ADR-0177). Pure identity continuous needs zero Trail authoring (ADR-0134). |
| Overlay, DNS managers, secretless connectors, isolation tiers, metering sinks, TrafficRouting adapters (cloudflare · vercel · lakebed · funnel · simple) | `@hobo/connectivity` | runtimes + operators | Multi-tenant connectivity foundations (ADR-0130/0143); hierarchical naming pure functions stay in `@hobo/core`. |
| Jurisdiction catalog, region→jurisdiction map, `DataClassification`, `ResidencyConstraint`, `evaluateResidency` | `@hobo/core` | policy + gates + trails | ADR-0146 typed legal geography; fail-closed, feeds can-trail/can-migrate + the Gatekeeper `residency` gate. |
| Generic offering resolution (`matchResourceOfferings`) + per-class vocabularies (traffic-routing, data-store) | `@hobo/core` | stations + providers | ADR-0143/0144 prefer/require negotiation + portable-fallback ladder shared across resource classes. |
| Residency policy pack (`eu-data-stays-in-eu`) + control→evidence packs (`hobo.control-evidence-pack/v1`) | `@hobo/policy` | operators + governance | ADR-0146; dependency-free rules over core-computed verdicts; coverage evaluator + honest NIST 800-53 seed. |
| Convex deploy-target CloudProvider (typed impedance, cred-gated Management API) | `@hobo/provider-convex` | control plane | ADR-0144 thin SaaS adapter; see [live-provider-matrix](./live-provider-matrix.md). |
| Harness (OpenFeature provider, OpenDelivery, OpenExperiment) | `@hobo/identity` | app + platform | Progressive delivery plane; flags are facts. |
| Planner / Matching / continuous-delivery apply | `@hobo/cloud` | control plane | Provider-neutral ResourceIntent + workload-attested apply. |
| Conductor placement, receipts, rejections | `@hobo/broker` | operators + CLI | Pure runtime mounting Station client; no durable Connection ownership. |
| Component host: Wasmtime sandboxes (`componentHost=wasm`) | `@hobo/runtime-wasm` | Camp hosts | Private components as wasi:http processes. |
| Component host: OCI + kubectl transport (`componentHost=oci`) | `@hobo/runtime-oci` | Camp hosts | PACT-shaped KubectlTransport; schedule on Kubernetes. |
| Component host: multi-cloud registry (`componentHost=cloud-native`) | `@hobo/runtime-cloud-native` | Camp hosts | Mock provider for parity; cloud providers stubbed until certified. |
| MCP server (tool surface parity with CLI verbs) | `@hobo/mcp` | agents | Deny-by-default auth; same canonical verb registry as CLI. |
| Port/provider conformance suites | `@hobo/conformance` | adapters + CI | Certifies engines/providers claiming a port. |
| Property oracles, Jazzer harnesses, Schemathesis/RESTler wrappers | `@hobo/fuzz` | CI + tests | OSS-Fuzz-style control-plane invariants over simulators; never live clouds ([fuzzing.md](./fuzzing.md)). |
| PACT harness (inventory/mock/verify/subset) | `@hobo/contract-harness` | tests | Contract fixtures and verification tooling. |
| Capability implementation profiles, refinement graph, requirement parsing, hard-gate + lexicographic selection | `@hobo/capability-profiles` | cloud + providers + recipes | ADR-0151 semantic layer between Bindle primitives and products; imports no provider package. |
| Portable capability bindings, binding profiles, connectivity registry, `SecretRef` locators | `@hobo/bindings` | providers + runtimes + recipes | ADR-0151; refs only — a resolved secret value is unrepresentable in a binding record. |
| Guest leases, claim items/bundles, claim reducer, one-time action store | `@hobo/claims` | control plane + providers | ADR-0151 shared lifecycle; provider packages implement strategies, never their own reducer. |
| Trust requirements, evidence freshness/signature verification | `@hobo/trust` | cloud + recipes | ADR-0151 gates; no weighted scalar score in the production path. |
| Deployment recipes, recipe compiler, `DeploymentOffer` | `@hobo/recipes` | CLI + site + control plane | ADR-0151; recipes choose topology, Bindles keep requirements. Never mutates a Bindle. |
| Resource Definition vNext + profile-aware matching | `@hobo/cloud` | control plane | ADR-0151 extends the existing catalog/Matching; legacy definitions keep their port path and are never promoted implicitly. |
| Canonical record model, change envelope, engine SPI, migration pattern catalog + deterministic selector, custody-path policy verdict, pattern executors, engine conformance kit, reference engine | `@hobo/data-core` | engine authors + trails + control plane | ADR-0177 engine-neutral contract; imports only `@hobo/core`. Not an app-authoring surface — app authors keep `@hobo/data`. |
| SQLite engine binding (SPI over `node:sqlite`), sync dual-run + schema-apply ports | `@hobo/data-sqlite` | engine consumers + trails tests | ADR-0177 engine package; the live bindings `@hobo/trails` used to hold. Distinct from `@hobo/storage-sqlite` (the EventStore engine). |
| PostgreSQL profile helpers, conformance suite, pg_dump/pg_restore argv builders, engine binding (SPI over an injected executor; `pgoutput` change capture; native logical-copy transfer) | `@hobo/data-postgres` | app authors + providers + engine consumers | Provider-neutral; imports no provider package and no driver. |
| MongoDB `data.mongodb/v1` engine binding (SPI over an injected executor; change-stream capture) | `@hobo/data-mongodb` | engine consumers | ADR-0177 engine package; no driver dependency at runtime. |
| Redis-compatible/Valkey profile helpers + conformance | `@hobo/kv-redis-compatible` | app authors + providers | Queue/Topic semantics require separate profiles and separate conformance. |
| Signed digest-pinned implementation packs (`pack.postgres.oci`, `pack.valkey.oci`, `pack.convex.oci`) | `@hobo/pack-*` | Yards + executors | ADR-0151 `pack` realization on generic compute; ownership follows the Yard or migrate-on-claim. |
| Agent-principal discovery, registration, claim, rotation (`auth.md`) | `@hobo/auth-md` | agents + claim coordinator | ADR-0151 identity plane; an agent claim never completes an infrastructure claim. |
| Anonymous/claimable provider adapters (Neon, Prisma Postgres, Upstash, Vercel, Netlify, Cloudflare temporary accounts, ttl.sh) | `@hobo/provider-*` | control plane | Definitions + pure compilers + effectful drivers behind injected transports; register through the catalog, never a central switch. |
| Effect-aware isolation/mocks/fault injection | `@hobo/contracts` | tests | Kept in `@hobo/contracts` per ADR-0136 §5 to avoid a core→harness→contracts→core cycle. |

## Re-export Decision

`@hobo/bindles` must not re-export topology factories (`camp`, `yard`,
`junction`), operator/provider symbols (`defineResource`, `policyPack`,
`runbook`, `dispatcher`, `runner`, `generateProvider`, `chaos`), or runtime
control-flow primitives (`workflow`, `step`, runtime `agent`). It may re-export
generated WIT-facing resource and client types when those types are directly
part of app resource authoring.

This keeps import sites reviewable: app resources come from `@hobo/bindles`,
runtime behavior from `@hobo/runtime`, topology from topology packages, and
operator/provider extensions from `@hobo/sdk`. Agent interoperability uses connector
protocols such as A2A and ACP instead of a public HoBo agent SDK.

## Collision Rules

- `@hobo/sdk` must be described as "operator SDK" or "self-host SDK" in docs
  whenever the surrounding text could be read as app authoring guidance.
- `agent` is not a public SDK collection/factory. Agent-capable integrations use
  `connector(..., { protocol: "a2a" | "acp" })` so HoBo owns connection,
  identity, policy, sandboxing, and audit without maintaining an agent SDK.
- `secret` and `secretRef` intentionally share `@hobo/bindles` but mean
  different things. `secret()` declares a managed secret resource. `secretRef()`
  creates a config reference to a secret value. `@hobo/core` may hold schema
  types for both but must not become the authoring import home.

## Existing Example Reconciliation

Current design examples align to this map:

- `sdk-api.md` imports the closure builder from `@hobo/bindles`, runtime primitives from
  `@hobo/runtime`, choreography from `@hobo/events`, topology factories from
  `@hobo/camps`, `@hobo/yards`, and `@hobo/junctions`, and provider hooks from
  operator npm `@hobo/sdk`.
- `authoring-resources-wiring.md` imports `connector`, `config`, `secretRef`,
  `env`, and `fromBinding` from `@hobo/bindles`.
- `data-plane.md` and `walkthrough.md` keep CQRS helpers in `@hobo/data` and
  messaging/choreography helpers in `@hobo/events`.
- `platform-engineering.md` imports `defineResource` from operator npm
  `@hobo/sdk`.
- `walkthrough.md` keeps operator SDK examples separate from app authoring
  imports.

## Control-plane game UI (ADR-0150)

| Package | Role |
|---|---|
| `@hobo/management` | Pure Station/Connection/broker projection ops shared by CLI, MCP, control API |
| `@hobo/control-api` | Local-first HTTP + SSE adapter over management |
| `@hobo/control-yard` | Phaser Yard game UI + asset index + OpenUI generative sheets (HoBo Rubberhose) |


