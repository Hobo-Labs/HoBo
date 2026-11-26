---
type: Competitive Reference
title: "AWS Amplify — competitor reference"
description: "AWS Amplify is **AWS's fullstack app platform**; since **Amplify Gen 2** (GA May 2024) its backend is a *\"TypeScript-based, code-first developer experience (DX) for defining backends\"* — declare auth, data, storage, and fun"
tags: [hobo, competitors]
competitor:
  slug: aws-amplify
  name: "AWS Amplify"
  aliases: ["amplify gen 2"]
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code, backend-data-platforms, cloud-application-platforms]
  directness: overlapping
  role: "Gen-2 code-first TypeScript fullstack backend on AWS CDK — IfC-in-TS analog, AWS-only"
  posture: [benchmark]
  hobo_surface: [authoring, typed-contracts, wiring]
  evidence: mixed
  status: active
  research_date: 2026-08-19
  contract: v1
  sources:
    - https://docs.amplify.aws/
    - https://aws.amazon.com/amplify/
---

# AWS Amplify — competitor reference

> A faithful capture of **AWS Amplify** for HoBo competitive analysis. Amplify **Gen 2** is — alongside Encore — the **closest *authoring* analog** to HoBo: **infrastructure-from-code in TypeScript** (`defineBackend`/`defineData`/`defineAuth`/`defineStorage`/`defineFunction`) that, **layered on AWS CDK**, synthesizes and provisions a whole fullstack backend, plus a Git-driven fullstack-branch hosting product and a UI component library. The decisive contrast: Amplify is **AWS-only**, **CDK-bound**, with a **fixed resource→service mapping** (Data→AppSync+DynamoDB, Auth→Cognito, Storage→S3) — where HoBo is multi-cloud + pluggable-IaC + wasm + auditable Matching. Sources: [docs.amplify.aws](https://docs.amplify.aws/) · [aws.amazon.com/amplify](https://aws.amazon.com/amplify/) · [aws.amazon.com/amplify/pricing](https://aws.amazon.com/amplify/pricing/) · [Amplify Hosting user guide](https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html) · [github.com/aws-amplify/amplify-backend](https://github.com/aws-amplify/amplify-backend) · [ui.docs.amplify.aws](https://ui.docs.amplify.aws/) · [Gen 2 GA blog](https://aws.amazon.com/blogs/mobile/amplify-gen2-ga/). License **Apache-2.0** (framework + CLI + Amplify UI OSS; **Amplify Hosting and every provisioned AWS service are paid AWS usage**). Researched July 2026; API/CLI/pricing shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

AWS Amplify is **AWS's fullstack application platform**. Since **Amplify Gen 2** (GA **May 6, 2024**) the backend is a **"TypeScript-based, code-first developer experience (DX) for defining backends"** — you *"deploy cloud infrastructure by simply expressing your app's data model, business logic, authentication, and authorization rules completely in TypeScript."* You author files under a convention (`amplify/auth/resource.ts`, `amplify/data/resource.ts`, `amplify/storage/resource.ts`, `amplify/functions/*/resource.ts`) and compose them in **`amplify/backend.ts`** with **`defineBackend({ auth, data, storage })`**. Amplify is **"layered on top of AWS Cloud Development Kit (CDK)"** — Data and Auth wrap **L3 AWS CDK constructs** — so the TypeScript declarations synthesize to CloudFormation and provision the matching AWS managed services, and you can drop to raw CDK for anything Amplify doesn't cover.

The mental model is **infrastructure-from-code (IfC)**, the same authoring thesis HoBo adopts ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) — declare what the app needs in the same TypeScript you build with, and the platform provisions it. This makes Amplify Gen 2 a **genuinely close authoring analog to HoBo** (and to Encore). The crucial difference is the *target and the mapping*: Amplify emits **only AWS**, via **only CDK/CloudFormation**, with a **fixed** resource→service mapping — `defineData` always becomes **AWS AppSync (GraphQL) + Amazon DynamoDB**, `defineAuth` always becomes **Amazon Cognito**, `defineStorage` always becomes **Amazon S3**, `defineFunction` always becomes **AWS Lambda (Node/TypeScript)**. There is no notion of "the same app, a different cloud, a different IaC engine, or a different backing service."

Two things Amplify ships that HoBo (design-phase) does not yet: a **fullstack Git-branch hosting product** (**Amplify Hosting**: connect a repo, each branch gets its own frontend build **and its own backend stack**, with PR previews and SSR) and a **UI component library** (**Amplify UI**: themeable, cloud-connected React/Vue/Angular/Flutter/Swift/Android components such as `Authenticator`, `FileUploader`, `StorageImage`). Both are mature and shipping at AWS scale.

