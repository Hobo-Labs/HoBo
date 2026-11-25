---
type: Competitive Reference
title: "SST — competitor reference"
description: "SST is an **open-source (MIT) framework** to *\"build full-stack apps on your own infrastructure\"* — Infrastructure-from-Code in a single `sst.config.ts`, whose v3 \"Ion\" engine is built on **Pulumi + Terraform providers** (150+), with resource **Linking**, **Live** local dev, and an optional **Console**."
tags: [hobo, competitors]
competitor:
  slug: sst
  name: "SST"
  aliases: ["sst ion"]
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code, portable-application-models]
  directness: direct
  role: "infrastructure-from-code full-stack framework on Pulumi/Terraform with typed Linking — close product analog"
  posture: [displace, borrow, benchmark]
  hobo_surface: [authoring, typed-contracts, wiring, environments]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://sst.dev/docs/
    - https://github.com/sst/sst
---

# SST — competitor reference

> A faithful, detailed capture of **SST** for HoBo competitive analysis. SST is a **close product analog** to HoBo: **Infrastructure-from-Code** where you author your whole stack in one `sst.config.ts`, deploy into **your own** cloud account, and **link** resources into typed runtime code. Its v3 **"Ion"** rewrite dropped AWS CDK/CloudFormation for a **Pulumi + Terraform** engine (150+ providers). Sources: [sst.dev/docs](https://sst.dev/docs/) · [sst.dev/docs/components](https://sst.dev/docs/components/) · [sst.dev/docs/linking](https://sst.dev/docs/linking/) · [sst.dev/docs/live](https://sst.dev/docs/live/) · [sst.dev/docs/providers](https://sst.dev/docs/providers/) · [sst.dev/docs/state](https://sst.dev/docs/state/) · [sst.dev/docs/console](https://sst.dev/docs/console/) · [sst.dev/docs/reference/cli](https://sst.dev/docs/reference/cli/) · [sst.dev/blog/sst-v3](https://sst.dev/blog/sst-v3/) · [github.com/sst/sst](https://github.com/sst/sst). License **MIT** (framework/CLI/engine OSS; SST Console commercial SaaS). Researched July 2026; API/CLI/config/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

SST is an **open-source framework** (MIT, by the SST team — formerly "Serverless Stack") positioned as *"Build full-stack apps on your own infrastructure."* You define your **entire app in code** — *"your entire app is defined in code"* — databases, buckets, queues, cron, frontends, containers, functions, even third-party resources (Stripe products) — in a single **`sst.config.ts`**, then deploy it into **your own** AWS/Cloudflare/… account. SST calls this **Infrastructure-from-Code**.

**The v3 "Ion" engine shift matters.** SST v1/v2 were built on **AWS CDK + CloudFormation**; after ~3 years the team hit CloudFormation's design limits and **rewrote the engine** (v3, codenamed "Ion") on **Pulumi + Terraform providers** — using only the **open-source** parts (*"does not require a Pulumi account"*). The new model: **the deployment happens right from your local machine**, state is **stored locally and backed up to S3** (no CloudFormation), CloudFormation's stack/resource limits are gone, and the provider surface jumps to **150+ providers**. SST's own framing: *"The simpler deployment model has also led to far fewer gotchas."* The Ion CLI/engine is written in **Go** (`sst/ion` → now `sst/sst`).

The mental model is closest to **typed IaC-as-a-real-program** (Pulumi-style) with two ergonomic layers on top: **high-level "components"** that collapse dozens of low-level cloud resources into a few lines, and **resource Linking** that injects those resources — with generated types and auto-IAM — into your application runtime via an **`import { Resource } from "sst"`** SDK. Unlike Nitric/HoBo's *run-to-collect* IfC (declare a resource inline where you use it), SST keeps infra in the **config program** and **links** it into app code — more explicit and controllable, less "declare it where you use it."

| Dimension | SST (v3 "Ion") |
|---|---|
| Authoring | **Infrastructure-from-Code** in a typed **`sst.config.ts`** (TypeScript); infra is a program, linked into app runtime |
| Engine | **Pulumi + Terraform providers** (OSS only; no Pulumi account). v1/v2 were **CDK/CloudFormation** — replaced in v3 |
| Components | Built-in high-level `sst.aws.*` / `sst.cloudflare.*` (a Next.js app ≈ *"70 low-level AWS resources"* in a few lines) **+** raw low-level Pulumi/TF resources |
| Resources | Function (Lambda), Service/Task/Cluster (Fargate/ECS), Api/ApiGateway/AppSync/Realtime/Router, Bucket, Postgres/Aurora/Dynamo/Redis, Queue/SnsTopic, Cron, Vpc/Email/Efs, Secret, Auth, + framework sites (Nextjs/Remix/Astro/SvelteKit/SolidStart/Nuxt/StaticSite) |
| Linking | `link: [resource]` → injects links into the function package + **generates types** + **grants IAM permission**; runtime `Resource.X.*`. SDK: **JS/TS, Python, Go, Rust** |
| Permissions | `link` auto-grants; or manual `permissions: [{ actions, resources }]`; `sst.Linkable` to link arbitrary/custom values |
| Clouds | **AWS-centric** (deep `sst.aws.*`); Cloudflare partial; **150+ providers** as raw Pulumi/TF resources (Azure/GCP/Stripe/Vercel/Auth0/PlanetScale/…) |
| Local dev | **`sst dev` "Live"** — deploys **stub** Lambdas, **proxies real cloud invocations to your local machine** (AppSync Events + WebSocket), **<10ms** reload, **real AWS creds/IAM**; VPC via `sst tunnel` |
| State | **local state file (JSON)** + **"Home"** backend (`aws`\|`cloudflare`) → S3 `sst-state-<hash>` + SSM passphrase for secret encryption; latest **30 snapshots** |
| Deploy | `sst deploy --stage <name>` **from your machine** into your account; **stages** = environments (personal stage default) |
| Console | Optional **SaaS** (`console.sst.dev`): logs, zero-instrument **Issues**, resources view, update permalinks, **Autodeploy** (CodeBuild in *your* account) + PR preview envs |
| AI | **None** for infra (no MCP control surface, no agent identity, no generation) — SST's AI work is a separate coding agent (`opencode`), not infra automation |
| License / price | **MIT** OSS core; **Console** free ≤ 350 active resources, then **$0.086/resource** (≤2000) / **$0.032/resource** (>2000); personal/local stages free |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **`sst.config.ts`** | The single configuration file describing the whole application |
| **Component** | A high-level construct (`sst.aws.Function`, `sst.aws.Nextjs`) wrapping lower-level provider resources |
| **Linking** | The typed connection mechanism — link a bucket to a function and the function gets typed, permissioned access |
| **Stage** | The deployment scope, typically per developer and per environment |
| **Live** | Local development that proxies real cloud invocations to code running on the developer's machine |
| **Ion engine** | The v3 runtime, built on Pulumi and Terraform providers rather than CloudFormation |

The mental model is **typed links over 150+ providers**. Linking is the idea worth studying: one
declaration produces the connection, the permissions and the types, which is the same
one-declaration-three-effects instinct as Nitric's `.allow()`.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | One typed TypeScript config for the whole application |
| `typed-contracts` | **Linking** — typed, permissioned connections between resources |
| `wiring` | Links propagate outputs and access together |
| `environments` | Stages, including per-developer stages |

SST is a close product analog with a much larger provider reach than any pure-abstraction competitor,
because it inherits Pulumi's and Terraform's ecosystems rather than abstracting over them.

## Feature surface

### Infrastructure-from-Code — the `sst.config.ts` model

Your whole stack lives in one typed file. You instantiate **components** (which resolve to Pulumi/TF resources), wire them with plain code, and use `link` to expose them to your runtime:

```ts
// sst.config.ts
export default $config({
  app(input) {
    return { name: "my-app", home: "aws", providers: { aws: { region: "us-east-1" } } };
  },
  async run() {
    const bucket = new sst.aws.Bucket("MyBucket");
    const web = new sst.aws.Nextjs("MyWeb", { link: [bucket] });   // ~70 AWS resources, a few lines
    return { url: web.url };
  },
});
```

- **`app()`** declares the app **name**, the **`home`** (state) provider, and providers/regions. **`run()`** is the infra program (a real function — loops, conditionals, `if (stage === "production")` branching are just code).
- **Stages** are environments: `sst deploy --stage production`; with no stage you get a **personal stage** (stored in `.sst/stage`). This is imperative env-branching, not a declarative platform-rules layer.
- Infra is a **separate program** from your app; the bridge to runtime is **Linking** (below).

### Components — the catalog

SST distinguishes two kinds ([components docs](https://sst.dev/docs/components/)):

- **Built-in components** — high-level abstractions by the SST team, namespaced **`sst.aws.*`** / **`sst.cloudflare.*`**, that *"represent features in your app; like your frontends, APIs, databases, or queues"* and collapse many low-level resources (a Next.js frontend ≈ *"70 low-level AWS resources"*).
- **Provider components** — *"all the Pulumi/Terraform providers are supported"* as raw low-level resources (e.g. `new aws.s3.BucketV2(...)`) for granular control. These are **not** cloud-portable abstractions.

| Category | Built-in `sst.aws.*` components (representative) |
|---|---|
| **Compute / functions** | `Function` (Lambda — Node/Go official, Python/Rust community; `handler`, `runtime`, `memory`, `timeout`, `url`, `vpc`, `link`, `permissions`) |
| **Containers** | `Cluster` (ECS in a VPC) · `Service` (long-running Fargate; autoscaling, ALB/NLB/API-GW/CloudMap, `link`) · `Task` (Fargate one-off/batch) |
| **APIs / edge** | `Api` (API Gateway HTTP) · `ApiGatewayV1`/`V2` · `AppSync` (GraphQL) · `Realtime` (IoT/WebSocket) · `Router` (CloudFront routing to a URL / function / frontend / S3 bucket) |
| **Data** | `Bucket` (S3) · `Postgres` (RDS) · `Aurora` · `Dynamo` · `Redis` · `Efs` |
| **Messaging / jobs** | `Queue` (SQS) · `SnsTopic` · `Cron` |
| **Networking / misc** | `Vpc` · `Email` (SES) · `Secret` · `Auth` (OpenAuth-based) |
| **Frontends** | `Nextjs` · `Remix` · `Astro` · `SvelteKit` · `SolidStart` · `Nuxt` · `StaticSite` (S3+CloudFront) |

Each built-in component maps to **one or more Pulumi/TF resources**; the low-level provider resources remain available underneath as an escape hatch.

### Resource Linking + the SDK (SST's `.allow()` analog)

Linking is SST's headline DX — it connects the infra program to runtime code. You pass resources to a component's **`link`**:

```ts
const bucket = new sst.aws.Bucket("MyBucket");
new sst.aws.Function("MyFunction", { handler: "src/lambda.handler", link: [bucket] });
```

SST documents three effects of a link: **"The _links_ that the resource exposes are injected into the function package"**, **"The types to access these links are generated"**, and **"The function is given permission to access the linked resource."** At runtime you read them off a typed **`Resource`** object:

```js
import { Resource } from "sst";
console.log(Resource.MyBucket.name);   // typed, IDE-autocompleted
```

- **SDK languages:** *"The SDK currently supports JS/TS, Python, Golang, and Rust."* (Config authoring itself is **TypeScript-only**.)
- **Custom/arbitrary links:** `sst.Linkable` / `sst.Linkable.wrap()` link non-SST values (e.g. a third-party credential) into the same typed surface.
- **Manual IAM** (when link isn't enough): a `permissions` array of `{ actions, resources }`:

```ts
permissions: [{ actions: ["s3:GetObject", "s3:PutObject"], resources: ["arn:aws:s3:::my-bucket/*"] }]
```

So linking gives **auto-generated permissions + injected config + generated types** — SST's closest thing to Nitric/HoBo's inline `.allow()`, but declared in the **config program** rather than at the app-code point of use.

### Providers, state & the "Home" backend

- **Providers** — *"supports 150+ providers"* (AWS, Cloudflare, Azure, GCP, Stripe, Vercel, Auth0, PlanetScale, …). Add one with **`sst add <provider>`** (adds to config, installs packages, **registers the namespace globally** — *"Do not `import` the provider packages in your `sst.config.ts`"*). Versions are **pinned** and *"do not auto-update"* (`sst install` to update). Multi-region via multiple `new aws.Provider(...)` instances + `{ provider }`.
- **State** — *"SST creates a state file locally to keep track of the state of the infrastructure in your app"* (a JSON file, Pulumi-style). The **"Home"** is the cloud that stores state — *"aws and cloudflare are supported"* — which auto-adds itself as a provider. On AWS this is an **S3 bucket `sst-state-<hash>`** + an **SSM parameter `/sst/passphrase/<app>/<stage>`** whose passphrase **encrypts secrets** in state. SST **"keeps the latest 30 snapshots"** and prunes older ones with their event logs. **No Pulumi Cloud** dependency.

### Live development — `sst dev`

SST's most distinctive feature. `sst dev` runs the app in dev mode with **Live Lambda**: it deploys **stub** functions to AWS that **proxy real cloud invocations to your local machine**, execute them locally, and proxy the response back.

- Mechanism: *"It works by proxying requests from AWS to your local machine, executing it locally, and proxying the response back."* Transport is **AWS AppSync Events** over a **WebSocket**; local execution runs as a Node.js Worker; **"changes are reloaded in under 10ms"** with no redeploy.
- **High fidelity:** it uses **real AWS credentials**, so **IAM permission failures happen locally** just like prod; it sets **`SST_DEV=true`** for conditional logic; VPC resources are reachable via a tunnel (`sudo sst tunnel install`).
- **Frontends** (Nextjs/Remix/Astro/…) start their **own dev server in a separate tab** and are **not deployed** during `sst dev`.
- **Caveat:** *"Only use `sst dev` in your personal stage"* — the stubs persist if the CLI dies, causing timeouts on later deploys; and there is **no fully-offline mode** (Live needs a real AWS account + deployed stubs).

### Console, Autodeploy & pricing

The **SST Console** (`console.sst.dev`) is an **optional SaaS** dashboard:

- **Logs** (CloudWatch, searchable) · **Issues** — real-time error tracking for Node Lambda/containers with **"Nothing to setup, no code to instrument"**, automatic **source maps**, and Slack/email alerts · **Resources** view (full state + relationships + outputs) · **Updates** (per-deploy permalink + modified-resource list + build logs) · **Local logs** from `sst dev`.
- **Autodeploy** — git-based CI/CD: *"can auto-deploy your apps when you git push to your GitHub repo"* using **AWS CodeBuild in your own account**; branch/PR **preview environments**; configured via `console.autodeploy.*` callbacks in `sst.config.ts`.
- **Pricing** — free for workspaces with **"350 active resources or fewer"**; then **"$0.086 per resource"** for the first 2000 active resources/mo and **"$0.032 per resource"** above 2000. "Active" = a stage that has existed **≥2 weeks** and was updated that month; **personal/local stages are free**. **SaaS-only today**; a self-hostable version is described as *"planned"* but not shipped.

### CLI

```bash
sst init                     # create sst.config.ts in the current project
sst dev                      # Live dev (stub + proxy to local); deploys to personal stage
sst deploy [--stage <name>]  # deploy from your machine into your account
sst diff                     # preview changes before deploy
sst remove                   # tear down the app's resources
sst add <provider>           # add + install + register a provider
sst install                  # install/update pinned providers from config
sst secret set|remove|load|list   # manage encrypted secrets
sst shell                    # run a command with all linked resources in the env
sst state edit|export|list|remove|repair   # manage state
sst refresh                  # reconcile local state with cloud reality
sst unlock                   # release a stuck deploy lock
sst tunnel                   # VPC connectivity for Live dev
sst cert | diagnostic | version | upgrade | telemetry
```

Stages come from `--stage`, `SST_STAGE`, or the personal stage in `.sst/stage`.

## Architecture

- **Engine** — Ion, built on Pulumi's engine and the Terraform provider ecosystem, giving 150+
  providers without SST writing them.
- **Execution** — evaluate `sst.config.ts`, produce a resource graph, reconcile through the engine.
- **Live development** — cloud events are proxied to locally-running code, so a real Lambda invocation
  executes on the developer's laptop. This is a genuinely distinctive local-development mechanism.
- **State authority** — the engine's state, with SST managing stage separation.
- **Portability boundary** — provider reach is enormous; the *abstraction* is AWS-centric, because
  the high-level components are mostly AWS shapes.

## Where SST is stronger

> Shipped, evidenced capability only.

### what SST does well

- **Typed IaC-as-a-real-program on Pulumi/TF, MIT-licensed, no vendor state** — 150+ providers, deploys **from your machine into your account**, state local + S3 (**no Pulumi Cloud**, no CloudFormation limits). A clean OSS core.
- **Best-in-class high-level components for full-stack** — a Next.js/Remix/Astro app, a Fargate `Service`, a `Postgres`, an S3 `Bucket`, or a Stripe product in a few lines; a frontend component hides ~70 low-level resources. Genuine **full-stack** (frontend + container + serverless + data) in one config.
- **Linking + the typed `Resource` SDK** — inject config, generate types, and auto-grant IAM from one `link`, consumable in **JS/TS/Python/Go/Rust**. Excellent, low-ceremony resource binding.
- **Live Lambda dev (`sst dev`)** — genuinely novel: **proxy real cloud invocations to your local machine**, **<10ms** reload, **real IAM** in the loop. A high bar for local↔cloud fidelity that few match.
- **Console value in your own account** — zero-instrument **Issues** (auto errors + source maps), searchable logs, and **Autodeploy via CodeBuild in your account** with PR preview envs — CI/CD without shipping code to a vendor runtime.
- **Escape hatch is total** — any raw Pulumi/TF resource is one line away, so you're never boxed in by the high-level components.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### SST's limits — HoBo's opening

- **AWS-centric, not cloud-agnostic — despite "150+ providers."** The high-level portable components are overwhelmingly **`sst.aws.*`** (Cloudflare partial); the other 150 providers are **raw, provider-specific Pulumi/TF resources with no cross-cloud abstraction**. So SST is **multi-*provider*** (you can talk to anything) but **not multi-*cloud*** (the *same app* doesn't retarget clouds without rewriting to different resources). HoBo's ports have **cross-cloud equivalence classes** — one `bucket`/`sql`/`queue` maps to S3/GCS/Blob, RDS/Cloud SQL/Azure PG, etc. ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[ADR-0006](../design/adr/01-architecture-core.md#adr-0006)).
- **Pulumi-welded engine — no pluggable IaC.** SST *is* Pulumi (+ TF-via-Pulumi); you can't swap to Crossplane/OpenTofu/provider-native. HoBo keeps **IaC behind a port** — Pulumi is the *primary adapter*, with Crossplane/OpenTofu alongside ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0069](../design/adr/01-architecture-core.md#adr-0069)).
- **State is Pulumi snapshots, not an event-sourced control plane.** Local state + S3 + 30 snapshots gives *what* the infra is, not an auditable **who/why/when** you can replay. No event-sourcing, no time-travel, **no policy / `can-deploy` / contracts plane, no cost plane**. HoBo's control plane is **event-sourced + replayable** ([Plan 11](../design/data-plane.md#plan-11)/[Plan 29](../design/contracts-policy-flags.md#plan-29)).
- **No platform-rules layer.** Component→resource mapping is fixed; "different infra per environment" is **imperative `if (stage===…)`** branching in the config program, not a recorded decision. HoBo adds **Resource Definitions + Matching** so a cheap-preview vs managed-HA-prod realization is an auditable **`match.Decided`** ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)), cost-routed by the **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **No AI-native story at the infra layer.** No MCP control surface, no agents-as-principals, no AI-generated providers/impls, no self-healing/trainable functions. (SST's AI energy is `opencode`, a standalone coding agent — orthogonal to the infra platform.) This is HoBo's entire thesis: generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)), agents with SVIDs + `@hobo/mcp` ([Plan 6](../design/ai-native-agent-auth.md#plan-06)), `"use training"` methods.
- **No reactive / live-query data model.** SST provisions Postgres/Dynamo/etc.; there's no Convex-style `useQuery()` that re-runs on write. HoBo has a first-class reactive read model ([Plan 32](../design/data-plane.md#plan-32)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)).
- **Console is SaaS-only + per-resource pricing.** Autodeploy/Issues/logs/preview envs live in the paid Console; self-host is *"planned,"* not shipped; cost scales with resource count ($0.086/resource). HoBo's **Yard is itself a Bindle** (self-host = hosted parity, [Plan 4](../design/control-plane.md#plan-04)); metering/showback is **OSS FinOps**, no billing ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)).
- **Config authoring is TypeScript-only.** `sst.config.ts` must be TS (runtime SDK covers 4 languages, but the infra program doesn't). HoBo authors against **language-neutral WIT** in any Component-Model language ([Plan 20](../design/wasm-runtime-wit.md#plan-20)).
- **Live dev needs a real cloud + deployed stubs.** `sst dev` is high-fidelity but **can't run fully offline** and mutates a real account; there's no labeled simulate/mock tier. HoBo formalizes a **fidelity matrix** (simulate/mock/Camp-only) with **`hobo verify`** splitting local vs Camp checks ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)).
- **Greenfield-leaning; no adopt-in-place.** Onboarding means writing `sst.config.ts` (you *can* wrap raw providers, but there's no **estate import**). HoBo's **`hobo import`** adopts existing TF/Pulumi/Lakebed/FaaS estates in place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **No multi-tenant-app primitives, no cross-cloud data migration/consistency.** Same shape as Encore — a SaaS builder rolls their own tenancy; single-account means no portability/consistency model. HoBo ships tenancy ([Plan 50](../design/security-networking.md#plan-50)) + app-data migration ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) + cross-Camp consistency ([ADR-0040](../design/adr/01-architecture-core.md#adr-0040)).

## Adversarial critique

- **AWS-centric despite multi-provider reach.** 150+ providers is the engine's reach; SST's
  opinionated components are predominantly AWS, so "multi-cloud" describes what it *can* touch, not
  what it makes easy.
- **The abstraction layers are stacked.** SST over Pulumi over Terraform providers means three
  systems' failure modes and version skews arrive together, and debugging crosses all of them.
- **v2-to-v3 was a substantial change.** The move from CDK/CloudFormation to Ion changed the
  underlying engine, which is the fourth generational-rewrite instance in this corpus.
- **Linking is excellent and AWS-shaped.** The permissions half of a link is IAM; the pattern does not
  transfer cleanly to providers with different authorization models.
- **Live development is clever and leaky** — real cloud triggers hitting local code is superb for
  iteration and not the same as running in the cloud.
- **A configuration file is still a manifest.** Compared with declaring resources where they are used
  (Nitric, Encore), SST keeps a separate description of the world.

### Comparisons with adjacent tools

- **vs HoBo:** SST is **typed-IaC-as-a-Pulumi-program + rich full-stack components + Live dev**, **AWS-centric**, with **no AI/agents, no event-sourcing, no reactive data, no platform-rules layer, no pluggable IaC**. HoBo is **agnostic ports + pluggable IaC under an IfC layer + a language-neutral wasm runtime + event-sourced governance + AI-native depth**. SST is the sharpest validation that **Pulumi/TF as the provisioning substrate + Linking-style typed resource binding + local-first deploy** are right — HoBo adopts all three and keeps the IaC engine behind a port.
- **vs Nitric:** both are "cloud-ish IfC," but differently — **Nitric** is *run-to-collect* with **truly portable ports** (one app → AWS/GCP/Azure/K8s, no rewrite); **SST** is an *explicit Pulumi program*, **AWS-centric**, with **richer full-stack components + Live dev**. Nitric's own docs frame it: *"SST is AWS + Pulumi, opinionated full-stack AWS."* HoBo takes Nitric's portable ports **and** SST's component/full-stack ergonomics.
- **vs Encore:** both **deploy into your own cloud account** with great local DX. **Encore** parses infra declarations with its **compiler** (IfC, opinionated, AWS/GCP, real-infra local, Rust runtime); **SST** builds an explicit **Pulumi** graph (150+ providers, Live-Lambda local). Encore *owns* provisioning via its compiler; SST via Pulumi. Neither is truly multi-cloud-portable or AI-native.
- **vs Pulumi / CDK / Terraform:** SST is a **higher-level, opinionated layer *on top of* Pulumi** (itself on TF providers). v3 explicitly **replaced CDK/CloudFormation** to escape CFN's stack/resource limits and slow, cloud-side deploys. It's "**IaC with batteries + app-linking + Live dev**," not a new IaC engine. HoBo agrees with "keep IaC, add an IfC layer" — but treats the engine as a **swappable adapter**, not the foundation.
- **vs Convex/Supabase:** SST gives you **infrastructure**, not a batteries-included reactive backend — no live queries, no built-in auth/data conventions beyond the components you wire. Closer to HoBo's "compose it from ports" stance than to Convex's single-backend model.

**Net:** SST is one of HoBo's closest **product-shaped** competitors on **authoring ergonomics + local DX**, and — like Encore — the gap is **everything HoBo adds around the IfC/IaC core**: genuine cloud-agnostic portable ports, pluggable IaC, a language-neutral wasm runtime, Resource Definitions/Matching + the Dispatcher, event-sourced governance (cost/policy/contracts), a reactive data plane, cross-cloud data, multi-tenant-app primitives, adopt-in-place import, and AI-native depth (generation pipeline, agents-as-principals, trainable functions).

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each SST concept (✅ has · ➕ goes further · 🔜 planned). HoBo design lives in [`../design/`](../design/index.md).

| SST concept | HoBo equivalent | Notes |
|---|---|---|
| **Infrastructure-from-Code** (`sst.config.ts`, one program defines the stack) | **IfC authoring** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[Plan 2](../design/sdk-api.md#plan-02)) | ✅ same thesis; ➕ HoBo declares resources **inline at point-of-use** (run-to-collect) rather than a separate config program |
| Built-in components (`sst.aws.*` / `sst.cloudflare.*`) | HoBo resource catalog as **WIT ports** with equivalence classes ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ near 1:1 on the catalog; ➕ ports are cross-cloud, not per-provider |
| Raw Pulumi/TF provider resources (`aws.s3.BucketV2`) | typed **`.with(...)` escape hatch** / provider-native pins ([ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ✅ same "drop to provider-native" power, without leaving the agnostic model |
| **Pulumi + Terraform** engine (welded in) | `iac-pulumi` (primary) **+ Crossplane / OpenTofu** adapters behind a port ([Plan 4](../design/control-plane.md#plan-04)/[ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) | ➕ the IaC engine is a swappable adapter, not the substrate |
| **Linking** (`link:[…]` → inject config + generate types + grant IAM) | triple-effect **`.allow()`** (IAM + wasm capability link + agent-token scope) ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅/➕ one declaration, three effects; declared **at point of use** |
| `import { Resource } from "sst"` (typed runtime SDK, JS/TS/Py/Go/Rust) | checked-in **`_generated/`** typed bindings (`ctx.bindings`, WIT-generated clients) ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)) | ✅/➕ generated from WIT+Zod+`.allow()`+graph; `hobo codegen --check` drift gate |
| `permissions:[{actions,resources}]` manual IAM | provider-native pins via `.with()` + policy plane ([Plan 29](../design/contracts-policy-flags.md#plan-29)) | ✅ |
| `Function` (Lambda) / `Service`·`Task`·`Cluster` (Fargate) | **wasm/wasi components by default** (`hobo:job`, IaaS `vm`/`microVm`) + **OCI container** runtime provider ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ➕ polyglot wasm-first; containers as a fallback host |
| `Api`/`ApiGateway`/`AppSync` + `Realtime` (WebSocket) | `hobo:http`/`wasi:http` + `hobo:websocket` (preview `wasi:websocket`) ([ADR-0075](../design/adr/07-portability-extensibility.md#adr-0075)) | ✅ |
| `Router` (CloudFront routing/CDN) | **Yard-level `domain`** + multi-cloud ingress + policy DNS ([ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035)) | ➕ multi-cloud ingress, not single-CDN |
| `Bucket`/`Postgres`/`Aurora`/`Dynamo`/`Redis`/`Queue`/`SnsTopic`/`Cron` | `wasi:blobstore` / `hobo:data` / `wasi:keyvalue` / `hobo:queue` / `wasi:messaging` / `hobo:scheduler` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ near 1:1, cross-cloud |
| *(none — raw Postgres/Dynamo)* | **paradigm taxonomy + opt-in packages** `@hobo/sql`/`vector`/`graph`/`document` ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)/[ADR-0081](../design/adr/03-data-plane.md#adr-0081)) | ➕ typed abstractions across SQL **and** vector/graph/document |
| *(none — no reactive reads)* | **reactive `query()` / `useQuery()` live subscriptions** ([Plan 32](../design/data-plane.md#plan-32)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ➕ Convex-style live queries over the event log |
| `Auth` component (OpenAuth) | **federate + verify `auth()` port** (`hobo:auth`, OIDC/JWT from any IdP) ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)) | ✅/➕ unified principal model + policy authz |
| `Secret` + SSM passphrase | `wasi:config/store` + `hobo:secrets` (brokered, app never holds material) ([ADR-0113](../design/adr/02-identity-security.md#adr-0113)) | ✅/➕ secretless |
| **Fixed** component→resource mapping; `if(stage===…)` branching | **Resource Definitions + Matching** (`match.Decided`) + Dispatcher ([Plan 25](../design/platform-engineering.md#plan-25)/[ADR-0033](../design/adr/01-architecture-core.md#adr-0033)/[ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ same app → different infra per env, auditable + cost-routed |
| **`sst dev`** Live Lambda (stub + proxy real cloud → local, <10ms, real IAM) | `hobo dev` on `runtime-local` + **fidelity matrix** ([Plan 7](../design/developer-experience.md#plan-07)/[ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) | ✅/➕ HoBo labels simulate/mock/Camp-only + `hobo verify`; SST's live-proxy fidelity is a bar HoBo's Camp-only tier matches |
| State = local file + **"Home"** (S3/CF) + 30 snapshots | **event-sourced control plane** + replay/audit ([Plan 11](../design/data-plane.md#plan-11)/[Plan 14](../design/reliability-observability-cost.md#plan-05)) | ➕ who/why/when, replayable — not just current-state snapshots |
| **Console** (logs, Issues, resources, updates) | dashboard + observability + operations dashboard/status ([Plan 7](../design/developer-experience.md#plan-07)/[Plan 5](../design/reliability-observability-cost.md#plan-05)/[Plan 49](../design/developer-experience.md#plan-49)) | ✅/➕ multi-cloud fleet view; self-host = hosted parity |
| **Autodeploy** (CodeBuild in your account) + PR preview envs | **Deployment Sets/Deltas** + **ephemeral/preview Camps** ([Plan 25](../design/platform-engineering.md#plan-25)) | ✅ event-sourced promote/rollback |
| Console **SaaS-only**, per-resource pricing | **Yard-is-a-Bindle** self-host ([Plan 4](../design/control-plane.md#plan-04)); OSS FinOps metering, no billing ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ➕ self-host = hosted parity |
| TS-only config (SDK: JS/TS/Py/Go/Rust) | language-neutral **WIT** runtime, any wasm language ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ➕ |
| *(none — no MCP/agent/generation)* | **agents-as-principals + `@hobo/mcp`** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) + **generation pipeline** ([Plan 23](../design/generated-stack.md#plan-23)) + trainable functions | ➕ HoBo's core AI-native differentiators |
| *(none — greenfield)* | **`hobo import`** adopt-in-place migration ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ adopt existing TF/Pulumi/FaaS estates incrementally |
| *(none)* | **Multi-tenant-app primitives** ([Plan 50](../design/security-networking.md#plan-50)) · **cross-cloud data** ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)/[ADR-0040](../design/adr/01-architecture-core.md#adr-0040)) | ➕ |

### SST-as-validation, and the borrowings HoBo takes

SST validates three HoBo bets at production scale: **(1) Pulumi/TF as the provisioning substrate** — exactly HoBo's primary IaC adapter ([Plan 4](../design/control-plane.md#plan-04)), except HoBo keeps it behind a port rather than welding to it; **(2) typed resource *Linking*** — inject config + generate types + auto-IAM from one declaration — which HoBo generalizes into triple-effect `.allow()` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) + checked-in `_generated/` bindings ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037)); and **(3) local-first deploy with real-cloud fidelity** (`sst dev` proxying real invocations to your machine) — a strong argument for HoBo's Camp-only fidelity tier ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)). The one ergonomic HoBo explicitly does **not** copy is SST's **infra-as-a-separate-program**: HoBo declares resources **inline where they're used** (Nitric-style run-to-collect), so there's no config↔app split to keep in sync.

### The one-line takeaway

**SST proves HoBo's Pulumi/TF substrate + typed-linking DX + local-first-with-real-cloud-fidelity in production** — but is **AWS-centric, Pulumi-welded, snapshot-stated, and not AI-native**, with no portable cross-cloud ports, no platform-rules layer, no reactive data, and a SaaS-only Console. HoBo's differentiation is the surrounding system: **genuinely cloud-agnostic ports + pluggable IaC, a language-neutral wasm runtime, Resource Definitions/Matching + the Dispatcher, a reactive data plane + broad data paradigms, event-sourced governance (cost/policy/contracts), cross-cloud data, multi-tenant-app primitives, adopt-in-place import, and AI-native depth.**

## Better-together / integration posture

- **Borrow** — **Linking**, which is the clearest expression in this cohort of one declaration
  producing connection, permission and types together, and **Live-style local development**, where
  real cloud events drive local code.
- **Benchmark** on provider reach and on the local iteration loop.
- **Displace** for the TypeScript full-stack team, honestly.
- Not an adopt or provider target — though the *strategy* of standing on Pulumi's engine rather than
  reimplementing it is one HoBo's adapter model already shares.

## Threats and lessons

1. **Standing on an existing engine buys an ecosystem instantly.** SST did not write 150 providers;
   it inherited them. HoBo's pluggable-adapter position (ADR-0006) is the same bet and should be
   argued in those terms.
2. **Typed linking is the ergonomic to match** — third occurrence of the one-declaration-multiple-
   effects pattern after Nitric's `.allow()` and Amplify's generated types.
3. **Fourth generational rewrite in this corpus.** Products in this category rewrite their engines,
   and adopters pay. A stable IR is a competitive asset.
4. **Local development that touches real cloud events** is a differentiated experience HoBo has no
   equivalent for.

## Sources

- [sst.dev/docs](https://sst.dev/docs/) — `sst.config.ts`, components, linking, stages, Live
- [sst/sst](https://github.com/sst/sst) — source, Ion engine, provider integration

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Current component coverage and provider counts were not re-verified in
this pass and are not asserted.
