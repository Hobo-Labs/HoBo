---
type: Competitive Reference
title: "Winglang — competitor reference"
description: "Winglang (Wing) is an **open-source, cloud-oriented programming language** (MIT) by Elad Ben-Israel (creator of AWS CDK) and the Wing Cloud team — a *new language* that unifies infrastructure and"
tags: [hobo, competitors]
competitor:
  slug: winglang
  name: "Winglang"
  aliases: ["wing"]
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code]
  directness: adjacent
  role: "cloud-oriented language compiling to Terraform — authoring analog and cautionary tale (Wing Cloud shut down 2025)"
  posture: [borrow, benchmark]
  hobo_surface: [authoring, typed-contracts]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://www.winglang.io/docs/
    - https://github.com/winglang/wing
---

# Winglang — competitor reference

> A faithful capture of **Winglang (Wing)** for HoBo competitive analysis. Wing is a **cloud-oriented programming language** — not a framework inside an existing language (Nitric/Encore) but a **new language** whose type system splits **preflight** (infrastructure, evaluated at compile time) from **inflight** (runtime code, compiled to JavaScript), compiling to **Terraform (CDKTF)** or **AWS CDK/CloudFormation**. It is the most literal expression of the **cloud-agnostic authoring** thesis HoBo shares — a head-on-ish competitor on the *authoring model* (like Nitric). Sources: [winglang.io](https://www.winglang.io/) · [winglang.io/docs](https://www.winglang.io/docs/) (concepts/[inflights](https://www.winglang.io/docs/concepts/inflights)) · [github.com/winglang/wing](https://github.com/winglang/wing) · standard library ([cloud.Bucket](https://www.winglang.io/docs/api/standard-library/cloud/bucket)/[cloud.Queue](https://www.winglang.io/docs/api/standard-library/cloud/queue)/[cloud.Function](https://www.winglang.io/docs/standard-library/cloud/function)) · [Wing Console](https://www.winglang.io/docs/tools/wing-console). **Status (honest):** Wing Cloud, the company, [announced its shutdown on 2025-04-09](https://www.winglang.io/blog/2025/04/09/shutdown); the language remains MIT open source but is **pre-release** (the README states *"🚧 This is a pre-release"*), the last release was **v0.85.49 (2025-02-03)**, the hosted docs site has been [reported down](https://github.com/winglang/wing/issues/7263) (2025-06), and the community itself has publicly asked whether [the project is abandoned](https://github.com/winglang/wing/discussions/7225). It shipped a *real*, working language + simulator + a 100+ contributor community — credit it against HoBo's design-phase status. License **MIT**. Researched July 2026; language/CLI/API shapes and status quotes reproduced for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Winglang (**Wing**, files `.w`) is an **open-source (MIT) programming language for the cloud**, created by **Elad Ben-Israel** (author of AWS CDK), the **Wing Cloud** team, and community contributors ("Wingnuts"). Its thesis: *infrastructure and application code are one program.* Instead of writing IaC (Terraform/CDK/Pulumi) in one place and runtime code in another, you write **one Wing program** with two execution phases the compiler distinguishes and type-checks:

- **Preflight** — code that runs **once, at compile time**, to produce the **infrastructure configuration** of your app (Terraform JSON via CDK for Terraform, or CloudFormation via AWS CDK). Instantiating `new cloud.Bucket()` is preflight — it declares infra.
- **Inflight** — code (marked `inflight`) that is **compiled to JavaScript** and runs **at runtime** inside cloud compute (Lambda/containers, Node.js). Handling a queue message or an API request is inflight.

You `bring cloud;` and instantiate **first-class cloud resources** (`cloud.Bucket`, `cloud.Queue`, `cloud.Function`, `cloud.Counter`, `cloud.Topic`, `cloud.Api`, `cloud.Schedule`, …); an inflight closure that **captures** a preflight resource is automatically wired — Wing **infers the least-privilege IAM** from *which methods the inflight actually calls*, with no explicit grant statement. One program compiles to multiple **targets/platforms**: `sim` (a local, in-process cloud **simulator**), `tf-aws`/`tf-azure`/`tf-gcp` (Terraform), and `awscdk` (CloudFormation). Local development runs against the `sim` target with the **Wing Console** (`wing it`) — a visual, hot-reloading operations UI.

The mental model is the same **authoring-time IfC** idea HoBo adopts ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) — declare what the app needs where you use it, and the toolchain provisions it — but taken to its maximal form: a **new language** where the preflight/inflight split is a *language primitive*, not a convention. That split is the single closest external analog to HoBo's own separation of **authoring-time IfC** from a **wasm runtime** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) — except HoBo reaches it **without asking anyone to adopt a new language**.

