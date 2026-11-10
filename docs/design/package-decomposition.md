---
type: Reference
title: "Package Decomposition"
description: "Target package topology: manifest kinds as independently maintained contracts, broker/resolver separation, provider families, station core plus CLI, and one local composition root."
tags: [hobo, design, architecture]
---

# Package Decomposition

This note is the target topology for splitting HoBo's larger packages into
independently maintained, independently testable units. It extends the
import-ownership map in [package-namespaces.md](./package-namespaces.md)
(ADR-0087) rather than replacing it: that note says *who may import what*, this
one says *what the units are*.

**Most of what follows already exists.** The problem is not missing concepts,
it is that three distinct manifest kinds are spelled three different ways in
four packages, that resolution is spread across four more, and that one
`packages/providers/*` directory holds five unrelated provider families. The
work is separation and naming, not invention. Where something genuinely does
not exist yet, this note says so.

## 1. The three manifest kinds

The core claim: **a request manifest and a declaration manifest are different
documents with different authors, different lifecycles, and different
compatibility rules, and a capability manifest is the vocabulary that lets
them be matched without either side naming the other.**

| Kind | Answers | Authored by | Today |
|---|---|---|---|
| **Capability** | "What does `data.postgres/v1` *mean*, and what refines it?" | the platform, versioned as a catalog | `STANDARD_CAPABILITY_PROFILES` in `@hobo/capability-profiles` — a TS constant, not a document |
| **Request** | "What does this app need?" | app authors, via a builder | `CapabilityRequirement` (`@hobo/capability-profiles`), Bindle `requirements` (`@hobo/bindles`), `ResourceIntent` (`@hobo/cloud`) — three shapes |
| **Declaration** | "What does this product offer, and on what evidence?" | provider authors | `SelectionCandidate` (`@hobo/capability-profiles`), provider `manifest.ts`, Resource Definitions (`@hobo/cloud`), `CapabilityManifest` codec (`@hobo/core`) — four shapes |

### Why the capability manifest has to exist

It is tempting to treat capability as a bare string shared by both sides. It
cannot be, for a reason already visible in the code: `selectCapabilityImplementation`
must accept a `data.sqlite/v1` product for a `data.relational/v1` request and
refuse it for a `data.postgres/v1` request. That is a **refinement graph**, and a
graph is a document someone owns and versions. Without it, a request would have
to enumerate acceptable products — which is exactly the provider coupling the
Bindle-first rule (ADR-0144) exists to prevent.

So the capability catalog is promoted from a constant to a maintained artifact
with its own compatibility rules: adding a profile is additive, adding a
refinement edge widens what existing requests accept (and so needs a review
gate), removing either is breaking.

### Compatibility rules differ per kind, which is the argument for splitting them

- A **request** may be widened by its author freely and narrowed only with a
  version bump — narrowing can make a previously-satisfiable app unsatisfiable.
- A **declaration** is the reverse: widening claims requires fresh conformance
  evidence, narrowing is always safe.
- A **capability** is append-mostly and gated, as above.

One package cannot enforce three different rules over one schema. Three
packages can, and each gets its own conformance suite.

## 2. Schema language: WIT for calls, protobuf + CUE for documents

The brief asked for manifests defined "primarily in WIT where possible". Taken
literally that does not work, and the reason is worth stating rather than
quietly working around.

**WIT describes a component's imports and exports.** It has no canonical
serialization, no document identity, no constraint language, and no notion of
schema evolution for a stored artifact. A manifest is a *document* that is
written to disk, signed, digested, published, and read years later by a
resolver nobody has met. `AGENTS.md` already mandates protobuf plus CUE for
records/messages/data/objects, and the repo already follows it — `packages/cloud/src/plan-types.ts`
carries `// domain-view: … wire form is ResourcePlan in data-models/cloud.proto`.

The split that actually delivers language independence:

| Layer | Language | Why |
|---|---|---|
| Manifest **documents** (request / declaration / capability) | **protobuf** wire + **CUE** constraints | canonical bytes for digesting and signing; constraints that a generator cannot silently drop |
| Builder **ABI** — "produce a request manifest" | **WIT** world | lets a builder in any language be a component |
| Resolver **ABI** — "given a request, return a plan" | **WIT** world | lets a resolver in any language be a component |
| Broker **ABI** — "register a resolver, resolve a request" | **WIT** world | the extension seam |