| Dimension | AWS Amplify |
|---|---|
| Authoring | **Infrastructure-from-code in TypeScript** — `defineBackend`/`defineData`/`defineAuth`/`defineStorage`/`defineFunction` under `amplify/`, **layered on AWS CDK** (synth → CloudFormation) |
| Backend resources | **Data** (AppSync GraphQL + DynamoDB) · **Auth** (Cognito) · **Storage** (S3) · **Functions** (Lambda) · custom queries/mutations · scheduled functions · **any AWS service via the CDK escape hatch** |
| Data model | `a.schema({ Todo: a.model({…}).authorization(allow => […]) })`; every `a.model()` "automatically creates … a DynamoDB table … [and] query and mutation APIs" on AppSync; typed generated client (`client.models.Todo`, real-time `observeQuery`) |
| Auth | `defineAuth({ loginWith: { email, phone, externalProviders: Google/Facebook/Amazon/Apple/SAML/OIDC } })` → **Amazon Cognito**; MFA, groups, passwordless (email/SMS OTP, WebAuthn passkeys) |
| Authorization | per-model/field `.authorization(allow => [...])` — `allow.publicApiKey()`/`owner()`/`authenticated()`/`guest()`/`groups()`; Storage path rules `allow.authenticated.to(['read','write'])`, `allow.entity('identity')` |
| Runtime | AWS-managed services (AppSync · DynamoDB · Cognito · S3 · Lambda); custom logic in **TypeScript/Node Lambda** handlers |
| Local dev | **per-developer cloud sandbox** `npx ampx sandbox` — deploys a **real, isolated backend to your AWS account**, watches `amplify/`, hot-swaps on save ("up to 8× faster" iterative updates); **no local emulation of AWS** |
| CLI | **`ampx`** (`@aws-amplify/backend-cli`) — `sandbox` (+ `secret`/`seed`/`delete`), `pipeline-deploy`, `generate outputs`/`graphql-client-code`/`forms`/`schema-from-database`, `info` |
| Clouds | **AWS only** |
| Hosting / deploy | **Amplify Hosting** — Git CI/CD (GitHub/GitLab/Bitbucket/CodeCommit), **fullstack per-branch environments** (frontend build **+ its own backend stack**), PR previews, **SSR** (Next.js/Nuxt/Astro/SvelteKit + custom adapter), global CDN, custom domains, atomic deploys, password-protected branches |
| Frontend | **Amplify UI** — themeable React/Vue/Angular/Flutter/Swift/Android components incl. connected `Authenticator`, `FileUploader`, `StorageImage` |
| AI | *(no first-class AI/agent surface in the framework)* |
| License / price | Framework OSS (**Apache-2.0**, `aws-amplify/amplify-backend`); **Hosting metered** (build min · CDN · SSR); **backend AWS usage billed separately** at standard AWS rates |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Backend definition** | TypeScript files under `amplify/` declaring auth, data, storage and functions |
| **`defineData` / `defineAuth` / `defineStorage` / `defineFunction`** | The typed declaration functions that constitute the Gen-2 authoring surface |
| **Sandbox** | A per-developer cloud backend, deployed from the same definition |
| **Generated client** | Fully typed client code derived from the backend schema |
| **Branch environment** | A deployed backend per Git branch |

The mental model is **TypeScript in, CDK out**: developers declare a backend in typed TypeScript,
Amplify synthesizes AWS CDK constructs, and CloudFormation provisions them. The generated typed
client closing the loop back into the application is the part that is genuinely excellent.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | **Direct.** Typed TypeScript declaration of backend resources is HoBo's authoring thesis, implemented for one cloud |
| `typed-contracts` | Schema-derived types flow from backend declaration into client code |
| `wiring` | Resources reference each other in TypeScript with type checking |
| `environments` | Per-developer sandboxes and per-branch backends |

Amplify is the closest shipped thing to HoBo's authoring model, deliberately restricted to AWS —
which makes it the cleanest available test of whether the authoring idea works in practice. It does.

## Feature surface

### Infrastructure-from-code — the `defineBackend` loop

Resources are declared as typed objects in convention files and composed in `amplify/backend.ts`. `defineBackend` returns a handle whose sub-resources expose the underlying CDK constructs (the escape hatch, below).

```typescript
// amplify/backend.ts
import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';

const backend = defineBackend({ auth, data, storage });
```

Amplify **synthesizes** these declarations through AWS CDK into CloudFormation and provisions the matching AWS services; **"Gen 2 automatically generates your types without the explicit codegen step."**

### Amplify Data — AppSync GraphQL + DynamoDB, typed end-to-end

```typescript
// amplify/data/resource.ts
import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  Todo: a
    .model({ content: a.string(), isDone: a.boolean() })
    .authorization((allow) => [allow.publicApiKey()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'apiKey',
    apiKeyAuthorizationMode: { expiresInDays: 30 },
  },
});
```