**Honest status.** Wing is not vaporware — it shipped a coherent language, a genuinely good simulator/console, a cloud-portable standard library, and a real community. But the bet did not become a business: **Wing Cloud shut down in April 2025** (founded April 2022; **$20M seed**, July 2023), the founder citing that *"while developer experience is something engineers care deeply about, it's not always seen as business-critical by most companies."* The language is MIT and *"the ideas will hopefully live on, just not as a business concern"*; a maintainer stated intent to *"keep Winglang open in the long term,"* but active development has largely wound down (last release Feb 2025, docs site reported down, community asking if it is abandoned). This makes Wing simultaneously HoBo's **cleanest authoring-model validation** and its **sharpest cautionary tale**.

| Dimension | Wing |
|---|---|
| Authoring | **A new programming language** (Wing, `.w`) — infra + runtime unified in one program |
| Core primitive | **preflight** (compile-time → IaC) / **inflight** (`inflight` modifier → JavaScript at runtime), enforced by the type system |
| Resources | `cloud.*` standard library — `Bucket`, `Queue`, `Topic`, `Function`, `Counter`, `Api`, `Schedule`, `Secret`, `Website`, … via `bring cloud` |
| Permissions | **inferred automatically** from inflight *capture + method calls* (no explicit `.allow()`) — least-privilege IAM synthesized by the compiler |
| Runtime | **inflight → JavaScript on Node.js** (single runtime language) |
| Compile targets | `sim` · `tf-aws` · `tf-azure` · `tf-gcp` (Terraform / CDKTF) · `awscdk` (AWS CDK → CloudFormation) |
| Provisioning engine | **Terraform (CDKTF) or AWS CDK** — Wing does **not** provision itself; **no other IaC** (no Pulumi/Crossplane/OpenTofu) |
| Local dev | **in-process simulator (`sim`)** + **Wing Console** (`wing it`: hot reload, resource map/explorer, logs, test runner) — no LocalStack/Docker |
| Interop | `bring` npm / **JSII** modules; SDK is TypeScript, exported via JSII to Python/Go/Java |
| Testing | `test "…" { }` blocks execute against the simulator (or any target) |
| License / status | **MIT**; **pre-release** (v0.85.x, last release 2025-02-03); **Wing Cloud company shut down 2025-04-09**; OSS project largely paused/community |
| Company | Wing Cloud — founded Apr 2022, **$20M seed (Jul 2023)**, **shut down Apr 2025** |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Preflight code** | Code that runs at compile time and defines infrastructure |
| **Inflight code** | Code that runs at runtime inside the deployed compute |
| **Resource** | A cloud object with both preflight (definition) and inflight (usage) faces |
| **Compiler target** | The output platform — Terraform for a cloud, or the local simulator |
| **Wing Simulator** | A local implementation of the resource model with a visual console |

The mental model is **the language knows which phase your code is in**. Marking code preflight or
inflight lets the compiler enforce what can cross the boundary and derive the permissions a runtime
function needs. It is the most conceptually ambitious idea in this cohort.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | A dedicated language with phase-aware semantics |
| `typed-contracts` | Resources typed across the preflight/inflight boundary |

Winglang competes on authoring elegance and is, more importantly for this corpus, **a cautionary
tale**: Wing Cloud, the company behind it, shut down in 2025.

## Feature surface

### Preflight / inflight — the two-phase model

