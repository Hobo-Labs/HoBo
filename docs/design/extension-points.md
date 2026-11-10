---
type: Reference
title: "Extension Points"
description: "The normative catalog of every HoBo extension point: its id, owner, registration semantics, discovery path, conformance gate, and packaging rules for external plugins."
tags: [hobo, design]
---

# Extension Points

This note is the normative catalog backing [ADR-0156](./adr/07-portability-extensibility.md#adr-0156).
An **extension point** is a named, versioned seam (`hobo.<name>/v<major>`) where a
package other than the seam's owner supplies behavior. Every mechanism that lets
code plug into HoBo has a row here; a new mechanism must add a row (the
[ADR-0145](./adr/01-architecture-core.md#adr-0145) "no unnamed mechanism #10"
rule, generalized from traits to all extension surfaces). A row records who owns
the seam, how registration behaves, how implementations are discovered, and what
gates selection — so "can I plug in X, and how?" is answerable from one table.

## The SPI

Layering dictates the SPI's home: the boundary lint
(`scripts/check-package-boundaries.mts` over
`packages/conformance/src/boundaries.ts`) allows adapters (everything under
`packages/{providers,runtimes,adapters,connectors,iac,packs}/`) to import **only
`@hobo/core`**. Core therefore owns the contracts adapters implement:

| SPI piece | Where | What it is |
|---|---|---|
| `CloudProvider` port | `@hobo/core` `ports/cloud-provider.ts` | The canonical provider contract (`Capability`, `PortRequest`, `Match`, `CostSignal`, `CapabilityManifest`, `ProviderClient`, `ResourcePlan`, `IacProgramDocument`, `BuildSpec`). The capability-port string is `CapabilityPortKind` — deliberately renamed to end the collision with core's structural `PortKind` (`"runtime" | "provider" | "port"`). |
| `ActorHost` port | `@hobo/core` `ports/actor-host.ts` | The canonical virtual-actor seam (`ActorLease`, `ActorStateHandle`, `ActorLeaseHost`, `ActorHost`, `FoldEvent`, fencing error vocabulary). `@hobo/runtime`, `@hobo/data`, `@hobo/conformance`, and runtime adapters re-export or narrow this port instead of re-declaring it. |
| Extension registry primitive | `@hobo/core` `extension-registry.ts` | `createExtensionRegistry<T>(point, entries?, options)` — id-keyed entries, **explicit** duplicate policy (`"throw" | "replace"`), optional `sealed` construction (later `register()` rejected), always id-sorted deterministic listing. |
| Plugin manifest | `@hobo/core` `plugin-manifest.ts` | `hobo.plugin/v1`: the `hobo` key in a plugin package's `package.json` declaring its entry module and `{point, export}` extensions. Pure parsers `parsePluginManifest` / `parsePluginPackageJson`. |
| Plugin authoring factory | `@hobo/sdk` `plugin.ts` | `definePlugin` — typed, frozen plugin declaration for plugin authors (types in core, authoring in the operator SDK, per [ADR-0087](./adr/01-architecture-core.md#adr-0087)). |
| Plugin loader | `packages/hobo` `src/plugin-loader.ts` | The effectful half: dynamic-imports a plugin by explicit specifier, checks declared exports exist, and routes provider extensions through `registerInstallable` → `provider.Registered`/`provider.Approved`. Discovery is by explicit specifier only — never `node_modules` scanning ([ADR-0036](./adr/07-portability-extensibility.md#adr-0036) no-live-crawl posture). |

## Catalog

Legend — **Reg. semantics**: how implementations register and what duplicate ids
do. **Discovery**: how the host finds implementations. **Gate**: what stands
between "registered" and "selected".

### Provider / infrastructure seams

| Extension point | Seam owner | Reg. semantics | Discovery | Gate | Status |
|---|---|---|---|---|---|
| `hobo.cloud-provider/v1` — CloudProvider port | `@hobo/core` (port); `@hobo/cloud` catalog engine | `registerProviderFact` → `provider.Registered` event; `approveProviderFact` → `provider.Approved`; duplicate id: last fact wins in fold | static import at composition root; **`hobo.plugin/v1` manifest + loader** for external packages; `hobo add <id>` for installables (`registerInstallable`, last-wins) | approval fact (Matching ignores unapproved); capability negotiation `Capability.satisfies` | SPI landed; `@hobo/cloud`'s `RegistrableProvider` is a declared narrowing |
| `hobo.resource-resolver/v1` — direct-provider-API resolvers | `@hobo/core` `ports/resource-resolver.ts` (`ResourceResolver`, `parseResolveRequest`, `parseResolveOutcome`, `parseResolverDirectives`, `createResolverRegistry`); one resolver per product in each `packages/providers/provider-*` `src/resolvers.ts` | constructor-frozen: `createResolverRegistry(resolvers)`; duplicate `productId`: throw; id-sorted listing; a resolver's `directives` list is parsed and registered as a frozen copy ([ADR-0175](./adr/07-portability-extensibility.md#adr-0175)) | static import of a provider's `*ResolverRegistry` at the composition root; `selectIacProvider` routes plan nodes by `productId` under the opt-in `HOBO_DEPLOY_RESOLVERS=1` lane (`packages/hobo` `resolver-iac-provider.ts`, which parses `directives` again since its registry is structural) | registration contract check (ids, methods, directive names); the request and outcome parse boundaries (credential law); per-resolver fake-transport suites. No shared conformance suite and no PACT: an in-process behaviour interface, not a wire boundary | catalog row; a resolver conformance suite is not built |
| `hobo.iac-provider/v1` — IaC backend | `packages/iac/iac-pulumi` `src/port.ts` (copies in `iac-terraform`, `iac-crossplane`) | plain export consumed structurally by `@hobo/cloud` executor | static import | `runIacBackendConformance` (shared from `iac-pulumi`) | catalog row; port-type unification onto core is a recorded follow-up |
| `hobo.runtime-host/v1` — component runtime | `@hobo/core` `ports/runtime-host.ts` (`HoboRuntimeHost`, `HOBO_RUNTIME_HOST_KINDS`) | plain export; kind must be a member of the closed kinds list | static import at composition root | `@hobo/conformance` component-host suite ([ADR-0031](./adr/01-architecture-core.md#adr-0031) §5) | `rivet`/`celld` ship packages but are **not** conforming `HoboRuntimeHost`s and not in the kinds list — see Follow-ups |
| `hobo.actor-host/v1` — virtual-actor host | `@hobo/core` `ports/actor-host.ts` | host object injected into `resolveActorPlacement` (explicit > celld > rivet > dapr > native) | static import / Camp runtime requirements | **none today** — an `actor-host` conformance suite is the recorded follow-up; `evaluateActorResolver` exists but is not yet called on the placement path | canonical port landed; six local declarations re-pointed |
| `hobo.capability-profile/v1` — semantic capability profiles | `@hobo/capability-profiles` | constructor-frozen: `createCapabilityProfileRegistry(descriptors)`; duplicate id: throw; acyclic refinement validated at load | descriptors passed by host | refinement-graph validation; `conformance: "unknown"` fails closed in selection | aligned (already the best-behaved registry) |
| `hobo.pack/v1` — implementation packs | `@hobo/packs` pack-framework | no registry object; signed digest-pinned manifest (`hobo.pack-manifest/v1`) parsed → verified | Yard pack-instance actor consumes verified manifests | signature + digest verification | aligned |
| `hobo.connectivity-impl/v1` — binding connectivity implementations | `@hobo/bindings` `createConnectivityRegistry` | constructor-frozen; duplicate id: throw; id-sorted | passed by host | binding-profile match in `resolve()` | aligned |
| `hobo.station-offering/v1` — station resource-class offerings | `@hobo/stations` `createStationOfferingRegistry` | mutable `register(resourceClass, profile)`; last-wins | operator registration | `matchResourceOfferings` negotiation (`@hobo/core`) | catalog row |
| `hobo.secretless-protocol/v1` — secretless connector protocols | `@hobo/connectivity` `createPluginRegistry` | mutable `register(plugin)`; last-wins | passed/registered by host | none (protocol handshake is the behavior) | catalog row |
| `hobo.registry-bundle/v1` — offline distribution | `@hobo/registry` (`hobo.registry.bundle-manifest/v1`) | `ingestBundleManifest` → `registry.BundleImported` fact | operator-supplied bundle ([ADR-0036](./adr/07-portability-extensibility.md#adr-0036)) | SLSA provenance verification | aligned |

### Runtime / data seams

| Extension point | Seam owner | Reg. semantics | Discovery | Gate | Status |
|---|---|---|---|---|---|
| `hobo.eventstore/v1` — durable event store | `@hobo/core` `ports/eventstore.ts` (`EventStore`, `DurableEventStore`) | injected; [ADR-0135](./adr/03-data-plane-sqlite-default.md) fixes the default (`@hobo/storage-sqlite`) | Camp runtime composition | `@hobo/conformance` eventstore suite | aligned; the Rivet runtime's parallel journal schema bypasses it — see Follow-ups |
| `hobo.messaging/v1` | `@hobo/core` `ports/messaging.ts` | injected | composition | messaging conformance suite | aligned |
| `hobo.projection-sink/v1` | `@hobo/data` `src/port.ts` (`PROJECTION_PORT`) | descriptor only; no registry | n/a | replay/live equivalence ([ADR-0086](./adr/03-data-plane.md#adr-0086)) | descriptor exists, no implementer package — honest-gap row |
| `hobo.subscription-gateway/v1` | `@hobo/events` `src/port.ts` | descriptor only | n/a | — | honest-gap row |
| `hobo.training-engine/v1` | `@hobo/core` `ports/training-engine.ts` | injected | composition | eval-only ([ADR-0025](./adr/03-data-plane.md#adr-0025)) | aligned (`provider-ax`) |

### Tooling / agent seams

| Extension point | Seam owner | Reg. semantics | Discovery | Gate | Status |
|---|---|---|---|---|---|
| `hobo.conformance-suite/v1` / `hobo.conformance-adapter/v1` | `@hobo/conformance` `src/registry.ts` | mutable `register`; duplicate id: throw; suites list id-sorted | passed by host; live CLI dynamic-imports `--adapter <module>` (the one pre-existing dynamic-load seam) | the suites *are* the gate | catalog row |
| `hobo.pattern/v1` — scaffolding patterns | `@hobo/patterns` | filesystem walk from catalog root; content-digested | directory convention | `parsePatternManifest` | catalog row |
| `hobo.skill-manifest/v1` — agent skills | `@hobo/agent-skills` (`hobo.agent-skills-manifest/v1`) | frontmatter parse of `SKILL.md` | directory convention | `checkSkillsConformance` | **orphaned**: no consumer routes skill discovery through it or runs conformance — see Follow-ups |
| `hobo.connector/v1` — app-declared connectors | `@hobo/bindles` `defineConnector` (globalThis symbol registry) vs `@hobo/broker` `createConnectorRegistry` (closed `ConnectorKind` union) vs `packages/connectors/*` (ACP/vendor packages registering through neither) | three disjoint mechanisms | import side effect / config / static | `REQUIRED_SETTINGS` gate (broker only) | **divergent** — unification is a recorded follow-up, not silently resolved here |

### Deliberately closed surfaces (governance, not gaps)

| Surface | Owner | Why closed |
|---|---|---|
| Bindle resource-kind catalog (`CATALOG_ROWS`, 23 rows) + App Kit taxonomy | `@hobo/bindles`, frozen by `contracts/bindles-public-api.snapshot.json` | the authoring surface is a versioned public contract ([ADR-0072](./adr/01-architecture-core.md#adr-0072)); new kinds are an ADR-level decision |
| CLI verb registry (`CANONICAL_VERBS`) | `@hobo/cli` | MCP tool surface parity is asserted against it; an open verb set would break the deny-by-default tool contract |
| `@hobo/core` public API | `surface-guard.ts` snapshot | deliberate-breaking-change gate |

## Packaging rules for external plugins

1. **Naming**: `@hobo/provider-<name>`, `@hobo/runner-<name>`, `@hobo/runtime-<name>`, `@hobo/adapter-<name>`, `@hobo/connector-<name>`, `@hobo/pack-<name>`, `@hobo/iac-<name>`; third parties use their own scope with the same suffix convention (`@acme/hobo-provider-<name>` recommended).
2. **Layout**: `src/` + `test/` + `contracts/` (executable PACT evidence) + `data-models/` (`.proto` + `.cue`) — the same architecture-guard scaffolding first-party packages carry.
3. **Manifest**: anything loadable as a plugin declares the `hobo` key (`hobo.plugin/v1`) in `package.json`:

   ```json
   {
     "name": "@acme/hobo-provider-acme",
     "hobo": {
       "schema": "hobo.plugin/v1",
       "entry": "./dist/plugin.js",
       "extensions": [
         { "point": "hobo.cloud-provider/v1", "export": "createAcmeProvider" }
       ]
     }
   }
   ```

4. **Dependencies**: out-of-tree adapters declare `@hobo/core` as a **`peerDependency`** so the host's core instance is shared; in-tree workspace packages keep workspace deps. A hard dependency on core from a published adapter duplicates the substrate and is a packaging bug.
5. **Loading**: the operator names the plugin explicitly (config or CLI); the loader imports the declared `entry`, verifies each declared `export` exists and parses, and registers extensions through the seam's normal lifecycle (for providers: `registerInstallable` → `hobo add` → `provider.Registered`/`provider.Approved`). An unapproved provider stays invisible to Matching — plugin loading never bypasses the approval gate.
6. **Conformance**: a plugin claiming a gated extension point is selectable only after the gate (capability-profile `conformance: "pass"`, component-host suite, etc.). Terms compliance follows [ADR-0129](./adr/07-portability-extensibility.md#adr-0129).

## Follow-ups (recorded, owned, not silently fixed)

| # | Debt | Owner surface |
|---|---|---|
| F1 | Migrate mutable registries (stations, secretless, broker connectors, conformance) onto `createExtensionRegistry` so duplicate-id policy is explicit everywhere | each seam owner |
| F2 | `actor-host` conformance suite + call `evaluateActorResolver` on the placement path (ADR-0031 §5 parity) | `@hobo/conformance`, `@hobo/runtime` |
| F3 | Rivet runtime: journal onto `@hobo/storage-sqlite` schema v2 (or implement `DurableEventStore`), durable `state()` path, per-key fence epochs; celld: ship an `ActorHost` or remove the selectable placement mode | `@hobo/runtime-rivet`, `@hobo/runtime-celld` |
| F4 | Unify the three connector mechanisms behind one extension point | `@hobo/bindles`, `@hobo/broker`, `packages/connectors` |
| F5 | Route skill discovery through `@hobo/agent-skills`; one slug rule; one `llms.txt` producer (`packages/cli` agent-docs is the drift-gated one) | `@hobo/cli`, `@hobo/agent-skills` |
| F7 | Lift the `IacProvider` port type from `iac-pulumi` (and its two copies) onto core alongside `CloudProvider` | `packages/iac/*`, `@hobo/core` |
| F8 | Reconcile `SecretCustodyPort`/`SecretResolverPort` (seven verbatim copies) into a core port | `@hobo/core`, provider packages |
| F9 | `sdk-api.md` names runtime backends (`runtime-postgres`, `runtime-temporal`, `runtime-restate`, `runtime-cloudflare`) that do not exist; `architecture.md` lists `runtime-cloudflare` — correct the docs to the shipped set | design suite |

Related: [package-namespaces.md](./package-namespaces.md) (import ownership),
[live-provider-matrix.md](./live-provider-matrix.md) (honest provider readiness),
[ADR-0062](./adr/07-portability-extensibility.md#adr-0062) (registry
distribution/trust), [ADR-0144](./adr/07-portability-extensibility.md#adr-0144)
(external-spec posture), [ADR-0145](./adr/01-architecture-core.md#adr-0145)
(traits).