Per the docs, **"every `a.model()` automatically creates the following resources in the cloud: a DynamoDB database table to store records [and] query and mutation APIs"** on **AWS AppSync**, with **real-time subscriptions**. The frontend uses a generated, fully-typed client:

```typescript
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../amplify/data/resource';

const client = generateClient<Schema>();
await client.models.Todo.create({ content: 'buy milk' });
client.models.Todo.observeQuery().subscribe({ next: ({ items }) => { /* live-updating */ } });
```

Authorization is expressed **per model/field** via the `allow` builder — `allow.publicApiKey()`, `allow.owner()`, `allow.authenticated()`, `allow.guest()`, `allow.groups([...])` — this is Amplify's direct analog to HoBo's `.allow()`. Amplify Data can also front an **existing SQL database** (RDS/Aurora MySQL/PostgreSQL) via `ampx generate schema-from-database`, but the **default, first-class model is DynamoDB (NoSQL)**.

### Amplify Auth — Cognito

```typescript
// amplify/auth/resource.ts
import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: true,
    externalProviders: {
      google: { clientId: secret('GOOGLE_CLIENT_ID'), clientSecret: secret('GOOGLE_CLIENT_SECRET') },
      callbackUrls: ['http://localhost:3000/'],
      logoutUrls: ['http://localhost:3000/'],
    },
  },
});
```

**"Amplify Auth is powered by Amazon Cognito"** — user registration, sign-in, account recovery, external providers (Google/Facebook/Amazon/Apple/SAML/OIDC), MFA, groups, and passwordless (email/SMS OTP, WebAuthn passkeys). `defineFunction` handlers can be attached as **Cognito triggers** (pre-sign-up, post-confirmation, etc.).

### Amplify Storage — S3

```typescript
// amplify/storage/resource.ts
import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'amplifyTeamDrive',
  access: (allow) => ({
    'profile-pictures/{entity_id}/*': [
      allow.guest.to(['read']),
      allow.entity('identity').to(['read', 'write', 'delete']),
    ],
    'picture-submissions/*': [
      allow.authenticated.to(['read', 'write']),
      allow.guest.to(['read', 'write']),
    ],
  }),
});
```

**"Built on top of Amazon Simple Storage Service (Amazon S3)"** — path-scoped access rules keyed by role (`guest`/`authenticated`/`entity('identity')`) with verb lists.

### Amplify Functions — Lambda, and custom resolvers

```typescript
// amplify/functions/say-hello/resource.ts
import { defineFunction } from '@aws-amplify/backend';
export const sayHello = defineFunction({ name: 'say-hello', entry: './handler.ts' });
```

```typescript
// amplify/functions/say-hello/handler.ts
import type { Handler } from 'aws-lambda';
export const handler: Handler = async (event, context) => 'Hello, World!';
```

Functions are **"powered by AWS Lambda"**, authored/consumed in TypeScript, and wire into Data as **custom query/mutation resolvers**:

```typescript
sayHello: a.query()
  .arguments({ name: a.string() })
  .returns(a.string())
  .handler(a.handler.function(sayHello)),
// → client.queries.sayHello({ name: 'Amplify' })
```

They also serve as **auth triggers**, REST handlers, and **scheduled jobs** (cron/rate schedules).

### CDK escape hatch — the "no ceiling within AWS" story

Because Amplify **is** CDK underneath, you can add any AWS resource and reach into Amplify-generated constructs:

```typescript
const backend = defineBackend({ auth, data, storage });
const customStack = backend.createStack('MyCustomResources');   // dedicated CFN stack
new sqs.Queue(customStack, 'CustomQueue');                      // any aws-cdk-lib / Construct Hub construct

// reach underlying L1/L2/L3 constructs Amplify generated:
backend.data.resources.tables['Todo'];      // the DynamoDB table
backend.auth.resources.userPool;            // the Cognito user pool

backend.addOutput({ custom: { topicArn: '...' } });   // expose values to the frontend config
```

This is the mechanism that makes Amplify **AWS-deep** — but it is also **AWS-bound**: the escape hatch is *more CDK*, never a different cloud or IaC engine.

### `ampx` CLI, sandbox & CI/CD

```bash
npx ampx sandbox                 # deploy a personal cloud sandbox; watch amplify/ + redeploy on save
npx ampx sandbox --once          # single deploy, no file watching
npx ampx sandbox --name feature  # a named/second sandbox (--identifier); also --stream-function-logs, --profile
npx ampx sandbox secret set …    # manage per-sandbox backend secrets
npx ampx sandbox seed            # seed the sandbox with data
npx ampx sandbox delete          # tear the sandbox down

npx ampx pipeline-deploy --branch main --app-id …   # deploy a branch backend in CI/CD
npx ampx generate outputs                 # write amplify_outputs.json (client config)
npx ampx generate graphql-client-code     # GraphQL statements + types
npx ampx generate forms                   # React form components from the data model
npx ampx generate schema-from-database    # TS schema from an existing SQL DB
npx ampx info                             # environment diagnostics
```