Wing's defining feature. Code is either **preflight** (default; infrastructure, evaluated at compile time) or **inflight** (marked with the `inflight` modifier; runtime, compiled to JavaScript). A single class can hold both — preflight fields/constructors that stand up infra, and inflight methods that run against it. Preflight methods like `queue.setConsumer(...)` *configure infrastructure* to invoke a given inflight function per message:

```wing
bring cloud;

// preflight: infrastructure, evaluated once at compile time
let bucket  = new cloud.Bucket();
let counter = new cloud.Counter();
let queue   = new cloud.Queue();

// setConsumer is a PREFLIGHT method that wires an INFLIGHT handler onto the queue
queue.setConsumer(inflight (message: str) => {
  let i = counter.inc();               // runtime (inflight)
  bucket.put("wing-{i}.txt", message); // string interpolation with { }
});
```

An `inflight` closure can be handed straight to a `cloud.Function` (the FaaS primitive):

```wing
bring cloud;
let countWords = new cloud.Function(inflight (s: str): str => {
  return "{s.split(" ").length}";
});
```

Inflight bodies use the resource's runtime API — e.g. bucket I/O:

```wing
bucket.put("file.txt", "Hello, world!");
bucket.putJson("person.json", Json { name: "Alice" });
let data = bucket.get("file.txt");
```

### Cloud resources — the portable standard library (`bring cloud`)

`bring cloud;` imports Wing's **cloud-portable standard library** of first-class resources — the same code compiles to whichever target you pick, and the platform implementation maps each resource to a provider-native service. Representative resources: **`cloud.Bucket`** (object storage), **`cloud.Queue`** (pull, with `setConsumer`), **`cloud.Topic`** (pub/sub), **`cloud.Function`** (FaaS), **`cloud.Counter`** (atomic counter), **`cloud.Api`** (HTTP), **`cloud.Schedule`** (cron/interval), **`cloud.Secret`**, **`cloud.Website`**. Other namespaces (`bring util;`, `bring ex;`, `bring math;`, `bring http;`) round out the library; `bring "<npm-pkg>" as x;` pulls in JavaScript/JSII modules.

### Automatic permissions (capture-based IAM)

