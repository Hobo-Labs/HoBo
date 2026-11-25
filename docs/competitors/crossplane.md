---
type: Competitive Reference
title: "Crossplane — competitor reference"
description: "Crossplane is an **open-source, CNCF-graduated control-plane framework** (Apache-2.0) for **platform engineering** — it extends **Kubernetes** with custom resources and controllers so platform teams provision and **continuously reconc"
tags: [hobo, competitors]
competitor:
  slug: crossplane
  name: "Crossplane"
  primary_category: portable-application-models
  categories: [portable-application-models, platform-orchestrators, hybrid-multicloud-enterprise]
  directness: overlapping
  role: "CNCF Kubernetes control plane for infrastructure — borrow-source and pluggable IaC adapter"
  posture: [borrow, integrate]
  hobo_surface: [typed-contracts, provider-matching, reconciliation, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://docs.crossplane.io/
    - https://github.com/crossplane/crossplane
---

# Crossplane — competitor reference

> A faithful capture of **Crossplane** for HoBo competitive analysis. Crossplane is **not a head-on competitor** — it is a **borrow-source** and a **pluggable IaC adapter option** for HoBo. HoBo already borrows Crossplane's **reconciliation model + dev-vs-platform separation** ([vision.md](../design/vision.md), "What HoBo borrows"), and Crossplane is a first-party `IacProvider` adapter — the one used when a Camp's substrate is Kubernetes ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)). Crossplane is a **Kubernetes-based control plane for infrastructure** (v2 also applications): providers + managed resources, Compositions/XRDs, Composite Resources/Claims, composition functions, all driven by a continuous reconciler. Sources: [crossplane.io](https://www.crossplane.io/) · [docs.crossplane.io](https://docs.crossplane.io/) · [github.com/crossplane/crossplane](https://github.com/crossplane/crossplane) · [blog.crossplane.io (v2)](https://blog.crossplane.io/announcing-crossplane-2-0/) · [github.com/crossplane/upjet](https://github.com/crossplane/upjet) · [upbound.io](https://www.upbound.io/) · [marketplace.upbound.io](https://marketplace.upbound.io/) · [CNCF graduation](https://www.cncf.io/announcements/2025/11/06/cloud-native-computing-foundation-announces-graduation-of-crossplane/). License **Apache-2.0** (Crossplane + official providers OSS/CNCF; Upbound UXP/Spaces/Marketplace commercial). Researched July 2026; API/CRD/YAML shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Crossplane is an **open-source, CNCF-graduated control-plane framework** (Apache-2.0) for **platform engineering** — it extends **Kubernetes** with custom resources and controllers so platform teams provision and **continuously reconcile** external infrastructure (cloud services, databases, SaaS, on-prem) behind **declarative custom APIs**. Created by **Upbound**, open-sourced in 2018, it joined the CNCF as Sandbox (2020) → Incubating (2021) → **Graduated (Nov 2025)**, with 100+ releases, 3,000+ contributors from 450+ organizations. Its pitch: *"the cloud-native framework for platform engineering"* — apply "the declarative control model pioneered by Kubernetes" to **orchestrate anything**.

The mental model is a **control plane, not a one-shot deploy tool**. Where Terraform/Pulumi run an imperative apply, Crossplane installs **controllers** into a Kubernetes cluster that **run a reconcile loop forever**: they compare desired state (`spec.forProvider`) against the real external resource and drive the two together, **reverting out-of-band drift automatically** (change a value in the AWS console and Crossplane changes it back). Everything is a **Kubernetes API object** stored in **etcd** and served as a **CRD**, so kubectl, GitOps (Argo/Flux), RBAC, admission control, and the whole K8s ecosystem apply for free — at the cost that **you must run and operate Kubernetes** to use it.

Two layers stack on that base. **Providers** add the low-level catalog: each provider is an OCI package (`xpkg`) of CRDs + controllers for an external API (AWS, Azure, GCP, Kubernetes, Helm, Terraform, databases, SaaS), so a **Managed Resource (MR)** like an S3 `Bucket` becomes a Kubernetes object. **Compositions + Composite Resource Definitions (XRDs)** add the platform-engineering abstraction on top: platform teams **publish their own custom APIs** (an `XDatabase`, a `Platform`) that bundle many managed resources behind one developer-facing shape — the dev-vs-platform separation HoBo borrows. This is the **same platform-orchestrator thesis as Humanitec's Resource Definitions + Matching**, expressed as Kubernetes CRDs.

| Dimension | Crossplane |
|---|---|
| What it is | Framework to build **Kubernetes-based control planes** for infrastructure — and, in v2, applications |
| Authoring | **Declarative YAML** CRDs — `Provider`, `ProviderConfig`, Managed Resources, `CompositeResourceDefinition`, `Composition`, `Function`; **no code-first infrastructure-from-code** (functions are code, but the composition graph is YAML) |
| Core objects | **Provider** · **ProviderConfig** · **Managed Resource (MR)** · **Composite Resource Definition (XRD)** · **Composite Resource (XR)** · **Claim (XC)** (v1) · **Composition** · **Composition Function** · **Operation / CronOperation / WatchOperation** (v2) |
| Model | **Reconciliation** — controllers continuously drive external state to `spec.forProvider`; drift is auto-corrected (level-triggered, self-healing) |
| Abstraction | **XRD (custom API schema) + Composition (template of resources)** — platform teams publish APIs; app teams consume them |
| Substrate | **Runs on Kubernetes** (CRDs + controllers + etcd); "orchestrate anything" via installed providers |
| Targets | Any external API with a provider — hyperscalers (AWS/Azure/GCP), Kubernetes, Helm, Terraform, databases, SaaS, on-prem; huge ecosystem via **Upbound Marketplace** + `crossplane-contrib` |
| Provisioning | **Delegated to providers** (each = CRDs + controllers); many providers **generated from Terraform schemas via [Upjet](https://github.com/crossplane/upjet)** |
| Programmability | **Composition Functions** — Go / Python / KCL / Go-templates, run as gRPC servers in pods; enable loops, conditionals, dynamic generation |
| AI | Upbound's *"AI-native / intelligent control plane"* direction (UXP 2.0); Crossplane itself is **API-first** — agents drive it via the Kubernetes API |
| License / commercial | **Apache-2.0** OSS (CNCF-graduated); **Upbound** sells **UXP** distribution, **Spaces** (control-plane-as-a-service), and a **Marketplace** (signed providers, SBOMs, LTS) |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Provider** | An OCI package (`xpkg`) of CRDs plus controllers for one external API |
| **Managed Resource (MR)** | One external resource as a Kubernetes object, with `spec.forProvider` as the desired state |
| **ProviderConfig** | Credentials and connection settings for a provider |
| **XRD** (CompositeResourceDefinition) | The custom API a platform team publishes |
| **Composition** | The template mapping an XR to a set of managed resources, with a pipeline mode running functions |
| **Composite Resource (XR) / Claim** | The instance a consumer creates against the published API |
| **Composition Function** | Programmable composition in Go/Python/KCL over gRPC — loops, conditionals, generation |

The mental model is **the Kubernetes controller pattern applied to everything**: desired state is a
Kubernetes object, a controller converges reality toward it continuously, and platform teams publish
their own APIs by defining XRDs and the Compositions that satisfy them. Everything else — RBAC,
GitOps, admission control, observability — comes free because everything is a Kubernetes object.

## How it competes with HoBo

Crossplane is **explicitly not a head-on competitor** in HoBo's own posture: it is a borrow-source
for reconciliation and the developer/platform separation, and a pluggable `IacProvider` adapter when
a Camp's substrate is Kubernetes ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)). The
overlap that does exist:

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `typed-contracts` | XRDs publish typed platform APIs — the same seam Bindle kinds occupy |
| `reconciliation` | **Crossplane's strongest surface**, and the model HoBo borrows rather than rivals |
| `provider-matching` | Composition selection by type/label selector, versus HoBo's scored, recorded matching |
| `extensibility` | An enormous provider ecosystem, largely Upjet-generated from Terraform schemas |
| `app-graph` | Only in v2, and as orchestration of Kubernetes objects rather than an application model |

## Feature surface

### The control-plane / reconciler model

Crossplane is a set of Kubernetes controllers. Installing it adds the core apiextensions controller; installing a provider adds its resource controllers. Each controller runs the **Kubernetes controller pattern** on a reconcile loop: read the desired state from the object's `spec`, observe the real external resource, and `Create`/`Update`/`Observe`/`Delete` to converge. State of record lives in **etcd**; the external resource's observed state is mirrored back into `status.atProvider`. Because reconciliation is **continuous and level-triggered**, Crossplane both provisions and **self-heals** — it is the property HoBo borrows for its `ResourceActor` / Delta→Set model ([vision.md](../design/vision.md), [Plan 04](../design/control-plane.md#plan-04)).

### Providers & managed resources

A **Provider** is an OCI package (`xpkg`) that adds CRDs + controllers for an external API. Install it declaratively:

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.crossplane.io/crossplane-contrib/provider-aws-s3:v2.0.0
  # packagePullPolicy / revisionActivationPolicy / revisionHistoryLimit
```

A **ProviderConfig** supplies credentials; a Managed Resource references one via `providerConfigRef` (defaults to `default`):

```yaml
apiVersion: aws.m.upbound.io/v1beta1
kind: ProviderConfig
metadata: { name: default }
spec:
  credentials:
    source: Secret
    secretRef: { namespace: crossplane-system, name: aws-creds, key: creds }
```

A **Managed Resource (MR)** is the Kubernetes representation of one external resource. `spec.forProvider` is **Crossplane's source of truth** — it is enforced and drift is reverted:

```yaml
apiVersion: s3.aws.m.upbound.io/v1beta1
kind: Bucket
metadata:
  namespace: default          # v2: MRs are namespaced
  name: my-bucket
spec:
  forProvider:                # desired state; Crossplane overrides out-of-band changes
    region: us-east-2
  providerConfigRef: { name: default, kind: ProviderConfig }
  # managementPolicies: [Create, Update, Delete, Observe, LateInitialize]
  # crossplane.io/external-name annotation overrides the external resource name
  # writeConnectionSecretToRef publishes connection details to a Secret
```

Deletion is finalizer-guarded (the external resource is deleted first, then the Kubernetes object). Provider breadth is enormous and largely **machine-generated**: **Upjet** reads a Terraform provider's schema and emits the Go types, CRDs, and controllers for a Crossplane provider — mechanically transpiling Terraform coverage into Crossplane coverage (and shedding the Terraform CLI's BSL license).

### Compositions, XRDs, Composite Resources & Claims

The platform-engineering layer is three objects. An **XRD** defines the schema of a **custom API**; a **Composition** is the template of resources that API expands to; a **Composite Resource (XR)** is an instance developers create.

```yaml
# 1) XRD — define the custom API
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata: { name: xdatabases.example.org }
spec:
  scope: Namespaced           # v2 default (v1 was Cluster + a namespaced Claim)
  group: example.org
  names: { kind: XDatabase, plural: xdatabases }
  versions:
  - name: v1alpha1
    served: true
    referenceable: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties: { region: { type: string } }
            required: [region]
```

```yaml
# 2) Composition — template of resources, pipeline mode
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata: { name: xdatabases.example.org }
spec:
  compositeTypeRef: { apiVersion: example.org/v1alpha1, kind: XDatabase }
  mode: Pipeline
  pipeline:
  - step: patch-and-transform
    functionRef: { name: function-patch-and-transform }
    input:
      apiVersion: pt.fn.crossplane.io/v1beta1
      kind: Resources
      resources:
      - name: bucket
        base:
          apiVersion: s3.aws.m.upbound.io/v1beta1
          kind: Bucket
          spec: { forProvider: { region: us-east-2 } }
        patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.region
          toFieldPath: spec.forProvider.region
```

```yaml
# 3) XR — a developer consumes the custom API
apiVersion: example.org/v1alpha1
kind: XDatabase
metadata: { namespace: team-a, name: prod }
spec:
  region: us-east-2
```

**Claims (XC / XRC).** In **v1**, XRs were cluster-scoped and developers instead created a namespaced **Claim** that acted as a proxy: creating/updating/deleting the Claim created/updated/deleted a bound XR, which in turn owned all the composed resources. In **v2**, XRs are **namespaced by default**, so "there's no longer a need for claims" — claims are removed for the new namespaced/cluster-scoped XRs (the old behavior survives as `scope: LegacyCluster` for compatibility).

### Composition Functions

Native patch-and-transform composition was deprecated in v1.17 and replaced by **composition functions**. A `Function` is installed as a package and runs as a **gRPC server in a pod**; a Composition's `pipeline` invokes functions in order, each receiving the accumulated desired state and returning the next:

```yaml
apiVersion: pkg.crossplane.io/v1beta1
kind: Function
metadata: { name: function-patch-and-transform }
spec:
  package: xpkg.crossplane.io/crossplane-contrib/function-patch-and-transform:v0.8.0
```

Functions are written in **Go, Python, or KCL** (plus Go-templating), so a Composition gains real programmability — **loops, conditionals, and dynamic resource generation** — beyond static YAML patches.

### Crossplane v2 (2025)

v2 is a substantial evolution ([announcement](https://blog.crossplane.io/announcing-crossplane-2-0/)):

- **Namespaced XRs by default** — the XRD `scope` field defaults to `Namespaced`; better multi-tenant isolation and RBAC.
- **Namespaced managed resources** — MRs are namespaced too (AWS fully, other providers being updated).
- **Claims removed** — unnecessary once XRs are namespaced.
- **Compose *any* resource** — a Composition can now bundle an MR *and* a native Kubernetes `Deployment` *and* a third-party CRD (e.g. a CloudNativePG `Cluster`) — Crossplane moves from "infrastructure control plane" toward **application control planes**.
- **Operations** — `Operation` (run once), `CronOperation` (scheduled), `WatchOperation` (event-triggered) run function pipelines to completion like a Kubernetes Job, for day-2 workflows.
- Housekeeping: XR machinery under `spec.crossplane`; native patch/transform removed; `ControllerConfig` deprecated; fully-qualified registry URLs required.

Even here the substrate is unchanged: composing a `Deployment` **orchestrates a Kubernetes object**; Crossplane reconciles it, it is not itself a durable application runtime.

### Upbound (commercial)

**Upbound** — Crossplane's creator — sells the enterprise layer: **UXP (Upbound Crossplane / "Universal Crossplane")**, an opinionated, enterprise-hardened distribution (free Community + commercial licenses), now marketed as an *"AI-native control plane"* (UXP 2.0); **Spaces**, a **control-planes-as-a-service** hosting environment that runs UXP for you (or self-managed on your own cluster); and the **Upbound Marketplace**, offering verified providers with long-term support, **package signing, SBOMs, and vulnerability remediation**. The OSS project runs standalone on any Kubernetes cluster with no Upbound dependency.

## Architecture

- **Control plane** — Crossplane controllers in a Kubernetes cluster; **a running cluster is
  required**, and state lives in **etcd**.
- **Data plane** — the external APIs each provider reaches; managed resources are the projection of
  those APIs into Kubernetes objects.
- **Execution model** — continuous, level-triggered reconciliation: controllers converge each
  managed resource toward `spec.forProvider`, correcting drift indefinitely rather than at apply
  time. This is the property Terraform-style engines do not have and the reason Crossplane is worth
  borrowing from.
- **Composition pipeline** — functions run as gRPC services, transforming the desired-state document
  before resources are created.
- **State authority** — etcd, plus the external systems themselves as observed state. Declarative and
  self-correcting; no decision log.
- **Scaling boundary** — CRD count, etcd pressure and per-provider controller memory are the real
  limits, and they arrive well before the abstraction does.
- **Portability boundary** — Crossplane provisions anything with an API, from any cluster; it does
  not make workloads portable, and it cannot exist without Kubernetes.

## Where Crossplane is stronger

> Shipped, evidenced capability only — and Crossplane is the most mature system in this corpus.

### What Crossplane does well

- **Mature, CNCF-graduated (Nov 2025), production-proven at real scale** — 100+ releases, 3,000+ contributors, 450+ organizations. This is a battle-tested control plane, not a design.
- **Rock-solid reconciliation** — the Kubernetes controller pattern applied to infrastructure: continuous drift correction, self-healing, level-triggered convergence. The robustness HoBo's design aspires to and explicitly borrows.
- **Enormous provider ecosystem** — hyperscalers, Kubernetes, Helm, Terraform, databases, SaaS, on-prem, largely **auto-generated from Terraform schemas via Upjet**, distributed through a signed Marketplace with SBOMs and LTS.
- **Genuine platform-engineering primitive** — XRDs + Compositions let platform teams **publish custom self-service APIs** and app teams consume them: a clean dev-vs-platform separation (the Humanitec Resource-Definition-and-Matching thesis, as Kubernetes CRDs).
- **API-first and ecosystem-native** — everything is a Kubernetes object, so kubectl, GitOps (Argo/Flux), RBAC, admission control, and observability tooling all apply unchanged; agents drive it via the Kubernetes API.
- **Real programmability** — composition functions (Go/Python/KCL, gRPC) add loops, conditionals, and generation over static YAML.
- **A managed path** — Upbound Spaces/UXP for teams who don't want to operate it themselves.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`; **proof** =
draft/proof material; **design-only** = design intent. This capture was written when more of HoBo
was design; the ◐/🔜 marks in the mapping table below record that honestly, and the
[live provider matrix](../design/live-provider-matrix.md) carries the current caveats.

### Crossplane's limits, and what HoBo does instead

- **Kubernetes-bound.** It **requires a running Kubernetes cluster**; state lives in **etcd**; every resource is a **CRD**; scaling means managing CRD/etcd/controller-memory pressure. HoBo treats **Kubernetes/Crossplane as an optional substrate adapter, never a requirement** — *"Kubernetes/Crossplane is an optional execution substrate adapter, never a requirement"* ([control-plane.md](../design/control-plane.md#plan-04)); the Yard runs on a language-native core and the default wasm host is self-hosted wasmCloud ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **YAML, not code-first infrastructure-from-code.** Authoring is declarative YAML CRDs (Providers / MRs / XRDs / Compositions); functions are code but the composition graph is YAML. There is **no "declare a resource inline where your app uses it" + `.allow()`**. HoBo is **IfC + `.allow()` code-first** — one declaration yields IAM + a wasm capability link + an agent token scope ([Plan 21](../design/authoring-resources-wiring.md#plan-21)).
- **An infrastructure control plane, not an application runtime.** Crossplane provisions and reconciles external resources; even v2's "compose a `Deployment`" is **orchestrating a Kubernetes object**, not executing your application. There is **no durable, event-sourced application runtime** — no actors, durable workflows, sagas, or replayable event store. HoBo adds exactly that **above** infra reconcile ([Plan 11](../design/data-plane.md#plan-11) / [ADR-0003](../design/adr/01-architecture-core.md#adr-0003) / [ADR-0004](../design/adr/01-architecture-core.md#adr-0004) / [ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No wasm / polyglot component runtime.** Providers and functions are Go/Python/KCL containers; there is no WIT/WASI Component Model or capability-security link graph. HoBo is **wasm-default, any language → one component** ([Plan 20](../design/wasm-runtime-wit.md#plan-20) / [ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **No agents-as-principals; providers hand-authored (or Terraform-transpiled).** Upbound markets an *"AI-native / intelligent control plane,"* but that is assistant/controller intelligence — **agents are not first-class identities** with brokered SPIFFE-style tokens, and providers are hand-written or **Upjet-transpiled from Terraform**, not **AI-generated and conformance-certified**. HoBo makes **agents principals** ([Plan 06](../design/ai-native-agent-auth.md#plan-06)) and **generates providers/implementations** through a certified pipeline ([Plan 23](../design/generated-stack.md#plan-23) / [ADR-0010](../design/adr/03-data-plane.md#adr-0010)).
- **Composition selection is not auditable "why this infra."** A Composition binds to an XR by type/label selector; there is no first-class recorded decision explaining *which* realization was chosen for *which* context. HoBo's **Matching** scores Resource Definitions by context and records a **`match.Decided`** event — an auditable "why this infra" (explicitly "Humanitec parity", [Plan 25](../design/platform-engineering.md#plan-25) / [ADR-0033](../design/adr/01-architecture-core.md#adr-0033)).
- **Higher operational complexity.** Adopting Crossplane means operating **Kubernetes + Crossplane + a fleet of provider pods** (each provider is controllers + CRDs, often memory-hungry) + function pods + etcd + upgrades. That is the "must run K8s" tax; a small team pays a large operational floor. HoBo's **self-host = hosted** (the Yard is itself a Bindle, [Plan 04](../design/control-plane.md#plan-04)) without mandating a control cluster.

## Adversarial critique

- **Kubernetes is mandatory, and that is the whole critique.** A cluster must exist, be operated, and
  be scaled before a single external resource is provisioned. For a small team the operational floor
  exceeds the problem being solved.
- **etcd and CRDs are the scaling wall.** Thousands of managed resources mean thousands of CRs in
  etcd, plus a controller per provider holding them in memory. The failure mode is not "the
  abstraction is wrong" but "the substrate ran out".
- **YAML composition is a programming language in disguise.** Composition functions exist precisely
  because static YAML could not express loops and conditionals — an admission that the authoring
  model outgrew its format.
- **Upjet-generated providers inherit Terraform's model**, including its resource granularity and
  occasionally its bugs, one abstraction layer further from the user.
- **Composition selection is unexplained.** Type and label selectors bind a Composition to an XR;
  nothing records why that realization was appropriate for that context.
- **Provider fleet operations.** Each provider is controllers plus CRDs, frequently memory-hungry,
  each on its own release cadence, all requiring upgrade coordination.
- **It is not an application runtime**, and v2's application composition is still orchestration of
  Kubernetes objects rather than execution of an application.

### Comparisons with adjacent tools

- **vs HoBo:** **Not head-on.** Crossplane is a **K8s-native infrastructure control plane** (YAML/CRDs, reconciliation, huge provider ecosystem); HoBo is a **cloud-agnostic control plane + durable wasm runtime** that (a) **borrows** Crossplane's reconciliation + dev/platform separation ([vision.md](../design/vision.md)), and (b) can **drive Crossplane as one pluggable IaC adapter** ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) — *"Crossplane = the adapter used when a Camp's substrate is Kubernetes"* ([control-plane.md](../design/control-plane.md#plan-04)). Adjacent + borrow-source + adapter, not a replacement target.
- **vs Terraform / Pulumi / OpenTofu:** Crossplane is a **continuously-reconciling control plane** where the others are (drift-aware) apply engines. HoBo keeps **all four as `IacProvider` adapters, none primary** ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)); Crossplane provider config flows through `.with(...)` (e.g. composition selectors).
- **vs Humanitec:** the closest conceptual sibling — both realize *"developer requests an abstract resource → platform maps it to concrete infra."* Crossplane's XRD/Composition ≈ Humanitec's Resource Definitions + Matching, as Kubernetes CRDs. HoBo aligns with the **Humanitec Matching model** (records `match.Decided`) but can realize via Crossplane underneath — see [`humanitec.md`](humanitec.md#primitive-mapping).
- **vs Radius:** HoBo borrows from *"Crossplane/Radius"* jointly ([vision.md](../design/vision.md)); Radius is more application-graph-centric (recipes) over similar reconciliation — both inform HoBo's `bindle()` vs `camp()`/`yard()` split.
- **vs Encore / Nitric / Aspire:** those are **app-side IfC** (declare resources in app code); Crossplane is the **platform-side realization/reconcile engine** that could sit underneath them. HoBo unifies both layers — IfC authoring on top, Crossplane/TF/Pulumi/OpenTofu as realization adapters below.
- **vs wasmCloud (HoBo's default host):** wasmCloud *can* run on Kubernetes but doesn't require it; Crossplane requires it. Different layer, different substrate assumption.

**Net:** Crossplane is the **mature, CNCF-graduated realization engine** HoBo treats as a **pluggable IaC adapter** and a **borrow-source** (reconciliation + dev/platform separation) — **not a head-on competitor**. Its limits — Kubernetes-bound, YAML-not-IfC, infrastructure-not-application-runtime, no wasm, no agents-as-principals or provider generation, high operational complexity — are precisely the seams HoBo's design targets, while HoBo can still **stand on Crossplane** where a Camp's substrate is Kubernetes. Crossplane's advantages today (provider-ecosystem breadth, reconciliation robustness at scale, K8s-native operational maturity) are real and shipping; HoBo is **design-phase**, so those remain Crossplane's to keep.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Crossplane concept (✅ has · ➕ goes further · ◐ thinner/behind today · 🔜 planned). **HoBo is design-phase; Crossplane is a mature graduated CNCF project** — where that maturity leads, HoBo is marked ◐/🔜 honestly.

| Crossplane concept | HoBo equivalent | Status | Notes |
|---|---|---|---|
| **Reconciliation / controller pattern** (converge to `spec.forProvider`, self-heal) | `ResourceActor` + **Delta→Set incremental reconcile** ([Plan 04](../design/control-plane.md#plan-04)); model **borrowed from Crossplane** ([vision.md](../design/vision.md)) | ✅ borrow | Same level-triggered idea; HoBo's is designed, not yet proven at Crossplane's scale |
| **Runs on Kubernetes** (CRDs + etcd, required) | K8s/Crossplane is an **optional substrate adapter, never required** ([control-plane.md](../design/control-plane.md#plan-04)); default wasm host self-hosted wasmCloud ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ➕ | HoBo removes the "must run K8s" floor |
| **Providers** (OCI `xpkg` = CRDs + controllers) | `CloudProvider` **capability providers** (WIT components) + `IacProvider` adapters ([Plan 04](../design/control-plane.md#plan-04)) | ✅/➕ | Provider = WIT world, authorable in any wasm language |
| **Managed Resources** (`forProvider` source of truth) | HoBo resources = **WIT ports**, each realized as an isolated per-resource IaC stack ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ✅ | |
| **ProviderConfig** (credentials) | provider config + `.allow()` → **least-priv IAM + link + brokered token** (one decl, three effects) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅/➕ | |
| **XRD + Composition** (custom API → set of resources) | **Resource Definitions + Matching** ([Plan 25](../design/platform-engineering.md#plan-25) / [ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) — the direct analog | ✅/➕ | HoBo adds **auditable selection**, below |
| **Composition selection** (type/label selector) | **Matching** context-scores definitions and records a **`match.Decided`** event ("why this infra", Humanitec parity) | ➕ | Crossplane has no first-class "why this realization" record |
| **Composite Resource / Claim** (namespaced consume) | Bindle resources consumed per-Camp; tenant isolation via **multi-tenant-app primitives** ([Plan 50](../design/security-networking.md#plan-50)) | ✅/➕ | |
| **Composition Functions** (Go/Python/KCL, gRPC) | composition over **WIT** + the **AI generation pipeline** (providers/impls/Resource Definitions generated + certified) ([Plan 23](../design/generated-stack.md#plan-23) / [ADR-0010](../design/adr/03-data-plane.md#adr-0010)) | ➕ | HoBo generates *providers*, not just composes resources |
| **Crossplane itself as realization engine** | **first-party `IacProvider` adapter**; used when a Camp's substrate is Kubernetes ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006), [control-plane.md](../design/control-plane.md#plan-04)) | ✅ | HoBo **drives** Crossplane (composition selectors via `.with()`) |
| **v2: compose applications** (`Deployment` etc.) | apps run natively on the **durable, event-sourced wasm runtime** ([Plan 11](../design/data-plane.md#plan-11) / [Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ➕ | HoBo executes apps; Crossplane orchestrates K8s objects |
| **v2: Operations / CronOperation** (day-2) | actors + durable workflows + `hobo:scheduler` over a replayable event store ([Plan 11](../design/data-plane.md#plan-11)) | ➕ | |
| **API-first** (K8s API + GitOps + RBAC) | **event-sourced control plane** + `@hobo/mcp` + **agents as principals** ([Plan 06](../design/ai-native-agent-auth.md#plan-06) / [Plan 11](../design/data-plane.md#plan-11)) | ➕ | GitOps publisher is one apply path ([Plan 25](../design/platform-engineering.md#plan-25)) |
| **Dev-vs-platform separation** | `bindle()` (provider-agnostic) vs `camp()`/`yard()` (provider-specific) scopes — **borrowed** ([vision.md](../design/vision.md)) | ✅ borrow | |
| **Upbound Spaces / UXP** (control-plane-as-a-service) | **self-host = hosted** (Yard is itself a Bindle, [Plan 04](../design/control-plane.md#plan-04)); OSS, monetization out of design scope ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | ➕/different | No commercial control-plane SKU |
| **Provider-ecosystem breadth** (mature, Upjet-generated) | HoBo provider set + generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)) | ◐/🔜 | **Crossplane far ahead today**; HoBo is design-phase |
| **Reconciliation robustness at real scale** | Delta→Set reconcile ([Plan 04](../design/control-plane.md#plan-04)) | ◐ | Designed, not yet battle-tested like Crossplane |

## Better-together / integration posture

- **Borrow** — reconciliation and the developer/platform separation, taken wholesale and credited in
  [`lineage.md`](../design/lineage.md).
- **Integrate / adapter** — Crossplane is a first-party `IacProvider` alongside Pulumi, Terraform and
  OpenTofu, none primary ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)); when a Camp's
  substrate is Kubernetes, HoBo realizes resources *through* Crossplane.
- **Benchmark** — provider-ecosystem breadth and reconciliation robustness at scale are Crossplane's
  to keep, and are the standard HoBo's own realization layer is measured against.
- Not a displace target, and HoBo's materials should not present it as one.

## Threats and lessons

1. **Continuous reconciliation is the property that matters most**, and it is the hardest to
   retrofit. HoBo borrows the model; it has not yet proven it at Crossplane's scale, and saying so
   plainly is more credible than implying parity.
2. **Ecosystem breadth is bought, not designed.** Upjet generates providers from Terraform schemas —
   a mechanical path to hundreds of integrations. HoBo's generation pipeline is the analogous bet and
   should be evaluated against Upjet's actual results, not against hand-authoring.
3. **The operational floor is a market segmentation.** Crossplane's Kubernetes requirement cedes the
   entire small-team and local-development segment. HoBo's local and browser runtimes address exactly
   that gap, and that is a sharper wedge than any feature comparison.
4. **Composition selection remains unexplained across this whole cohort** — Crossplane's selectors,
   Radius's static bindings, Kusion's single workspace. Recorded, scored selection is HoBo's
   consistent differentiator against all of them.

## Sources

- [crossplane.io](https://www.crossplane.io/) and [docs.crossplane.io](https://docs.crossplane.io/) — providers, managed resources, XRDs, Compositions, composition functions, v2 changes
- [crossplane/crossplane](https://github.com/crossplane/crossplane) — source, Apache-2.0, CNCF graduation status
- [Upbound](https://www.upbound.io/) — Upjet provider generation, Marketplace, Spaces/UXP (vendor material, recorded as claims)
- HoBo-side: [`design/lineage.md`](../design/lineage.md), ADR-0006, ADR-0144, and the plan references cited inline

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Release-by-release v2 detail and current Upbound commercial packaging
were not re-verified in this pass and are not asserted.

### Crossplane-as-borrow-source and IaC adapter (not a target to replace)

> **Design-suite posture:** the XRD/Composition/Claim ↔ Resource Definition mapping and the definition-versioning rules it inspired are now normative in [ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144) — vocabulary alignment only; the core IR never depends on Crossplane's continued dominance.

Two relationships, both deliberate. **(1) Borrow.** HoBo takes Crossplane's **reconciliation model and dev-vs-platform separation** wholesale ([vision.md](../design/vision.md)) — the `bindle()` (provider-agnostic) vs `camp()`/`yard()` (provider-specific) scope split, provider recipes, and equivalence classes are Crossplane's idea, re-expressed as HoBo SDK objects. **(2) Adapter.** Crossplane is a **first-party `IacProvider`** alongside Pulumi/Terraform/OpenTofu, none primary ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)); when a Camp's substrate is Kubernetes, HoBo realizes resources **through** Crossplane (compositions + managed resources, reconciliation delegated to K8s controllers), with Crossplane-specific settings passed via `.with(...)`. HoBo's net-new is the layer **around** that engine: code-first IfC, a wasm-default runtime, an event-sourced/durable app runtime, auditable Matching, agents-as-principals, and provider generation.

### The one-line takeaway

**Crossplane is HoBo's reconciliation borrow-source and a pluggable IaC realization adapter — not a head-on competitor.** HoBo maps Crossplane's Compositions/XRDs onto **Resource Definitions + Matching** (adding an auditable `match.Decided`), can even **stand on Crossplane** when a Camp is Kubernetes, and borrows its reconciliation + dev/platform separation — while reaching past Crossplane's **Kubernetes-bound, YAML, infrastructure-only** control plane to a **cloud-agnostic, code-first, wasm-default, durable-event-sourced, agent-native** platform. Where Crossplane is a mature graduated project (provider ecosystem, reconciliation at scale, K8s-native ops) and HoBo is design-phase, that maturity is Crossplane's — credited honestly as ◐/🔜.
