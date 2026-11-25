---
type: Reference
title: "Lineage — the aggregate portrait and credits"
description: "The canonical map of everything HoBo borrows from, is inspired by, or is measured against — one row per influence with posture, what is taken, where HoBo diverges, and the capture link."
tags: [hobo, design]
---

# Lineage — the aggregate portrait and credits

HoBo is deliberately an **aggregate**: a composition of ideas proven elsewhere,
recombined behind provider-agnostic ports on an event-sourced control plane.
This page is the single credits surface — every influence, its posture, what
HoBo takes, and where HoBo diverges. It aggregates
[vision.md's "What HoBo borrows"](./vision.md#plan-17) and
"Intent lineage (five pillars)" (which remain canonical for *founding intent*),
the per-capture borrow sections across
[`../competitors/`](../competitors/index.md),
[`../technologies/`](../technologies/index.md),
[`../patterns/`](../patterns/index.md), and
[`../standards/`](../standards/index.md), and the posture ADRs.

Lineage records *what HoBo takes and why*. The competitive corpus records *who else
is in each category and how HoBo is positioned against them*: browse it by category
via [`../competitors/categories/`](../competitors/categories/index.md), or as one
generated table in the [cross-category matrix](../competitors/matrix.md). A competitor
may appear in several categories but always has exactly one canonical capture — the
rules are normative in
[`../competitors/metadata-contract.md`](../competitors/metadata-contract.md).

**Posture legend** — *pillar*: founding intent (vision.md five pillars) ·
*adopted*: shipped as a dependency/substrate · *borrow-source*: idea taken,
implementation ours · *analog*: measured against, honestly diverged ·
*lesson*: only the lesson taken · *provider-target*: realized behind a port ·
*standard*: spoken at the boundary · *informs*: shaped thinking without a
borrowed mechanism · *head-on*: competitor measured and displaced. Compounds
(e.g. *adopted substrate/adapter/discipline*) qualify the base posture.
Governing rule for all of it:
**"inspired by / maps to — never depends on"**
([ADR-0144](./adr/07-portability-extensibility.md#adr-0144)); standards are
spoken at the boundary, never absorbed
([ADR-0046](./adr/02-identity-security.md#adr-0046),
[`../standards/`](../standards/index.md)).

## One-paragraph portrait

An informal but accurate composition sketch: **the developer/platform seam of
Radius and Humanitec, on the wasm substrate of wasmCloud, with the app-centric
soul of Cloud Foundry and Heroku, realized through Crossplane-style
reconciliation and IaC adapters; Dapr's building-block goals and the service
mesh's platform-owned guarantees relocated into a WIT membrane; Nitric's
IfC + `.allow()`, Aspire's wiring, Wasp's kit instinct, CNAB's packaging
lessons; Nomad's scheduling pillar; DSPy/Trace-informed agent training;
OPA/Cedar-adjacent policy with FinOps as a first-class input; PACT-enforced
boundaries; and Argo/Flux/Octopus-informed delivery — all replayable, because
the control plane is an event journal.**

## The influence map

### Application model & platform seam

| Influence | Posture | What HoBo takes | Where it diverges | Capture |
|---|---|---|---|---|
| **Humanitec** | pillar-adjacent borrow-source | Resource Definitions + Matching, Driver taxonomy, Deployment Sets/Deltas, env types, 5-plane IDP framing | auditable `match.Decided`, wasm-first, event-sourced, OSS core | [competitors/humanitec](../competitors/humanitec.md#primitive-mapping) |
| **Radius** | borrow-source | Recipes→definitions seam, Connections, Application Graph, recipe output contract | dynamic scored Matching vs static env binding | [competitors/radius](../competitors/radius.md#primitive-mapping) |
| **Crossplane** | borrow-source + adapter | reconciliation model, dev/platform separation, XRD/Composition≈definition schema/realization (ADR-0144) | not K8s-bound; Crossplane is also a pluggable IaC adapter (ADR-0006) | [competitors/crossplane](../competitors/crossplane.md#primitive-mapping) |
| **Cloud Foundry / PCF** | lesson + lineage | the original `cf push` app-centric contract, buildpack-style DX floor, org/space governance instinct | no opinionated monolithic platform; ports + matching instead | [technologies/cloud-foundry-pcf](../technologies/cloud-foundry-pcf.md) |
| **Heroku** | lesson + lineage | app-centric PaaS ergonomics, add-on marketplace shape | provider-negotiated, self-hostable | [competitors/heroku](../competitors/heroku.md#primitive-mapping) |
| **OAM / KubeVela** | standard (vocabulary) | Application/Component/**Trait**/Scope role separation (ADR-0144/0145); wadm render target (ADR-0108) | executable TS IR, scored matching, never OAM-as-model | [standards/oam](../standards/oam.md) |
| **Nitric** | pillar (P3) | resource catalog, `.allow()` least privilege, IfC default authoring | wasm membrane, event-sourced plane | [competitors/nitric](../competitors/nitric.md#primitive-mapping) |
| **.NET Aspire** | pillar (P2) | `WithReference` wiring, annotations, manifest IR, local orchestration DX | polyglot via WIT, provider-negotiated deploy | [competitors/aspire](../competitors/aspire.md#primitive-mapping) |
| **Wasp / Open-SaaS** | lesson + packaging path | declarative app-spec instinct, opinionated App Kits; `@hobo/wasp` `waspApp` → `b.web(...)` + OCI/external deps | no dual authoring; kits as Resource/App Packs planned via Distribution (ADR-0145 §2); never HoBo-owned OpenSaaS images | [competitors/wasp](../competitors/wasp.md#primitive-mapping) |
| **SST / Encore / Winglang** | analogs | IfC validation; typed linking; preflight/inflight cautionary tale | — | [sst](../competitors/sst.md#primitive-mapping) · [encore](../competitors/encore.md#primitive-mapping) · [winglang](../competitors/winglang.md#primitive-mapping) |

### Runtime & distributed substrate

| Influence | Posture | What HoBo takes | Where it diverges | Capture |
|---|---|---|---|---|
| **wasmCloud** | adopted substrate | lattice default (ADR-0031), capability providers, wRPC links, wadm | HoBo owns the model; wasmCloud is a host | [competitors/wasmcloud](../competitors/wasmcloud.md#primitive-mapping) |
| **WASI / Component Model** | standard | ports as WIT interfaces, components as the deployable unit | — | [design/wasm-runtime-wit](./wasm-runtime-wit.md#plan-20) |
| **Dapr** | analog (closest architectural) | building-block APIs over swappable components — the *goal* | membrane (typed links) instead of a sidecar; Dapr also a runtime adapter | [competitors/dapr](../competitors/dapr.md#primitive-mapping) |
| **Istio / Linkerd / Envoy (service mesh)** | lesson | platform-owned identity/mTLS, traffic policy, resilience, telemetry | interpose on WIT links, not packets; mesh = optional adapter, never core (ADR-0143) | [patterns/service-mesh](../patterns/service-mesh.md) |
| **Nomad** | pillar (P1, pivoted) | heterogeneous scheduling, placement, federation intent | realized via wasmCloud lattice + Junction⊃Yard⊃Camp (ADR-0031/0106) | [competitors/nomad](../competitors/nomad.md#primitive-mapping) |
| **Temporal** | analog | durable execution benchmark; history-replay mechanism generalized platform-wide | in-process over the journal; replay-gate not SDK sandbox | [technologies/temporal](../technologies/temporal.md) |
| **Vercel Workflows** | borrow-source | the durable `workflow`/`step` authoring feel | — | [competitors/vercel](../competitors/vercel.md#primitive-mapping) |
| **Tailscale / WireGuard** | adopted adapter | identity-keyed overlay, Funnel exposure, zero-config expectation (ADR-0122/0143) | overlay behind the `mesh` port; Headscale/Netbird for sovereign Yards | [technologies/tailscale](../technologies/tailscale.md) |
| **Convex / Lakebed / Supabase** | head-on + provider-targets | reactive DX corroboration; agent-native contracts (`llms.txt`) | also realizable as providers (thin-adapter rule, ADR-0144 §5) | [convex](../competitors/convex.md#primitive-mapping) · [lakebed](../competitors/lakebed.md#primitive-mapping) · [supabase](../competitors/supabase.md#primitive-mapping) |

### Packaging, contracts & policy

| Influence | Posture | What HoBo takes | Where it diverges | Capture |
|---|---|---|---|---|
| **CNAB** | lesson | signed multi-artifact bundles, credential declarations, lifecycle-over-tooling | Registry listings + offline bundles (ADR-0036/0062); Bindle naming collision noted | [standards/cnab](../standards/cnab.md) |
| **PACT** | adopted discipline | consumer-driven contracts at every boundary (repo-gated) | contracts feed can-deploy/Gatekeeper, event-sourced | [technologies/pact](../technologies/pact.md) |
| **OPA / Rego** | provider-target | policy-as-code engine posture | typed TS policy default; OPA optional behind `policy-engine` (ADR-0015) | [technologies/opa-rego](../technologies/opa-rego.md) |
| **Cedar** | provider-target | deny-overrides composition; narrow-typed-policy auditability | event-sourced `policy.Decided`, Gatekeeper composition | [technologies/cedar](../technologies/cedar.md) |
| **FinOps (FOCUS / OpenCost)** | pillar (P4) + standard | cost as first-class input; FOCUS billing shapes; cost-aware placement (ADR-0071) | Pareto/stability control plane, credits routing | [standards/focus-opencost](../standards/focus-opencost.md) · [competitors/finops-tooling](../competitors/finops-tooling.md#the-cross-product-reading) |
| **Pulumi** | adopted adapter | real-language IaC via Automation API | one of several IaC adapters, none primary | [design/control-plane](./control-plane.md#plan-04) |

### Delivery & operations

| Influence | Posture | What HoBo takes | Where it diverges | Capture |
|---|---|---|---|---|
| **Argo CD** | lesson + render target | immutable desired-state under review; gated ordered sync; drift surfacing | journal authoritative, Git a projection (publisher mode); `broker_delivery_argocd` renders Applications | [technologies/argo-cd](../technologies/argo-cd.md) |
| **Flux CD** | lesson | OCI artifacts as signed delivery channel; controller-toolkit decomposition | reconcile from journal, not Git | [technologies/flux-cd](../technologies/flux-cd.md) |
| **Octopus Deploy** | lesson | the delivery domain model as first-class nouns: environments, lifecycles, tenants, runbooks, approvals | promotion as policy-gated events; runbooks agent-first | [competitors/octopus-deploy](../competitors/octopus-deploy.md#primitive-mapping) |
| **OpenGitOps / CDEvents / Serverless Workflow / OpenSLO / CloudEvents / OTel / OCSF / OpenFeature** | standards | spoken at the boundary | never absorbed (ADR-0046) | [standards index](../standards/index.md) |
| **OSCAL** | standard | control→evidence vocabulary for compliance packs | boundary export only, no schema dependency (ADR-0146) | [standards/oscal](../standards/oscal.md) |
| **CUE** | adopted discipline | data-model constraint language beside protobuf | constraints only, never a runtime dependency | [technologies index](../technologies/index.md) |
| **OpenStack** | analog | self-host control-plane precedent | event-sourced control plane instead of service sprawl | [technologies index](../technologies/index.md) |
| **Varlock** | informs | env/secret hygiene tooling | secretless bindings + broker-minted credentials instead | [technologies index](../technologies/index.md) |
| **StackStorm / Prometheus AlertManager / HolmesGPT** | informs | event-driven runbooks; alert routing; AI SRE investigation | Crew agents as principals | [technologies index](../technologies/index.md) |

### Agent & AI training

| Influence | Posture | What HoBo takes | Where it diverges | Capture |
|---|---|---|---|---|
| **Microsoft Trace** | informs | trace-and-optimize agent workflows → `training-engine` port (ADR-0025) | behind a port, offline-capable | [technologies/microsoft-trace](../technologies/microsoft-trace.md) |
| **DSPy** | informs | programming-not-prompting; compiled/optimized pipelines | — | [technologies/dspy](../technologies/dspy.md) |
| **Agent Lightning / agentV** | informs | decoupled agent RL/eval over stored traces | — | [agent-lightning](../technologies/agent-lightning.md) · [agentv](../technologies/agentv.md) |
| **SPIFFE / OAuth / MCP-auth** | standards | keyless workload identity, token brokering, agents-as-principals (P5) | — | [design/ai-native-agent-auth](./ai-native-agent-auth.md#plan-06) |

## Reconciling the framings

The founding pillar statement stays **"Nomad + Aspire + Nitric + FinOps +
agent-native"** ([vision.md](./vision.md#plan-17)); the broader composition
above is the *full* credits surface. A commonly used informal shorthand —
"Radius + wasmCloud + PCF + Crossplane + Humanitec; Dapr + Istio; CNAB +
Nitric + Wasp; Trace/DSPy; OPA/Rego + FinOps; PACT + Argo/Flux/Octopus" — is
accurate as a cluster sketch and maps onto the tables above; where it names a
*lesson* or *analog* (Istio, CNAB, Octopus, Dapr), the posture column keeps
the claim honest. Captures record their borrows in a clearly labelled borrow
paragraph or section (exact heading form varies across the corpus).

## Maintenance

- New influences get a capture in the right tree (competitor / technology /
  pattern / standard) **and** a row here; borrow sections in captures should
  use the heading form "What HoBo borrows from X" (credit-style, per
  [aspire.md](../competitors/aspire.md)).
- Scoring lives elsewhere: [`gap-analysis.md`](../competitors/gap-analysis.md)
  §6 re-scores every capture (refreshed 2026-08-04, all 35 rows); this page
  tracks *credits*, not scoring.