Wing's headline ergonomic: **you never write IAM.** When an inflight closure **captures** a preflight resource, the compiler reflects on *which methods the inflight calls at runtime* and **synthesizes the minimal IAM** for exactly those operations (calling `bucket.put(...)` grants write, and nothing more). This is even lower-ceremony than Nitric/Encore's explicit `.allow(...)` — the grant is *inferred from usage*. **Caveat (from Wing's own docs):** *imported* resources (raw npm/JSII/cloud-SDK objects) are opaque to the compiler, so their permissions **cannot** be inferred automatically — the automatic-IAM guarantee holds only for native `cloud.*` resources.

### The simulator (`sim`) + Wing Console

Wing ships an **in-process cloud simulator** as a first-class compile target (`-t sim`): the whole app — buckets, queues, functions, counters, schedules — runs locally, in memory, *"for testing and debugging in milliseconds,"* with no internet, no LocalStack, no Docker. The **Wing Console** (`wing it`) is a visual web UI over the simulated app: an **Explorer** and a **Map view** (a live architecture diagram of resources and their relationships), a **resource-interaction panel** (click a bucket to upload/inspect files; publish to a topic; trigger a schedule), a **Logs view**, and an integrated **test runner** — all **hot-reloading** on every save. This fast, high-fidelity local loop is Wing's strongest single feature.

### Compile targets / platforms & the CLI

One program, many targets — selected with `-t`/`--target`. Wing does **not** provision infrastructure itself: it **synthesizes** IaC (Terraform via CDK for Terraform, or CloudFormation via AWS CDK) that you then apply with the corresponding engine.

```bash
wing compile main.w -t sim       # local simulator (in-process)
wing compile main.w -t tf-aws    # Terraform for AWS   (also: tf-azure, tf-gcp)
wing compile main.w -t awscdk    # AWS CDK -> CloudFormation
wing it                          # run on `sim` and open the Wing Console (hot reload)
wing test  main.w -t tf-aws      # run `test "..." {}` blocks against a target
```

```wing
test "enqueue then consume" {
  queue.push("hello");
  // assertions execute against the local simulator (sim) in milliseconds
}
```

### Interop & language lineage

Wing's SDK is written in **TypeScript** and exported via **JSII** (the same tech behind AWS CDK) so it can be consumed from Python/Go/Java — Wing itself can `bring` any npm/JSII module, and JSII constructs are treated as preflight classes. This gives Wing an **escape hatch** to the entire JS/CDK ecosystem, but (per the caveat above) at the cost of automatic IAM inference for those imported objects. The lineage is direct: Wing is, in effect, "what the AWS CDK author built next" — CDK-style constructs, but as a language with a runtime phase.

### Project status (honest)

- **Company shut down.** Wing Cloud [announced its shutdown on **2025-04-09**](https://www.winglang.io/blog/2025/04/09/shutdown), ~2 years after a **$20M seed** (Jul 2023). Founder Elad Ben-Israel: *"while developer experience is something engineers care deeply about, it's not always seen as business-critical by most companies"*; and *"we explored various different directions … in the end, we didn't find the right fit."*
- **Language is OSS but pre-release.** MIT-licensed; README banner: *"🚧 This is a pre-release."* Last release **v0.85.49 (2025-02-03)**; ~5.4k GitHub stars, 100+ contributors.
- **Maintenance uncertain.** A maintainer wrote (2024-12-15) *"we plan to keep Winglang open in the long term, as almost all programming languages are,"* but a community member later (2025-06) asked *"is it still the case? The project seems abandoned,"* and the hosted **docs site has been reported down**. Treat production adoption as carrying **real project-viability risk**.

## Architecture

- **Compiler** — Wing source compiles to Terraform for cloud targets, or runs against the simulator
  locally.
- **Phase separation** — enforced by the compiler; permission derivation falls out of knowing which
  inflight code touches which resource.
- **Simulator** — a local implementation of the resource model with a visual console, giving instant
  feedback without deploying.
- **State authority** — Terraform state for deployed infrastructure.
- **Portability boundary** — whatever the compiler targets. The language is the abstraction, so
  portability is a compiler feature rather than a runtime one.

## Where Winglang is stronger

> Shipped, evidenced capability only.

### what Wing does well

- **The purest articulation of "infra and runtime are one program."** Not a framework bolted onto a host language — a **language** where the **preflight/inflight** phase split is a type-system primitive. Conceptually the cleanest cloud-authoring model in the field.
- **Automatic, capture-based least-privilege IAM** — permissions **inferred** from what inflight code actually does; no `.allow()`, no policy JSON. The most ergonomic permission story in the category.
- **Best-in-class local loop** — an **in-process simulator** ("milliseconds," no Docker/LocalStack) plus the **Wing Console** (`wing it`: live architecture map, resource interaction, logs, test runner, hot reload). This is the bar for "works locally predicts works in prod."
- **Cloud-portable standard library** (`cloud.*`) compiling to **Terraform (AWS/Azure/GCP)** or **AWS CDK** — one program, multiple clouds/engines.
- **A real, shipped artifact** with a 100+ contributor community and CDK-author pedigree — credit it honestly against HoBo's design-phase status.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Wing's limits — HoBo's opening

- **It's a NEW LANGUAGE — the adoption cost is the whole ballgame.** Using Wing means writing `.w`, retraining the team, and leaving behind your existing TS/Go/Python/Rust code, mature editor/debugger tooling, libraries, and hiring pool. Wing's *own post-mortem* points at this ("the market might not have been ready to adopt an entirely new language"). HoBo authors in **WIT over any wasm-compiling language** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0069](../design/adr/01-architecture-core.md#adr-0069)/[ADR-0072](../design/adr/01-architecture-core.md#adr-0072)) — **no new language, no rewrite**.
- **Compiles to Terraform/CloudFormation only — no pluggable IaC.** The provisioning engine is fixed to **CDKTF or AWS CDK**; you cannot swap in **Pulumi/Crossplane/OpenTofu**, nor pin specific resources to specific engines. HoBo keeps IaC tools as **pluggable adapters *under* the authoring layer** ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).
- **Inflight runs as JavaScript on Node.js only.** JSII gives multi-language *authoring of the SDK*, but the **runtime** is single-language JS. HoBo's runtime is **language-neutral wasm components** behind WIT ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)).
- **No durable, event-sourced runtime.** Inflight handlers are stateless FaaS-style functions; there is **no actor / durable-workflow / event-store / replay** model. HoBo's runtime is **durable + event-sourced** ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **No AI-native / agent story.** No agents-as-principals, no MCP control surface, no AI generation pipeline, no trainable functions. HoBo is AI-native by design — agents carry SVIDs + MCP ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) and a generation pipeline authors providers/impls ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)).
- **No control-plane governance.** The `cloud.*`→provider mapping is fixed by the target platform (tunable, not redefinable) — there is **no "same app, different infra per environment, auditably"**, no cost/policy/contracts planes, no platform RBAC. HoBo adds **Resource Definitions + Matching** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) — a realization is a recorded `match.Decided` — and the credit/budget-aware **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)), plus contracts/`can-deploy` + policy planes ([Plan 29](../design/contracts-policy-flags.md#plan-29)).
- **No multi-tenant-app primitives, no cross-cloud data story** (migration/portability/consistency) — and **no adopt-in-place onboarding** (Wing is greenfield-by-construction: a new language). HoBo ships `hobo import` for existing TF/Pulumi/FaaS estates ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **Project-viability risk is now *realized*, not hypothetical.** The **company is gone (Apr 2025)**, the language is **pre-release** and largely paused, and the docs site has been reported down. This is the sharpest reminder that **great DX ≠ a sustainable platform** — precisely why HoBo is **OSS with self-host = hosted parity** and keeps monetization out of design scope ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)).