This is "primarily WIT where possible" honestly applied: WIT owns every
*interface* across the language boundary, protobuf plus CUE own every
*document* that crosses it. A Python builder and a Rust resolver interoperate
because both speak the same three proto schemas and the same three WIT worlds.

`packages/wit` already holds `hobo:sdk@0.1.0` — the WIT contract, which is a
different thing from the npm package `@hobo/sdk` (the operator/self-host SDK)
and is not renamed or widened by anything here. That world is the **runtime**
membrane (workflow, actor, queue, scheduler). The builder/resolver/broker worlds
are new and belong beside it, not inside it — a builder is not a runtime import.

## 3. Two resolution standards, not one

The brief asks for both, and they are genuinely different:

**Request → plan (brokered).** The broker holds a registry of resolvers, matches
a `ResourceRequestManifest` against the `ResourceDeclarationManifest`s each
resolver can offer, applies gates (trust, residency, policy, budget) and a
deterministic ranking, and emits a plan plus a rejection record for every
candidate that lost. This is discovery: the request never names a product.

**Declaration → plan (direct).** An operator who has already chosen a product
hands its declaration straight to the resolver that owns it and gets a plan.
No matching, no ranking — but the *same* gates, or the direct path becomes a
way to bypass residency and trust. That shared gate stage is the reason these
are two entry points into one pipeline rather than two pipelines.

```
                  capability manifests (vocabulary)
                            |
request manifest ---> [ match ] ---> candidates ---.
                                                    >--- [ gates ] --- [ rank ] --- plan
declaration manifest --------------------------------'
```

The gates and the plan type are shared; only the front half differs. Today the
matching half lives in `@hobo/capability-profiles`, the gates are split between
`@hobo/trust`, `@hobo/core` (`evaluateResidency`), and `@hobo/policy`, the
ranking is in `@hobo/capability-profiles` and `@hobo/dispatcher`, and the plan
is `@hobo/cloud`. Nothing needs rewriting — it needs assembling behind one
named seam.

## 4. Target topology

### Manifest contracts — one package per kind

| Package | Owns |
|---|---|
| `@hobo/manifest-capability` | capability profile catalog, refinement graph, profile ids, conformance suite refs |
| `@hobo/manifest-request` | request schema, parse/validate, widening + narrowing rules |
| `@hobo/manifest-declaration` | declaration schema, parse/validate, evidence + claim fields |
| `@hobo/manifest-plan` | the deployment plan both paths produce |

Each ships `.proto` + `.cue` + generated bindings and imports **no** other HoBo
package except its own generated code. That is what makes them independently
maintainable and separately publishable.

### Core — the wasm-distributable substrate

`@hobo/manifest-core` composes the four manifest packages plus the WIT worlds
and the pure matching/gating functions. **This is the package the brief calls
"a core package that combines all this that is wit/wasm distributable."**

Honest caveat: today `packages/componentize` produces a *synthetic*
contract-shaped artifact for the default lane, with a real
`@bytecodealliance/componentize-js` path behind a toolchain check. So
"wasm-distributable" is a real target with a real fallback, not a shipped fact,
and this note should not be read as claiming otherwise.

### Resolution

| Package | Owns |
|---|---|
| `@hobo/broker` | resolver registry, request→candidate matching, gate pipeline, ranking, rejection records |
| `@hobo/resolvers` | the resolver ABI, the direct declaration→plan path, and the shared resolver test kit |

`@hobo/broker` keeps its name and narrows its job. Its current placement /
receipts / metering concerns move to `@hobo/broker-placement` so the resolution
standard is reviewable on its own.

### Providers — one family per directory, one package per provider

`packages/providers/*` is 26 packages in five unrelated families. Splitting the
glob costs a `pnpm-workspace.yaml` edit and a boundary-lint update:

| Family | Members |
|---|---|
| `providers/cloud/*` | aws, azure, gcp, cloudflare, vercel, netlify, railway, neon, prisma-postgres, upstash, convex, lakebed, ttl-sh |
| `providers/ci/*` | runner-blacksmith, runner-depot, runner-github |
| `providers/ai/*` | agentv (live-eval grader), ax (training engine) |
| `providers/policy/*` | cedar, opa |
| `providers/infra/*` | kubernetes, kafka, webernetes, browser-wasm, flux, config |

The brief named cloud, CI, and AI. Policy and infra are named here because the
remaining eight packages need a home — leaving them in a flat directory would
reproduce the problem for the majority of the set.

### Stations

| Package | Owns |
|---|---|
| `@hobo/stations` | station core: rails, offering registry, PAM, traffic-routing control loop (library only) |
| `@hobo/station-cli` | `hobo-station` binary over station core |
| `@hobo/station-local` | **the special boundary**: host probing, runtime discovery, dynamic capability registration |

`@hobo/station-local` earns its own package precisely because it is the one
place allowed to learn capabilities *at runtime from its host* rather than from
a declaration manifest. Every other package treats the capability set as data
that arrived from somewhere; this one manufactures it. Keeping that in a package
whose boundary lint forbids importing it from anywhere but a composition root is
how that privilege stays auditable — it is the same reasoning ADR-0146 uses to
keep residency evaluation fail-closed in one place.

### Composition root and consumers

The brief asks for "a core sdk that combines all the other packages necessary to
run locally." **`@hobo/sdk` is not that name** — ADR-0087 already defines it as
the operator/self-host SDK (`defineResource`, `policyPack`, `runbook`), and
redefining it would break a documented boundary and every import site. (Neither
is it `hobo:sdk`, which is the WIT contract named above.)

The thing being described already half-exists as `@hobo/hobo`, which is both the
composition root *and* the CLI binary. Split it:

| Package | Owns |
|---|---|
| `@hobo/host` | composition root **library**: wires manifests, broker, resolvers, station-local, runtimes into a runnable local stack |
| `@hobo/hobo` | the `hobo` CLI binary, over `@hobo/host` |
| `@hobo/station-cli`, `@hobo/rift`, `@hobo/stage-gate`, `@hobo/conformance` | the other binaries, over `@hobo/host` or the core packages directly |
| `@hobo/control-yard`, `@hobo/status-page`, `site` | web apps, over `@hobo/host` or core packages directly |

That gives the brief's outcome — every CLI and web app on one composition
library — without a name collision.

## 5. What this buys, stated as testable claims

- A manifest schema change fails **one** package's conformance suite rather than
  surfacing as a type error in eleven.
- A provider family can be versioned and released without rebuilding the other
  four.
- A resolver written in another language is a component against a WIT world, not
  a port of the TypeScript.
- `@hobo/station-local`'s runtime-discovery privilege is enforced by boundary
  lint instead of by convention.

## 6. What this costs

- Roughly 60 packages gain or change a dependency edge; the boundary gate
  (repaired in #1115) is what makes that survivable, and it should be run at
  every stage.
- The gate distinguishes **runtime** edges from **dev-only** ones. An edge that
  exists solely through `devDependencies` carries `dev: true`, and the layering
  rules key on it: a package importing `@hobo/contract-harness` in its own test
  suite is not reaching across a boundary at runtime. Only that one package is
  exempt, and only when the edge is dev-only — a runtime dependency on the test
  harness still fails. Before this, each such test edge had to be blessed by
  name, and the allowlist was growing entries that all shared one reason.
- The banked-edge list is a ratchet, not architecture, and it went from 31
  entries to 14 once the redundant ones were removed: seventeen named a target
  that the gate already classifies as a `contract` package, which the adapter
  rule exempts outright. A provider importing `@hobo/capability-profiles` or
  `@hobo/bindings` declares the vocabulary it implements — that was never debt.
  What remains is the real remainder, and every entry carries a written reason.
- Four new manifest packages plus generated bindings is more build surface, and
  the proto/CUE codegen lane becomes load-bearing rather than advisory.
- `@hobo/hobo` splitting into `@hobo/host` + CLI touches every composition site.

## Migration

Staged in [docs/plans/package-decomposition/plan.md](../plans/package-decomposition/plan.md).
Every stage is independently shippable and gate-green; no stage requires the
next one to land.
