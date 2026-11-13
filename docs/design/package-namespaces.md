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
| `defineResource`, `dispatcher`, `runner`, `runbook`, `generateProvider` | `@hobo/sdk` | provider authors and self-host operators | Provider/runtime implementation hooks are not app authoring factories. `dispatcher()` here is the operator **authoring factory** over the `@hobo/dispatcher` engine. |
| Dispatch decision engine (`dispatch.Decided`/`dispatch.Reservation*`, registry, reservation ledger, replay) | `@hobo/dispatcher` | control plane + stations + broker | ADR-0071 credit/budget-aware deterministic selection — a pure function of (registry, `CreditLedgerView@seq`, request); promoted from the maximize-credits proof. |
| CI allocation routing, portable pipelines, durable reservations | `@hobo/ci` | CI relay operators + backend authors | Reuses `@hobo/dispatcher`; Worker-safe execution contract is `@hobo/ci/execution`, Node ledger and scheduler are explicit subpaths. |
| Actions relay and bound command execution; Azure Pipelines self-hosted config; Dagger and Cloudflare CI executors | `@hobo/ci-gh-actions`, `@hobo/ci-ado`, `@hobo/ci-dagger`, `@hobo/ci-cf` | CI integrations + tests | Interchangeable implementations of the portable CI execution contract; GitHub workflow routing uses the Actions relay, one core in `@hobo/ci-gh-actions` whose hosts (its own Node service, `@hobo/ci-vercel`, the box worker daemon) add only a store, a scheduler and runner backends. |
| Optional relay agent: deterministic merge-queue planning and model-backed conflict resolution (`createCiAgent`, `createRelayAgent`, `parseAgentConfig`) | `@hobo/ci-agent` | CI relay operators | Off unless `.hobo/ci.json` has an `agent` block; `hobo ci serve` then starts it beside the Node relay, and it also runs as a process of its own beside the box worker or a relay on Vercel. Composes the relay as a second worker; `@hobo/ci-gh-actions` only schedules it and does not depend on it. Models via the Vercel AI SDK; never merges, and publishes only to the pull request branch or a `hobo-agent/` branch. Recorded resolutions and an optional structured merge (mergiraf) come before any model. |
| Continuous delivery: Freight, sources and ingest, artifacts and provenance, Sets/Deltas, pipelines and windows, promotion, reconcilers and the delivery feed, verification, rollout, inventory, Placement, fan-out, failover, posture, authorization, telemetry, composition (one subpath each) | `@hobo/cd` | Station/Yard operators, `@hobo/hobo` composition root, agents (`hobo deploy agent run`) | Layer-3 sibling of `@hobo/ci` ([ADR-0182](./adr/01-architecture-core.md#adr-0182)). Composes Matching (`@hobo/cloud`), Gatekeeper (`@hobo/contracts`), `OpenDeliveryEngine` and SVIDs (`@hobo/identity`), provenance parsing (`@hobo/registry`) and Rails (`@hobo/stations`); imports no provider, IaC, runtime, CI, broker or CLI package (I11). Design: [continuous-delivery.md](./continuous-delivery.md). |
| GitOps publisher (Argo CD `Application`, Flux `Kustomization` committed through a Git host HTTP API) | `@hobo/cd-gitops` | CD operators | A `publisher`-mode realizer: convergence is known only from the engine's observed status. Replaces the broker's deprecated `argo` engine and `destination_namespace` (D14). |
| Kubernetes fleet transport and inventory (ClusterProfile import, OCM ManifestWork realizer, Karmada single-member realizer) | `@hobo/cd-kube-fleet` | operators with an existing Kubernetes fleet | Transport and inventory only (D26): never ManifestWorkReplicaSet, OCM Placement, or the Karmada scheduler, failover or overrides. Speaks the Kubernetes API over `HttpTransport` with no client library. |
| npm package-version realizer (`npmResolverRegistry`, npmjs / GitHub Packages / Verdaccio) | `@hobo/provider-npm` | CD operators, via the `@hobo/hobo` hosting catalog | HoBo.CD realizer (plan 0024 D6/I14) on the core `ResourceResolver` port; versions are immutable, promotion is a dist-tag move. See [live-provider-matrix](./live-provider-matrix.md). |
| OCI distribution registry realizer (`ociRegistryResolverRegistry`: GHCR, Docker Hub, ECR, Artifact Registry, Harbor, Zot) | `@hobo/provider-oci-registry` | CD operators, via the `@hobo/hobo` hosting catalog | HoBo.CD realizer (D6/I14); mirrors keep digests (D22), no SDK. See [live-provider-matrix](./live-provider-matrix.md). |
| GitHub Pages site realizer (`githubResolverRegistry`) | `@hobo/provider-github` | CD operators, via the `@hobo/hobo` hosting catalog | HoBo.CD realizer (D6/I14) over the GitHub REST API; not the CI runner (`@hobo/runner-github`). See [live-provider-matrix](./live-provider-matrix.md). |
| Out-of-tree `hobo:resolver@0.1.0` WASM resolver components | `@hobo/resolver-components` | resolver authors + Yard operators | Plugs signed components into the existing `ResourceResolver` seam (D6); host-mediated `wasi:http` under a declared allowlist, host-side credential injection, fuel/memory/time limits. Authoring guide: [resolver-component-authoring.md](./resolver-component-authoring.md). |
| Multi-node fenced EventStore on PostgreSQL 16+ | `@hobo/storage-postgres` | runtime adapters, `hobo serve cd` with more than one replica | Same `DurableEventStore` port and conformance suite as `@hobo/storage-sqlite` (D16). SQLite stays the default ([ADR-0135](./adr/03-data-plane-sqlite-default.md)). |
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
| Data-store catalog records (`parseDataStoreCatalogEntry`, `dataStoreProfileOf`) + self-host matcher (`assessSelfHostedDataStore`) | `@hobo/core` | stations + providers | Evidence-carrying provider profiles and a declaration-derived self-host verdict; see [`postgres-backend-catalog.md`](./postgres-backend-catalog.md). |
| PostgreSQL backend catalog (`POSTGRES_BACKEND_CATALOG`) + self-host read model (`selfHostedPostgresHosts`) | `@hobo/cloud-providers` | operators + policy | Cited vendor claims, dated; a leaf package so a refresh does not rebuild `@hobo/core` dependents. |
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
| Provider-text redaction (shared credential shapes, detectors, `createProviderRedactor`, `KEPT_LOCATOR`) | `@hobo/provider-redaction` | providers + packs + guards | Leaf: imports no HoBo package. Kept out of `@hobo/core` so a shape change runs the suites that redact ([provider-redaction.md](./provider-redaction.md)). |
| Linear-time and redaction test harness (`/linear-time`, `/linear-sweep`, `/redaction-differential`) | `@hobo/redaction-test-harness` | tests only (devDependency) | Leaf with no dependencies, apart from `@hobo/contract-harness` so a change to it plans only the suites that redact ([provider-redaction.md](./provider-redaction.md)). |
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