## Adversarial critique

- **The company shut down in 2025.** This is the most important fact in the capture. The project is
  open source and the commercial entity behind it is gone, which changes maintenance expectations
  regardless of the design's quality.
- **A new language is the largest possible adoption ask.** Tooling, editors, hiring, debugging,
  libraries and ecosystem all restart at zero — and this cohort shows that even excellent ideas lose
  to lower-ceremony alternatives.
- **Compile-to-Terraform inherits Terraform**, including state and drift, one abstraction further
  away from the operator.
- **Simulator fidelity is bounded.** A local implementation of cloud services is an approximation,
  and the gap appears exactly where production problems live.
- **Phase separation is elegant and restrictive**, with a learning curve on top of the new syntax.
- **Ecosystem is now community-scale**, which is a very different proposition from a funded project.

### Comparisons with adjacent tools

- **vs HoBo:** Wing = a **new language** unifying infra+runtime, compiling to TF/CDK, JS runtime, superb simulator; HoBo = **no new language** (WIT over any wasm language), **pluggable IaC**, a **durable event-sourced** runtime, **AI-native**, and **governed**. Wing's **preflight/inflight** split is the closest external analog to HoBo's **authoring-time IfC vs wasm runtime** split — HoBo achieves the same separation *without forcing a language change*. Wing's `sim` + Console is the bar `hobo dev` targets; HoBo formalizes it as a **fidelity matrix** (simulate/mock/Camp-only) with `hobo verify` ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)).
- **vs Nitric:** both are cloud-agnostic authoring. Nitric is an **SDK inside existing languages** (Node/Python/Go/Dart) over a gRPC membrane with **explicit `.allow()`**; Wing is a **whole language** with **inferred** permissions. Nitric keeps your language; Wing replaces it — HoBo keeps your language *and* infers/unifies effects via `.allow()` (IAM + wasm link + token).
- **vs Encore:** Encore is an **IfC SDK in TS/Go** that provisions **AWS/GCP directly**; Wing is a **language** that **synthesizes TF/CDK**. Both have fixed provisioning — but **Encore is a live business**, while **Wing's company has shut down**.
- **vs Pulumi / CDK / Terraform:** Wing sits **above** them (it *compiles to* CDKTF/AWS CDK; its author built AWS CDK). HoBo agrees with "author above IaC" but keeps those engines as **pluggable adapters**, broader than Wing's fixed TF/CDK.
- **vs SST/Ion:** SST is TypeScript-on-Pulumi, AWS-centric; Wing is a cross-cloud language. HoBo is **language-neutral + multi-cloud + pluggable-IaC**.
- **vs wasm hosts (Spin/wasmCloud):** Wing has **no wasm runtime** story (inflight is JS); HoBo's runtime **is** wasm components ([`wasm-hosts.md`](wasm-hosts.md)).