The **sandbox** is the local loop: it provisions a **real, isolated backend into the developer's AWS account** (not a local emulator) and hot-swaps on save — high fidelity by construction, but it **requires cloud credentials and incurs AWS usage**, and there is **no offline/local emulation** of AppSync/DynamoDB/Cognito.

### Amplify Hosting — Git CI/CD, fullstack branches, SSR

Amplify Hosting is a **"Git-based workflow for hosting full-stack serverless web applications with continuous deployment"** onto the AWS CDN. You connect a repo (**GitHub / GitLab / Bitbucket / AWS CodeCommit**); then:

- **Fullstack per-branch environments** — each connected branch builds the frontend **and provisions its own backend stack**; **"all you have to do to get this app shared with a URL is to commit this to git and push to the origin."** Production and staging are just branches.
- **Pull-request previews** — ephemeral preview environments per PR.
- **SSR** — Next.js and Nuxt first-class; Astro/SvelteKit via community adapters; "any SSR framework with a custom adapter." SPA (React/Angular/Vue/Ionic/Ember) and SSG (Gatsby/Hugo/Jekyll/Eleventy/VuePress) supported.
- **Custom domains, atomic deployments, password-protected branches, redirects/rewrites, end-to-end tests.**

### Amplify UI — connected component library

**"A collection of accessible, themeable, performant React (and more!) components that can connect directly to the cloud."** Connected components collapse cloud workflows to a tag: **`Authenticator`** (full sign-up/sign-in/MFA flow over Cognito), **`FileUploader`** (formerly `StorageManager`, S3 uploads), **`StorageImage`** (render S3 objects), plus primitives (Button/Badge/…) and themes. Frameworks: React, Vue, Angular, plus Flutter/Swift/Android.

### Pricing

- **Build & deploy** (Amplify Hosting build compute): **Standard (8 GB / 4 vCPU)** "No cost up to 1,000 build minutes per month," then **$0.01/min**; **Large (16 GB / 8 vCPU) $0.025/min**; **XLarge (72 GB / 36 vCPU) $0.10/min**.
- **Hosting**: **CDN storage** "No cost up to 5 GB … per month," then **$0.023/GB-month**; **data transfer out** 15 GB free, then **$0.15/GB**.
- **SSR compute**: **500,000 requests/month free**, then **$0.30 per 1M**; **100 GB-hours/month free**, then **$0.20 per GB-hour**.
- New AWS customers (from **July 15, 2025**) get up to **$200 in Free Tier credits** applicable to Amplify.
- **Backend resources billed separately**: **"Cognito, AppSync, DynamoDB, Lambda, and S3 operate under separate AWS pricing models with their own free tiers and usage-based charges."** Amplify does not bundle or abstract that spend — it is standard AWS usage, and cost visibility is on you (Cost Explorer / third-party FinOps).

## Architecture

- **Control plane** — AWS: Amplify Hosting plus CloudFormation.
- **Execution model** — TypeScript definitions are evaluated to produce CDK constructs, synthesized
  to CloudFormation, and deployed as stacks.
- **Type generation** — the backend schema produces client types, so a schema change surfaces as a
  compile error in the application. This is the strongest single feature.
- **State authority** — CloudFormation stack state.
- **Portability boundary** — **none, by design.** The definitions describe AWS services through AWS
  constructs; the abstraction is a nicer way to write AWS, not a way to leave it.

## Where AWS Amplify is stronger

> Shipped, evidenced capability only.

### what Amplify does well

- **Deep, first-party AWS-native integration** — managed **AppSync (GraphQL)**, **DynamoDB**, **Cognito**, **S3**, **Lambda**, **CloudFront**, wired together with IAM, shipping at AWS scale. This is real, production-grade depth HoBo (design-phase) does not have.
- **Genuine IfC-in-TypeScript on CDK** — `defineBackend`/`defineData`/`defineAuth`/`defineStorage`/`defineFunction` is a clean, typed authoring model; per-model typed data + generated typed client + **real-time subscriptions** (`observeQuery`) is a strong end-to-end DX.
- **Shipping fullstack-branch DX** — commit + push = a shared URL **with its own backend**; PR previews; a per-developer **cloud sandbox** with fast hot-swap. Mature and live today.
- **Amplify UI component library** — connected `Authenticator`/`FileUploader`/`StorageImage` collapse auth/storage UIs to a tag; a large frontend accelerator with no HoBo equivalent yet.
- **CDK escape hatch** — `backend.createStack()` + `aws-cdk-lib` + reaching Amplify's own constructs means **no hard ceiling within AWS**.
- **SSR hosting** for Next.js/Nuxt/Astro/SvelteKit with global CDN, atomic deploys, custom domains.
- **OSS framework (Apache-2.0)**, pay-as-you-go, generous free tier, and the full weight of the AWS ecosystem/support/compliance behind it.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Amplify's limits — HoBo's opening