**Net:** Wing is the **purest expression of the cloud-agnostic authoring thesis**, and its **preflight/inflight** phase split validates HoBo's authoring-vs-runtime separation more cleanly than any competitor — but it makes the **maximal bet** (a *new language*), ships a **JS-only runtime** compiling to **TF/CDK only**, has **no durable/event-sourced/AI-native/governed** layers, and — decisively — **its company shut down in April 2025**, leaving a pre-release, community-uncertain artifact. HoBo takes the same authoring idea **without the language tax** (WIT over any wasm language), adds pluggable IaC, a durable event-sourced runtime, AI-native depth, and control-plane governance — and its **OSS + self-host = hosted** model is designed to survive exactly the sustainability failure Wing hit.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Wing concept (✅ has · ➕ goes further · 🔜 planned). HoBo is **design-phase**; Wing shipped a real language + simulator — anchors below credit both sides honestly.

| Wing concept | HoBo equivalent | Notes |
|---|---|---|
| **Preflight / inflight** phase split (infra at compile time, runtime code compiled separately) | **IfC authoring** (preflight-like) + **wasm runtime** (inflight-like), split at the WIT boundary ([Plan 21](../design/authoring-resources-wiring.md#plan-21) + [Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) | ✅/➕ same authoring-vs-runtime split — **without a new language** |
| `bring cloud` first-class resources (`cloud.Bucket`/`Queue`/`Topic`/`Function`/`Counter`/…) | HoBo resource catalog as **WIT ports** (`bucket`/`queue`/`topic`/`service`/`schedule`/`secret`/…) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ near 1:1, with cross-cloud equivalence classes |
| **Automatic capture-based IAM** (permissions inferred from inflight method calls) | **`.allow(verbs)` → least-priv IAM + wasm capability link + agent token scope** (one declaration, three effects) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ↔ Wing infers-but-IAM-only; HoBo is explicit-but-unified (and works for imported/provider resources too) |
| **inflight → JavaScript on Node.js** (single runtime language) | language-neutral **wasm components** behind WIT ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) | ➕ any wasm-compiling language at runtime, not JS-only |
| Compile targets `sim`/`tf-aws`/`tf-azure`/`tf-gcp`/`awscdk` (fixed to TF/CDK) | provider adapters across many clouds + **pluggable IaC** (Pulumi/Crossplane/TF/OpenTofu) ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ pluggable engines + per-tier/per-boundary mapping, not a fixed TF/CDK synth |
| Fixed `cloud.*`→provider mapping per platform | **Resource Definitions + Matching** + the **Dispatcher** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ same app → different infra per env, auditable (`match.Decided`), cost-routed |
| **`sim` simulator + Wing Console** (`wing it`, hot reload, map/logs) | `hobo dev` on `runtime-local` + **fidelity matrix** + dashboard ([Plan 7](../design/developer-experience.md#plan-07)/[ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) | ✅/➕ HoBo labels simulate/mock/Camp-only + `hobo verify` splits local vs Camp checks |
| `test "…" {}` blocks run in the simulator | contract testing in `hobo dev`; the **same contract gates `can-deploy`** ([ADR-0070](../design/adr/02-identity-security.md#adr-0070)) | ✅/➕ dev can't drift from prod |
| `bring` npm/**JSII** interop (escape hatch; SDK is TS via JSII) | WIT-generated bindings + typed escape hatches; providers authored in **any wasm language** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)/[Plan 23](../design/generated-stack.md#plan-23)) | ➕ not tied to the JS/JSII ecosystem |
| **A new language (`.w`)** — adoption = rewrite | **No new language** — WIT over any wasm-compiling language ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)/[ADR-0072](../design/adr/01-architecture-core.md#adr-0072)) | ➕ zero-rewrite adoption |
| *(none — greenfield by construction)* | **`hobo import`** adopt-in-place migration ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ adopt existing TF/Pulumi/FaaS estates incrementally |
| *(none)* | **Durable event-sourced runtime** (actors/workflows/sagas + replay) ([Plan 11](../design/data-plane.md#plan-11)/[ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)) | ➕ |
| *(none)* | **Agents as first-class principals + MCP** control surface ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ AI-native by design |
| *(none)* | **AI generation pipeline** — generated providers/impls + trainable functions ([Plan 23](../design/generated-stack.md#plan-23)/[ADR-0010](../design/adr/03-data-plane.md#adr-0010)) | ➕ |
| *(none)* | **Contracts/`can-deploy` + policy planes** ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | ➕ governed platform |
| **Wing Cloud (company) shut down; OSS pre-release, paused** | self-host = hosted (**Yard-is-a-Bindle**), OSS, monetization out of design scope ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) | ➕ designed so the platform survives the business, not vice-versa |

### Wing-as-validation, and the honest caution

Wing is the **strongest external evidence for HoBo's authoring model**: an independent team led by the AWS CDK author concluded that the right shape is **one program that separates infrastructure (preflight) from runtime (inflight)**, with **portable cloud primitives** and a **fast local simulator** — exactly HoBo's [Plan 21](../design/authoring-resources-wiring.md#plan-21) + [Plan 20](../design/wasm-runtime-wit.md#plan-20) split and the `hobo dev` fidelity matrix ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)). The divergence is deliberate and, in hindsight, load-bearing: Wing paid for that model with a **new language** (maximal adoption cost) and bound itself to a **JS runtime + TF/CDK synth**, then **the company failed to find a market**. HoBo takes the validated idea and **removes the language tax** (WIT over any wasm language, [ADR-0069](../design/adr/01-architecture-core.md#adr-0069)), **broadens the substrate** (pluggable IaC + wasm runtime), and **hardens the surroundings** (durable event-sourcing, AI-native, governance) — while its OSS/self-host-parity posture is aimed squarely at the sustainability problem that ended Wing.

### The one-line takeaway

**Wing proves HoBo's preflight/inflight-style authoring split and local-simulator DX are the right instincts** — and, by shutting down its company in April 2025, also proves the trap HoBo is designed to avoid: a **new-language** bet with a **JS-only runtime**, **TF/CDK-only** provisioning, **no durable/AI-native/governed** layers, and **no sustainable model**. HoBo keeps the authoring insight, drops the language, and adds the entire meta-cloud system around it: **WIT-over-any-language + pluggable IaC + a durable event-sourced runtime + AI-native depth + control-plane governance, OSS with self-host = hosted.**

## Better-together / integration posture

- **Borrow** — **the preflight/inflight distinction as a concept**, which cleanly explains why
  build-time and run-time code have different capabilities. HoBo's authoring makes the same
  distinction implicitly and could explain it this well.
- **Benchmark** — the simulator's instant local feedback.
- Not a displace, adopt, provider, or render target.

## Threats and lessons

1. **A better idea in a new language loses to a good-enough idea in an existing one.** This is the
   clearest available evidence for HoBo's TypeScript choice, and it should be cited when that choice
   is questioned.
2. **The commercial failure is the lesson, not the design.** Language-sized bets need ecosystem-sized
   funding, and running out is a normal outcome.
3. **Phase separation deserves better vocabulary in HoBo's docs** — HoBo already has the distinction
   and never names it.
4. **Local simulation is valuable and never sufficient.** Every product in this cohort that offers it
   also inherits its fidelity gap.

## Sources

- [winglang.io/docs](https://www.winglang.io/docs/) — preflight/inflight, resources, compiler targets, simulator
- [winglang/wing](https://github.com/winglang/wing) — source and licence

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. The project's current maintenance status after Wing Cloud's 2025
shutdown was not independently verified in this pass; treat activity claims as requiring a fresh
check.