- **AWS-only; CDK-bound; fixed resource→service mapping.** `defineData` **always** → AppSync+DynamoDB, `defineAuth` **always** → Cognito, `defineStorage` **always** → S3, `defineFunction` **always** → Node Lambda. No Azure/GCP/Cloudflare/Fly/edge/on-prem; you **cannot** repoint a resource to a different backend, and you **cannot** swap the IaC engine — the escape hatch is *more CDK*. HoBo is **multi-cloud + IaC-agnostic** (Pulumi/Crossplane/TF/OpenTofu) with typed provider-native escape hatches ([Plan 4](../design/control-plane.md#plan-04) / [ADR-0006](../design/adr/01-architecture-core.md#adr-0006)), and adds **Resource Definitions + Matching** so the same app realizes differently per environment, auditably (`match.Decided`, [Plan 25](../design/platform-engineering.md#plan-25) / [ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) with a cost-routing **Dispatcher** ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)).
- **TS/Node-only backend logic.** Handlers are Lambda (JavaScript/TypeScript); the authoring language is TypeScript, full stop. HoBo's runtime contract is **language-neutral WIT** — any wasm-compiling language ([Plan 20](../design/wasm-runtime-wit.md#plan-20)), with TS explicitly *not* required for the reference impl ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069) / [ADR-0072](../design/adr/01-architecture-core.md#adr-0072)).
- **Single default data paradigm (DynamoDB) behind AppSync.** No first-class relational/SQL model (only a connector for a pre-existing RDS/Aurora), **no graph, no vector/search** as Amplify resources. HoBo formalizes a **paradigm taxonomy** ([ADR-0052](../design/adr/03-data-plane.md#adr-0052)) with **opt-in packages** `@hobo/sql`/`vector`/`graph`/`document` ([ADR-0081](../design/adr/03-data-plane.md#adr-0081)), first-class **vector + search** ([ADR-0034](../design/adr/03-data-plane.md#adr-0034)), and SQL **migrations** ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)).
- **No event-sourced control plane / audit-replay**, no **durable actor/workflow/saga** runtime, no **contracts/`can-deploy`/policy** planes, and no **platform-governance layer** over the app itself (you inherit AWS IAM/CloudTrail). HoBo ships an **event-sourced runtime + actors/workflows/sagas + replay** ([Plan 11](../design/data-plane.md#plan-11) / [ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)/[ADR-0050](../design/adr/03-data-plane.md#adr-0050)), **governance planes** (Contract/Eval/Policy/Trace, [ADR-0015](../design/adr/02-identity-security.md#adr-0015)), **contracts/policy/flags** ([Plan 29](../design/contracts-policy-flags.md#plan-29)), and **org/RBAC/SSO/SCIM** ([ADR-0074](../design/adr/02-identity-security.md#adr-0074)).
- **No multi-tenant-app primitives.** Amplify gives no app-tenant model, tenancy spectrum, per-tenant isolation/routing/quota/residency — a SaaS builder rolls their own atop Cognito. HoBo ships this as a capability ([Plan 50](../design/security-networking.md#plan-50) / [ADR-0079](../design/adr/02-identity-security.md#adr-0079) / [ADR-0080](../design/adr/02-identity-security.md#adr-0080)).
- **No AI/agent-native surface in the framework.** No agents-as-principals, no MCP control surface, no AI-generated providers/implementations, no trainable functions. HoBo makes **agents first-class principals** with brokered tokens + MCP ([Plan 6](../design/ai-native-agent-auth.md#plan-06)), ships an **AI generation pipeline** for providers/impls + UI generation (`ui-render`, [ADR-0056](../design/adr/03-data-plane.md#adr-0056)) conformance-gated ([Plan 23](../design/generated-stack.md#plan-23) / [ADR-0010](../design/adr/03-data-plane.md#adr-0010)), and `"use training"` self-optimizing methods.
- **Lock-in gradient.** The framework is OSS, but the value is the **managed AWS services + Amplify Hosting**; leaving means rewriting off AppSync/DynamoDB/Cognito/S3 wiring, and there is no documented "adopt an existing estate in place." HoBo's **Yard is itself a Bindle** (self-host = hosted parity, [Plan 4](../design/control-plane.md#plan-04)) and **`hobo import`** adopts TF/Pulumi/Lakebed/FaaS estates incrementally ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **Backend spend is standard AWS usage, unabstracted** — cost visibility falls to Cost Explorer / third-party tools. This is Amplify's model **by design**; HoBo deliberately ships **no billing/monetization** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) and treats metering as **OSS FinOps showback** ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)).

## Adversarial critique

- **AWS-only, permanently.** The value proposition is depth of integration with one cloud; there is
  no portability claim and no mechanism that could support one.
- **CloudFormation is the floor.** Stack limits, slow deploys, and painful rollbacks are inherited
  wholesale, and they are the most-cited operational complaint about the platform.
- **Amplify has been rewritten before.** Gen 1 and Gen 2 differ substantially, and teams that adopted
  the earlier model faced a migration rather than an upgrade — a real risk signal for a product whose
  entire value is that you build your backend inside it.
- **The escape hatch is the tell.** Dropping to raw CDK is documented and necessary, which means the
  abstraction covers the common path and users grow out of it.
- **Opinionated data modelling.** The data layer's conventions are convenient inside the intended
  patterns and constraining outside them.
- **Generated clients tie the frontend to the backend's shape**, which is exactly the coupling that
  makes the DX good and the migration hard.

### Comparisons with adjacent tools

- **vs HoBo:** Amplify is **IfC-in-TS → AWS (via CDK)**, with managed AppSync/DynamoDB/Cognito/S3, a **shipping** fullstack-branch DX, and a **UI component library**; HoBo is **IfC → any cloud via pluggable adapters + pluggable IaC**, any **wasm** language, **event-sourced + AI-native + governed**. Amplify is the sharpest proof that HoBo's *authoring model* is right **and** the clearest reminder that a deep-pocketed AWS-native incumbent already ships the DX. HoBo's edge is the surrounding system — **breadth (clouds/languages/IaC) + control-plane planes + data-paradigm breadth + AI-native depth** — not the `define*` ergonomics themselves.
- **vs Encore:** both are IfC-in-TS that provision *real* cloud. Encore is cloud-agnostic-ish (**AWS + GCP**) via its own compiler; Amplify is **AWS-only** but **built on CDK** (hence a first-class CDK escape hatch) and ships **managed GraphQL/identity + a UI library + Hosting**. Both **fix** the resource→service mapping.
- **vs Nitric:** Nitric is **multi-cloud** IfC via a gRPC membrane + swappable Pulumi/Terraform providers; Amplify is **AWS-only + CDK**. Nitric is portable-by-design; Amplify is AWS-deep.
- **vs SST/Ion:** SST is also "IfC on AWS via CDK/Pulumi (Ion)" — both are AWS-centric TypeScript; Amplify adds **first-party managed Data/Auth/Storage/UI + Hosting** where SST leans on you to compose constructs.
- **vs Convex / Supabase / InsForge:** managed BaaS; Amplify is **AWS-first-party and CDK-extensible** rather than a single opinionated managed runtime, and deploys into *your* AWS account.
- **vs raw CDK/CloudFormation:** Amplify **is** the high-level IfC layer over CDK — less ceremony, fixed opinions, and raw CDK available when you need it.

**Net:** AWS Amplify Gen 2 is the **AWS-native proof of HoBo's IfC-in-TypeScript authoring model** — and unlike HoBo it **ships today** with deep managed services (AppSync/DynamoDB/Cognito/S3), a mature fullstack-branch DX, and a **UI component library HoBo does not yet have**. But it is **AWS-only, CDK-bound, fixed-mapping, TS/Node-only, single-paradigm (DynamoDB), with no event-sourcing/governance/multi-tenant/AI-agent planes**. HoBo's differentiation is exactly that surrounding system: **multi-cloud + pluggable-IaC breadth, a language-neutral wasm runtime, Resource Definitions/Matching + the Dispatcher, a broad data-paradigm catalog, event-sourced governance, cross-cloud data, multi-tenant-app primitives, and AI-native depth** — while conceding Amplify's shipping AWS-native depth and mature developer experience.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Amplify concept (✅ designed at parity, anchored · ➕ HoBo goes further · ◐ partial / thinner in HoBo's design · 🔜 planned/deferred). HoBo is **design-phase**; Amplify is a shipping AWS product.

| Amplify concept | HoBo equivalent | Status | Notes |
|---|---|---|---|
| **`defineBackend`** (IfC-in-TS, compose resources) | **IfC authoring** — resources declared inline, collected → manifest IR ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | same thesis; HoBo authoring is WIT/wasm-first, **TS not required** ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)/[ADR-0072](../design/adr/01-architecture-core.md#adr-0072)) |
| **`defineData`** `a.model().authorization(allow => …)` | IfC model + **`.allow()` three-effects** ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | Amplify's per-model `allow.*` is the direct analog to HoBo `.allow()` (one decl → IAM + wasm link + token scope) |
| AppSync **managed GraphQL API** | `hobo:service`/`api` port + WIT-generated typed clients ([ADR-0114](../design/adr/02-identity-security.md#adr-0114) / [ADR-0037](../design/adr/01-architecture-core.md#adr-0037)) | ◐ | HoBo maps AppSync→`api` port and generates typed clients, but ships **no turnkey managed-GraphQL service** yet |
| Real-time subscriptions (`observeQuery`) | reactive reads + `hobo:websocket` (`wasi:websocket`) ([ADR-0050](../design/adr/03-data-plane.md#adr-0050) / [ADR-0075](../design/adr/07-portability-extensibility.md#adr-0075)) | ✅ | live `subscribe`/reactive reads designed |
| DynamoDB (NoSQL/document default) | **document/kv paradigm** + opt-in packages ([ADR-0052](../design/adr/03-data-plane.md#adr-0052) / [ADR-0081](../design/adr/03-data-plane.md#adr-0081)) | ✅/➕ | plus **SQL/vector/graph** paradigms Amplify lacks |
| **`defineAuth`** (Amazon Cognito) | `hobo:auth` port — federate + verify + end-user auth ([ADR-0038](../design/adr/02-identity-security.md#adr-0038)) | ◐ | auth **port** is designed; no shipping managed user-directory with Cognito's depth |
| **`defineStorage`** (S3, path access rules) | `hobo:bucket` (`wasi:blobstore`) + `.allow()` path/verb rules ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | near 1:1 |
| **`defineFunction`** (Node Lambda handlers) | services = **wasm/wasi components** ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ➕ | polyglot wasm vs Node-only Lambda |
| Custom queries/mutations + scheduled functions | `service`/`api` primitives + `hobo:schedule` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)) | ✅ | |
| **CDK escape hatch** (`backend.createStack`, `aws-cdk-lib`) | pluggable IaC (Pulumi/Crossplane/TF/OpenTofu) + typed provider-native escape hatches ([Plan 4](../design/control-plane.md#plan-04) / [ADR-0006](../design/adr/01-architecture-core.md#adr-0006)) | ➕ | HoBo's hatch spans IaC engines and clouds, not just more CDK |
| **`ampx sandbox`** (per-dev cloud backend, hot-swap) | `hobo dev` + **fidelity matrix** ([Plan 7](../design/developer-experience.md#plan-07) / [ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) | ✅/➕ | HoBo also runs a **local** runtime (Amplify sandbox is cloud-only, incurs AWS usage) |
| Per-branch backend / PR previews | **ephemeral/preview Camps** + **sandbox lanes** ([Plan 25](../design/platform-engineering.md#plan-25) / [ADR-0076](../design/adr/02-identity-security.md#adr-0076)) | ✅/➕ | |
| `ampx pipeline-deploy` (CI/CD) | `hobo up` / deploy pipeline ([Plan 7](../design/developer-experience.md#plan-07)) | ✅ | |
| `ampx generate outputs`/`graphql-client-code`/`forms` | generated stack + typed clients ([ADR-0037](../design/adr/01-architecture-core.md#adr-0037) / [Plan 23](../design/generated-stack.md#plan-23)) | ✅/➕ | |
| **Amplify Hosting** (Git CI/CD, CDN, SSR, custom domains, atomic deploys) | `hobo:web` (static/SSR + CDN) + **Harness** progressive delivery ([Plan 21](../design/authoring-resources-wiring.md#plan-21) / [ADR-0083](../design/adr/02-identity-security.md#adr-0083)) | ◐ | `web` port + delivery designed; **no shipping managed Git-CI/CD hosting product** — Amplify is clearly ahead |
| **Amplify UI** (`Authenticator`/`FileUploader`/`StorageImage`) | design.md **UI generation** `ui-render` + generation pipeline ([ADR-0056](../design/adr/03-data-plane.md#adr-0056) / [Plan 23](../design/generated-stack.md#plan-23)) | 🔜 | **no component library** — HoBo has a *generation path*, not shipping components; Amplify is well ahead |
| App-facing caching | the new `cache` port (ADR-0118, in progress) | 🔜 | designed this tranche, not yet landed |
| Backend billed as AWS usage | **no billing/monetization** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) + OSS FinOps showback ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) | ➕ | ✗-by-design: HoBo deliberately does not bill; metering is showback only |
| *(AWS-only)* | multi-cloud provider adapters + pluggable IaC ([Plan 4](../design/control-plane.md#plan-04)) | ➕ | |
| *(fixed CDK mapping)* | **Resource Definitions + Matching** + Dispatcher ([Plan 25](../design/platform-engineering.md#plan-25) / [ADR-0033](../design/adr/01-architecture-core.md#adr-0033) / [ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ | same app → different infra per env, auditable, cost-routed |
| *(none)* | **Event-sourced control plane + audit/replay** + durable actors/workflows/sagas ([Plan 11](../design/data-plane.md#plan-11) / [ADR-0003](../design/adr/01-architecture-core.md#adr-0003)/[ADR-0004](../design/adr/01-architecture-core.md#adr-0004)) | ➕ | |
| *(none)* | **Contracts/`can-deploy` + policy/flags** + governance planes ([Plan 29](../design/contracts-policy-flags.md#plan-29) / [ADR-0015](../design/adr/02-identity-security.md#adr-0015)) | ➕ | |
| *(none)* | **Multi-tenant-app primitives** ([Plan 50](../design/security-networking.md#plan-50) / [ADR-0079](../design/adr/02-identity-security.md#adr-0079)) | ➕ | |
| *(none)* | **Agents as principals + MCP + brokered tokens** ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ | |
| *(none)* | **AI-generated providers/impls + trainable functions** ([Plan 23](../design/generated-stack.md#plan-23)) | ➕ | |
| *(none)* | **Cross-cloud data** — migration ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) + cross-Camp consistency ([ADR-0040](../design/adr/01-architecture-core.md#adr-0040)) | ➕ | |
| *(greenfield-leaning)* | **`hobo import`** adopt-in-place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ➕ | |

### Amplify-as-validation, and where Amplify is genuinely ahead

Amplify Gen 2 **validates HoBo's core bet** — infrastructure-from-code in a typed language, with per-resource authorization (`allow.*`) that mirrors HoBo's `.allow()`, provisioning real cloud from declarations. It is the strongest evidence that the `define*` authoring shape is the right ergonomic. But honesty requires naming Amplify's **shipping lead**: (a) a **mature managed data/identity/storage stack** (AppSync + DynamoDB + Cognito + S3) that HoBo has only *designed* ports for; (b) a **fullstack Git-branch hosting product** with SSR that HoBo does not yet ship (HoBo has a `web` port + Harness delivery, marked ◐); and (c) a **UI component library** (`Authenticator`/`FileUploader`/`StorageImage`) with **no HoBo equivalent** (HoBo has a UI *generation* path, marked 🔜). On those three axes Amplify is ahead today.

### The one-line takeaway

**Amplify Gen 2 proves HoBo's IfC-in-TypeScript authoring model on AWS — and ships managed AppSync/DynamoDB/Cognito/S3, fullstack Git-branch hosting, and a UI library that HoBo (design-phase) does not yet have.** HoBo's differentiation is everything *around* that authoring core: **multi-cloud + pluggable-IaC breadth (vs Amplify's AWS-only, CDK-bound, fixed mapping), a language-neutral wasm runtime (vs TS/Node-only), Resource Definitions/Matching + the Dispatcher, a broad data-paradigm catalog (vs DynamoDB-default), event-sourced governance, cross-cloud data, multi-tenant-app primitives, and AI-native depth — with billing a deliberate non-goal ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)) where Amplify passes through standard AWS usage.**

## Better-together / integration posture

- **Benchmark**, and pointedly: Amplify proves that typed TypeScript backend declaration with
  generated client types is a viable, pleasant authoring model. HoBo's version must be at least as
  good ergonomically while targeting more than one cloud.
- **Borrow** — **schema-to-client type generation**. A backend declaration that produces compile-time
  errors in the application when it changes is the strongest ergonomic in this cohort, and HoBo's
  typed contracts could produce exactly that.
- **Provider-target** — AWS-shaped Bindles could plausibly render through CDK.
- Not a displace or adopt target.

## Threats and lessons

1. **The authoring thesis is validated, and claimed for one cloud.** AWS has shipped the pleasant
   half of HoBo's idea without the portable half. HoBo's argument is therefore about targets, not
   about authoring — and it must not be *worse* at authoring while making that argument.
2. **Generated types are the missing half of typed contracts** (*not-present* as a shipped HoBo
   surface). Contracts that do not produce client types leave the best part of the idea on the table.
3. **Rewrites destroy trust in exactly this product category.** Gen 1 to Gen 2 is a cautionary tale
   for any platform asking developers to express their backend in its vocabulary — including HoBo.
4. **An escape hatch is necessary and is also a measurement.** How often users drop to raw CDK is the
   honest metric for how complete the abstraction is; HoBo's provider escapes (ADR-0144) should be
   measured the same way.

## Sources

- [docs.amplify.aws](https://docs.amplify.aws/) — Gen-2 backend definitions, `defineData`/`defineAuth`/`defineStorage`/`defineFunction`, sandboxes, branch environments, generated clients
- [aws.amazon.com/amplify](https://aws.amazon.com/amplify/) — positioning (vendor material)

This capture predates the research contract and was restructured to it on 2026-08-19 with its
original research preserved. Current Gen-2 feature coverage and the Gen-1 migration path were not
re-verified in this pass and are not asserted.
