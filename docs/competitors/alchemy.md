---
type: Competitive Reference
title: "Alchemy — competitor reference"
description: "Alchemy (alchemy.run) is an **open-source (Apache-2.0) TypeScript-native IaC engine** — v1 \"resources are just async functions\", v2 \"Infrastructure-as-Effects\" on the Effect library — embeddable, engine-less (direct HTTPS to cloud APIs, no Pulumi/Terraform), AWS + Cloudflare first, with LLM-authored providers as an explicit growth loop. Refreshed 2026-11-08 at v2.0.0-beta.85 (beta.86 merged-to-main): 6+ clouds incl. GCP/Fly/Hetzner/Railway/Kubernetes, sandboxes, Domain DDD."
tags: [hobo, competitors]
competitor:
  slug: alchemy
  name: "Alchemy"
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code, portable-application-models]
  directness: direct
  role: "TypeScript-native engine-less IaC — competes on the authoring/provisioning core and is a candidate iac-alchemy adapter"
  posture: [borrow, benchmark]
  hobo_surface: [authoring, typed-contracts, reconciliation, extensibility]
  evidence: mixed
  status: active
  research_date: 2026-11-08
  contract: v1
  sources:
    - https://alchemy.run/docs/
    - https://github.com/alchemy-run/alchemy
---

# Alchemy — competitor reference

> A faithful, detailed capture of **Alchemy** (alchemy.run — *not* the unrelated blockchain-API company alchemy.com) for HoBo competitive analysis. Alchemy is a **direct competitor on HoBo's authoring + provisioning core**: TypeScript-native Infrastructure-as-Code with **no external engine** (no Pulumi, no Terraform, no CloudFormation — providers talk **direct HTTPS** to cloud APIs), an **embeddable library** design that runs in any JS runtime, and an explicitly **AI-first** provider story (*"use LLMs to create/copy/fork/modify resources"*). Created by **Sam Goodwin** (previously punchcard, functionless, eventual; [devtools.fm #138](https://www.devtools.fm/episode/138)); reported **~$1.06M pre-seed** (Crucible Capital + angels). Two eras matter: **v1** (*"resources are just async functions"*, memoized, top-level `await`) and the current **v2 rewrite** — **"Infrastructure-as-Effects"**: *"cloud infrastructure and application logic as a single, type-safe Effect program"*, built on the [Effect](https://effect.website) library. Sources: [alchemy.run](https://alchemy.run/) · [getting-started](https://alchemy.run/getting-started) · [infrastructure-as-effects](https://alchemy.run/infrastructure-as-effects) · [resource-lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle) · [provider](https://alchemy.run/infrastructure-as-code/provider) · [action](https://alchemy.run/infrastructure-as-code/action) · [state-store](https://alchemy.run/state-store) · [testing](https://alchemy.run/testing) · [observability](https://alchemy.run/testing/observability) · [local-development](https://alchemy.run/environments/local-development) · [ci](https://alchemy.run/environments/ci) · [apis](https://alchemy.run/apis) · [migrating-from-v1](https://alchemy.run/migrating-from-v1) · [llms.txt](https://alchemy.run/llms.txt) · [github.com/alchemy-run/alchemy](https://github.com/alchemy-run/alchemy). License **Apache-2.0**; v2 is **beta** (*"Expect breaking changes"*), `alchemy@latest` = **2.0.0-beta.85** (2026-11-02) + `effect@^4.1.0`, ~1.9k GitHub stars, ~284 forks (Nov 2026). Researched August 2026, refreshed 2026-11-08; API/CLI/config shapes quoted for analysis under fair use (see [`index.md`](index.md#sources--fair-use)).

## What it is

Alchemy began (v1) as *"an embeddable, TypeScript-native Infrastructure-as-Code library for modeling Resources that are Created, Updated and Deleted automatically"* — the radical bit being that **resources are just memoized async functions**, in *"pure ESM-native TypeScript"*, with *"no wrappers, no multiple languages, no custom DSL, YAML or JSON, no external runtimes"*, runnable *"in any JavaScript runtime, including the browser"*, serverless functions, and durable workflows. Sam Goodwin's framing is **"un-bundling IaC"**: after a decade across CDK-adjacent tooling (punchcard → functionless → eventual), strip the layered Terraform/Pulumi/engine stack back to plain code that *"talks directly to cloud services APIs"* over HTTPS.

**v2 is a philosophical escalation, not just a rewrite.** The current product is branded **"Infrastructure-as-Effects"**: *"cloud infrastructure and application logic as a single, type-safe Effect program"* built from **Effects and Layers**. The pitch: *"There is no separate 'infra' project plus 'handler' project — a Worker or Lambda Function is a Resource that ships its runtime code, with the resources it uses wired in as Bindings."* Three slogans carry the model: **"One program, one language."** · **"Bindings, not glue code."** (a one-line binding wires IAM + env vars + a typed SDK client) · **"Errors in the type system."** (cloud API failures are tagged Effect errors). Effect at *runtime* is optional — *"bindings also work as plain props on an async fetch handler with a typed env via `InferEnv`"* — but the **stack program itself is Effect** (`Effect.gen` + `yield*`).

| Dimension | Alchemy (v2 "Infrastructure-as-Effects") |
|---|---|
| Authoring | One TypeScript program (`alchemy.run.ts`): `Alchemy.Stack("Name", {providers, state}, Effect.gen(function* () { … }))`; resources via `yield* Cloudflare.R2.Bucket("Bucket")` |
| Engine | **None** — no Pulumi/TF/CFN; providers are Effect **Layers** calling cloud HTTPS APIs directly; embeddable library, any JS runtime |
| Lifecycle | plan → **reconcile** → (replace) → delete; five plan classifications (`+ ~ ± - •`); convergent, idempotent `reconcile` (observe → ensure → sync → return); `read` powers **state recovery + adoption** (`Unowned` brand, `--adopt`) |
| Actions | deploy-time arbitrary Effects in the dependency graph, input-hash memoized (`run λ` / `skip ·`) — seeding, migrations, notifications |
| Bindings | *"The binding **is** the SDK; there is no `env.BUCKET`"* — `yield* Cloudflare.R2.ReadWriteBucket(Bucket)` declares the capability, the Layer wires it (IAM/native binding) and returns the typed client |
| Providers | **AWS + Cloudflare + GCP deep** (distilled-SDK breadth, ~200/~110/~200 src areas at beta.85 — dir counts, not per-resource verified) + Fly, Hetzner, Railway, Kubernetes, Prisma, PlanetScale, Neon, Turso, Axiom, GitHub, Docker, Stripe (v2 since beta.78), ACME, SQL/Redis, Doppler/Infisical; **no v2 Sentry/Upstash package**. Merged-to-main for beta.86 (npm-unpublished at beta.85): Modal/E2B/Daytona/Archil/Boat sandboxes, Rivet, Effect Cluster. Custom provider = *"declare a Resource type, implement a Layer"* — **LLM-authoring explicitly encouraged** |
| State | Local `.alchemy/` default (gitignored; solo dev via `dev_$USER` stage); recommended **`Cloudflare.state()`** — *"a Worker backed by a Durable Object with embedded SQLite"*, encrypted at rest; custom store = *"just an Effect `Layer` that provides the `State` service"* (Postgres/S3/Redis/Dynamo); scoped by **stack × stage** |
| Local dev | `alchemy dev`: **workerd** (prod runtime) + **local simulators** for KV/R2/D1/Queues, *"Worker reloaded in 42ms"*; `Alchemy.remote()` routes any resource to real cloud; Vite/Astro/TanStack/SolidStart/Nuxt/Vue dev servers integrate; IDE debugger attach |
| Testing | **Real cloud, no mocks**: *"deploy → assert → destroy"* per suite (`beforeAll`/`afterAll`), default `test` stage, per-PR stages for parallelism |
| CI | GitHub Actions: PR → stage `staging-{n}` (was `pr-{n}` at Aug capture) (isolated copy of every resource, preview-URL bot comment), close → `alchemy destroy --stage staging-{n}`; **credentials-as-code** (stack mints scoped CF tokens / AWS OIDC role) |
| Observability | Effect emits **OTel logs/spans/metrics by default**; exporter is a swappable Layer (Axiom/Datadog/any OTLP); **dashboards, alarms, monitors declared as resources** next to what they observe |
| APIs | three modalities on one host: **schemaless RPC** (internal, fully typed, zero validation cost) · **Effect RPC** (schema'd trust boundaries) · **Effect HTTP** (real REST for non-TS consumers) |
| AI | `llms.txt` + `llms-full.txt` (~857 KB) agent docs (*"an agent can pick the right page in one hop"*); homepage: *"Paste this into your coding agent"*; LLM-authored providers as the ecosystem growth loop. **No MCP server, no agent identity/principals** |
| License / status | **Apache-2.0**, OSS, no hosted product observed; **beta** (`2.0.0-beta.85`, 2026-11-02), `alchemy@latest`; ~1.9k stars; ~$1.06M raised at Aug capture (not re-verified Nov) |

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Resource** | An async TypeScript function that creates, updates or deletes something, with its own state handling |
| **Scope** | The nesting context that owns resources and their state |
| **State store** | Pluggable persistence for resource state — files, cloud storage, a database |
| **Adopt / replace semantics** | Explicit handling for existing resources |
| **Effect-based v2** | The second-generation model, "Infrastructure-as-Effects", built on the Effect library |

The mental model is **there is no engine**. A resource is a function; running the program reconciles
reality by calling provider APIs directly. No daemon, no separate state service, no CLI orchestrator
between the code and the cloud.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `authoring` | TypeScript-native resource definition with no DSL and no engine |
| `typed-contracts` | Resources are typed functions with typed inputs and outputs |
| `reconciliation` | Direct-API reconcile in-process |
| `extensibility` | **The standout** — writing a provider is writing an async function, which is why the ecosystem grows quickly, including LLM-authored providers |

Alchemy competes with HoBo on the provisioning core and is simultaneously a candidate `iac-alchemy`
adapter — a posture HoBo's own ADRs already anticipate.

## Feature surface

### The stack program

```ts
// alchemy.run.ts
export default Alchemy.Stack(
  "MyApp",
  { providers: /* … */, state: /* … */ },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Bucket");
    const worker = yield* Cloudflare.Worker("Api", {
      main: "./src/api.ts",
      bindings: { Bucket: bucket },
    });
    return { url: worker.url };
  })
);
```

- `alchemy deploy` plans, prompts, applies; `alchemy plan` shows the diff; `alchemy dev` *"continuously plan[s] and appl[ies] on file changes"*; `alchemy destroy` tears down. Credentials come from interactive `alchemy login` profiles (`~/.alchemy/profiles.json`, `--profile prod`).
- **Stages** are the environment mechanism (`dev_$USER` personal default, `test_$USER` (since beta.78), `staging-{n}` PR previews, `prod`); *"State is scoped by stack name and stage, so different stacks and environments are fully isolated."* Environment differences are ordinary code branching — there is no platform-rules layer.
- v1 compatibility: existing `async fetch` handlers *"do not need to change"* — `Cloudflare.InferEnv<typeof Worker>` derives a fully-typed `env` without adopting Effect in runtime code; migration is phased (`--adopt` to take ownership of existing physical resources).

### Resource lifecycle — the reconcile model

Alchemy's engine-less lifecycle is its most technically distinctive choice. Providers implement a single **`reconcile`** function that *"converges the cloud's actual state to what's declared — whether that's the first provisioning, a routine update, or an adoption takeover"*:

- Planning classifies every resource: **Create** `+` (*"declared in code, not in state"*), **Update** `~`, **Replace** `±` (*"change requires destroy-and-recreate"*), **Delete** `-`, **No-op** `•`.
- `reconcile` receives desired props (`news`), current attributes (`output`), previous props (`olds`) and binding payloads, and follows **observe → ensure → sync → return**; because *"each step is independently idempotent, a partial reconcile that crashed midway resumes correctly on the next run."*
- **Replace** creates the new instance first, repoints downstream references, then deletes the old (brief coexistence, no downtime); deletes run in *"reverse dependency order — dependents go first."*
- **Physical names derive deterministically** from stack/stage/logical-id, so a lost state write is recoverable: reconcile retry re-finds the resource by name, delete retry treats missing as success, and the provider's **`read`** rebuilds state from live infrastructure.
- `read` doubles as **adoption**: it is *"the single source of truth for 'does this resource exist, and is it ours?'"*, returning attributes, `Unowned(attrs)` for foreign resources, or undefined — powering `alchemy deploy --adopt` takeover of pre-existing infrastructure. `list` powers account-wide sweeps (`alchemy unsafe nuke`); `precreate` reserves names for circular bindings; `tail`/`logs` stream logs.
- **Actions** cover deploy-time work that isn't a resource: *"a node in the stack's dependency graph that runs an arbitrary Effect during `apply`"* — input-hash memoized (run `λ` / skip `·`), never deleted, for *"seeding a database, posting a release notification, … running a migration check."*

### Bindings — beyond linking

Where SST's `link:[bucket]` injects config + types + IAM, Alchemy collapses the remaining seam. *"A Resource is infrastructure. A Binding exposes that infrastructure to compute as a typed, capability-scoped client"* — one declarative line, `yield* Cloudflare.R2.ReadWriteBucket(Bucket)`, yields the typed client and wires everything behind it. The mechanism is a clean **contract/implementation split**:

- **The declaration is a contract.** `ReadWriteBucket` is a `Binding.Service` — *"a callable Context tag. It names the capability and says nothing about how it's satisfied."* The handler code depends only on this capability name.
- **The implementation is a swappable Layer.** Cloudflare ships interchangeable implementations of the *same contract*: `ReadWriteBucketBinding` *"registers a native `r2_bucket` binding on the Worker and reads it off the Worker env at runtime"*, while `ReadWriteBucketHttp` *"mints a scoped `AccountApiToken` at deploy time and calls R2 over HTTP at runtime. Same contract, same handler code."* Which Layers exist determines which hosts can satisfy the capability — `ReadWriteBucketBinding` *"requires `WorkerEnvironment` and `Worker`, so only a Cloudflare Worker can provide it"*; using it from Lambda is a **type error**.
- **Deploy-time wiring records three things on the plan**: permissions (least-privilege IAM on AWS — `S3.GetObject(bucket)` maps to exactly `s3:GetObject` on that bucket's ARN; native bindings on Cloudflare), configuration (physical names/ARNs/URLs serialized into the function env), and the bundled typed SDK client. Capability granularity is the *method* — the IAM policy is derived from **which typed client you asked for**, and multi-resource bindings enumerate every ARN.
- **Bindings generalize past clients**: plan-time **data sources** (*"the shape Terraform calls a data source and Pulumi an invoke"* — `AWS.EC2.getAmi(...)`, same contract callable in both phases), **event sources** (*"runs your Function when something happens on a resource — the records arrive as an Effect `Stream`"*), and **sinks** (*"the write side — the resource exposed as an Effect `Sink`"*) — each wiring its own permissions.
- One guard splits the phases: deploy-time wiring runs `if (!globalThis.__ALCHEMY_RUNTIME__)`; *"the runtime bundle stays small because the planning branch never executes."* And because clients are Effects, resilience composes at the call site (`Effect.retry`/`timeout`/`catchTag`).

This is the strongest existing articulation of **capability-contract vs binding-implementation** in a shipping IaC tool — the binding names *what* the code needs; a host-specific Layer decides *how* it's satisfied on that platform.

### Phases — one program, plantime + runtime

*"Every alchemy program runs in two phases — plantime builds the plan, runtime serves requests."* A Worker/Function is written as an **Effect that returns an Effect**: the outer (init) Effect runs at plantime during `alchemy deploy|plan|dev` *and again at cold start* to build SDK clients; the returned inner Effect runs **per request**.

| Aspect | Init (outer) | Runtime (inner) |
|---|---|---|
| Runs | plantime + cold start (≤ once per instance) | per request |
| Scope | instance scope | request scope |
| `RuntimeContext` | unavailable — *"the type system rejects it everywhere else"* | available exclusively |
| Work | discover bindings, build clients | handle requests |

Phase detection is explicit: `ALCHEMY_PHASE` = `"plan"` (deploy/plan/dev) or `"runtime"` (deployed), and a separate `ALCHEMY_DEV` config key distinguishes local dev — *"`alchemy dev` is a plantime phase, so `ALCHEMY_PHASE` is `plan` during local development just like a regular deploy."* The payoff: infra references resolve at deploy time, clients are built once per cold start (not per request), and phase misuse is a **compile error**, not a runtime surprise.

### Providers as Layers + the LLM growth loop

Providers are *"just Layers, so adding a new cloud or third-party API is 'declare a Resource type, implement a Layer'"* — `reconcile` + `delete` required, `diff`/`read`/`precreate`/`list`/`tail` optional. Since v1 the project has been explicit that this is an **AI-scale strategy**: *"Alchemy actively encourages you to use LLMs to create/copy/fork/modify resources to fit your needs. No more waiting around for a provider to be implemented, just do it yourself in a few minutes."* The docs ship `llms.txt`/`llms-full.txt` so *"an agent can pick the right page in one hop."* This is the same wager as HoBo's generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)) — made without HoBo's conformance/certification gates.

### State, local dev, testing, CI, observability

- **State**: local `.alchemy/` for solo dev; recommended remote store is **Cloudflare-backed** — *"a Worker backed by a Durable Object with embedded SQLite"* with *"a symmetric key used to encrypt resource state at rest"*; CI resolves credentials from Cloudflare's Secrets Store with nothing on disk. Any backend works: *"A state store is just an Effect `Layer` that provides the `State` service."* State is current-state snapshots + lifecycle status — not an event log; no documented locking story.
- **Local dev**: `alchemy dev` runs code **in workerd** (*"the same runtime used in production"*) against **local simulators** (KV/R2/D1/Queues as `dev:`-prefixed instances; email → `.eml` files, Browser Rendering → headless Chrome, Images → Sharp); *"Code changes take effect in milliseconds"* (~40ms observed); resources without local implementations *"deploy to the real cloud, into your personal stage"*, and `Alchemy.remote()` forces any resource live — a local Worker bound to a live queue *"produces real messages."*
- **Testing**: culture-level commitment to **real infrastructure** — *"Deploy once in `beforeAll`, share the outputs handle across every test, destroy in `afterAll`"*; *"Tests default to the `test` stage, so they never touch your dev or prod deployments"*; per-PR stage IDs give parallel isolation in one account. No mocks: *"no mocks to babysit, no drift between fixture and production."* The **out-of-box harness** is the notable artifact: one `Test.make({providers, state, stage?})` call returns a self-contained suite — `test` (Effect-aware, `HttpClient` + the providers Layer already in scope), `beforeAll(deploy(Stack))` returning a lazy outputs accessor, `afterAll.skipIf(!process.env.CI)(destroy(Stack))` conditional teardown, cold-start-aware `getWhenReady(url)` (bounded exponential retries that respect deliberate 4xx), declarative `Effect.repeat` polling for queue drains/workflows, **deploy caching** (*"persistent state lets `deploy(Stack)` skip recreating unchanged resources between runs"*), multi-file stack sharing via shared remote state + stage, and Bun/Vitest support behind *"a two-line import swap."* Provider authors get **`test.provider`**: *"a private scratch stack, so create / update / replace / delete runs never touch `.alchemy/` or a shared stage"* — exercising create/update/**replace** (`stables`-change ⇒ `v2.id !== v1.id`)/delete/idempotency against in-memory state, with out-of-band SDK calls (`DynamoDB.describeTable`) working without extra setup for live conformance.
- **CI**: *"rather than copy-paste API keys into the GitHub UI, you let Alchemy provision exactly the credentials your CI needs"* — the stack mints scoped Cloudflare tokens or an **AWS OIDC** provider + role as resources. PRs deploy *"an isolated copy of every resource"* to `staging-{n}` with a bot-maintained preview comment; close triggers destroy (with a prod-protection check).
- **Observability**: because the runtime is Effect, *"every `Effect.withSpan` opens a span, every `Metric` update records a data point, every `Effect.logInfo` ships a log line"*, with automatic root spans per fetch/queue-message/cron. The exporter is a Layer (*"Swap the layer, ship somewhere else; the code emitting the signals never changes"*), and the **receiving end is also code**: Axiom datasets/monitors/notifiers, CloudWatch dashboards/alarms (composite alarms included) are stack resources — *"A threshold change is a diff in the PR — reviewable, revertable, answered by `git blame`."*
- **Drizzle-managed SQL migrations, out of the box**: the Drizzle provider (dev-dep `drizzle-kit` only, *"no credentials"*) makes schema evolution a **deploy-time resource**. A plain Drizzle TS schema module drives both typed runtime queries and migration generation; `Drizzle.Schema("app-schema", {schema, out})` *"diffs your schema module against the latest snapshot under `out`"* and writes timestamped SQL migrations — *"No CI generation step — the deploy owns it."* Downstream, a `Planetscale.PostgresBranch(…, {migrationsDir: schema.out})` *"regenerates pending SQL, then the branch scans the directory and applies new files transactionally"* — ordering falls out of the dependency graph. Connection wiring is also resources (`PostgresRole` → `origin`/`pooledOrigin`).
- **Better Auth integration**: `@alchemy.run/better-auth` wraps the Better Auth framework as one binding — `BetterAuth({basePath, emailAndPassword, …})` yields a fully-typed auth instance whose deployment *"handles database provisioning, schema migrations, secret generation, and route serving"* (signing secret auto-provisioned as an `Alchemy.Random` resource, persisted across deploys). Database Layers span CloudflareD1/Neon/Aurora DataApi/Hyperdrive/Postgres/MySQL/SQLite/Drizzle/Memory; the handler mounts as `{ fetch: auth.fetch }` and is **host-portable** — *"same handler runs on Cloudflare Workers and AWS Lambda unchanged"* — with `auth.getSession()` reading the ambient request and plugins surfacing as typed `auth.api.*` endpoints.
- **APIs**: three interoperating modalities — **schemaless RPC** (internal default: *"no schema to write, no runtime checking, and no per-request validation cost"*, bind Workers/DOs/Containers/Lambdas directly), **Effect RPC** (schema'd, for *"data … cross[ing] a trust boundary"*), **Effect HTTP** (*"real HTTP — real URLs, path params, … `curl`"*) — *"a single Worker or Function can serve schemaless methods internally **and** a schema'd surface externally."*

## Architecture

- **No control plane.** The program *is* the orchestrator; there is no server, no daemon, no hosted
  state service.
- **Execution** — resources are async functions invoked in dependency order, calling provider APIs
  directly rather than through a generic engine.
- **State** — pluggable stores; the state format is Alchemy's own but the location is the user's
  choice.
- **v2 "Infrastructure-as-Effects"** rebuilds the model on Effect, bringing structured concurrency,
  typed errors and dependency injection to the reconcile loop.
- **Portability boundary** — none claimed. Alchemy is a way to write providers and run them; the
  provider you write is for the API you wrote it against.

## Where Alchemy is stronger

> Shipped, evidenced capability only.

### what Alchemy does better than HoBo today

- **Engine-less, embeddable IaC actually shipping.** No Pulumi binary, no TF, no gRPC plugin protocol — a pure-TS library whose providers speak HTTPS, runnable in a browser, a Worker, a workflow. HoBo *designs* pluggable IaC ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) but its default live path is still the **in-memory Pulumi stand-in** ([live-provider-matrix](../design/live-provider-matrix.md)); Alchemy ships the real thing with the smallest possible footprint.
- **The reconcile lifecycle is more robust than snapshot-diff.** Convergent idempotent reconcile + deterministic physical names + `read`-based state recovery means a crashed half-deploy self-heals, and **adoption of unmanaged resources** (`--adopt`, `Unowned`) is first-class — a per-resource slice of what HoBo scopes as `hobo import` ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)), live today.
- **Bindings-are-the-SDK beats linking.** Capability-granular typed clients (`ReadWriteBucket`) that *derive* IAM from the client you requested collapse config injection, permissioning, and SDK into one declaration — a tighter loop than SST linking and an existence proof for HoBo's triple-effect `.allow()` ([Plan 21](../design/authoring-resources-wiring.md#plan-21)), shipped in TS.
- **Observability-by-default via Effect + telemetry-receivers-as-code.** OTel emission with zero instrumentation and dashboards/alarms/monitors versioned next to the resources they watch is ahead of HoBo's shipped observability surface ([Plan 5](../design/reliability-observability-cost.md#plan-05) designs it).
- **Real-cloud testing + credentials-as-code CI as a paved road.** deploy→assert→destroy suites, per-PR resource copies, and CI credentials minted *by the stack itself* (scoped tokens/OIDC as resources) — a coherent, opinionated pipeline HoBo's stage-gate lanes don't yet match in polish.
- **workerd-fidelity local dev.** Running the actual production runtime locally with ~40ms reloads and per-resource local/remote routing (`Alchemy.remote()`) is a strong point on HoBo's own fidelity-matrix axis ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) — simulate, mock, and live tiers, shipped.
- **AI-first provider growth loop, live.** LLM-authored providers + `llms.txt`/`llms-full.txt` agent docs make "the ecosystem writes itself" operational today, where HoBo's generation pipeline ([Plan 23](../design/generated-stack.md#plan-23)) is design-stage.
- **Typed failure semantics.** Cloud API failures as tagged Effect errors — *"Errors in the type system"* — is a stronger authoring-time story for partial failure than HoBo's SDK exposes today (HoBo's answer lives at the contract layer, [ADR-0136](../design/adr/03-data-plane-effects-resiliency.md)).

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`;
**proof** = draft/proof material; **design-only** = design intent. This capture predates the
contract; where it says "design-phase", read **design-only** unless labelled otherwise, and see
the [live provider matrix](../design/live-provider-matrix.md) for HoBo's honest coverage caveats.

### Alchemy's limits — HoBo's opening

- **Multi-provider, not multi-cloud — the SST critique, amplified.** `Cloudflare.R2.Bucket` and `AWS.S3.Bucket` are unrelated types; there are **no cross-provider equivalence classes, no portable ports, no impedance scoring**. The same app does not retarget clouds without a rewrite. HoBo's entire Bindle-first thesis ([ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144)) — abstract ports by default, Camp/Yard-scoped provider escapes, PortabilityReport-scored fidelity — has no Alchemy counterpart, and Alchemy's philosophy (*"unopinionated"*, un-bundled, direct APIs) is actively hostile to adding one.
- **TypeScript-only, Effect-first.** Authoring is TS; the stack program is Effect; the recommended runtime style is Effect. HoBo authors against language-neutral WIT in any Component-Model language ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) — and deliberately **keeps Effect-TS out of its public API** ([ADR-0136](../design/adr/03-data-plane-effects-resiliency.md): effects/resiliency are declarative *contract data*, not a library dependency). Alchemy bets the opposite way: the Effect ecosystem *is* the product surface. That buys them typed errors and Layers; it costs them every non-TS team and welds their API to a fast-moving third-party library (currently `effect@^4.1.0`).
- **No governance planes at all.** No policy engine, no `can-deploy` gate, no contracts, no approvals/RBAC, no cost plane, no residency/jurisdiction ([ADR-0146](../design/adr/02-identity-security.md#adr-0146) has no analog), no platform-rules layer — environment divergence is `if`-branching in the stack program, exactly the pattern HoBo's Resource Definitions + auditable `match.Decided` replaces ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)). For a platform team, Alchemy is an engine, not a control plane.
- **State is a current-state store, not an audit log.** Even the Durable-Object store holds snapshots + lifecycle status; there is no event-sourced who/why/when, no replay, no time-travel — HoBo's core bet ([Plan 11](../design/data-plane.md#plan-11), [ADR-0135](../design/adr/03-data-plane-sqlite-default.md)). No documented deploy locking either.
- **Agents author, but are not principals.** The AI story is entirely *authoring-time* (paste into your coding agent, LLM-written providers). There is no MCP control surface, no agent identity/SVIDs, no scoped agent credentials, no runtime agent operations — HoBo's Plan 6 ([ai-native-agent-auth](../design/ai-native-agent-auth.md#plan-06)) territory is untouched. (Search-engine confusion with **alchemy.com**'s blockchain MCP server is exactly that — confusion.)
- **No LLM-output verification.** The flip side of the provider growth loop: an LLM-authored provider lands with whatever tests the author ran. No conformance suites, no sandboxed validation, no signed certification — HoBo's scaffold→validate→repair→certify pipeline ([Plan 23](../design/generated-stack.md#plan-23)) is precisely the missing half.
- **Widening fleet, beta churn.** Three deep clouds (AWS, Cloudflare, GCP) + Fly/Hetzner/Railway/Kubernetes and DB/sandbox satellites at beta.85; **beta** with *"expect breaking changes"* (16 breaking commits in unreleased beta.86); the v1→v2 rewrite churned the whole authoring model once already (async functions → Effect generators). ~1.9k stars, small team, ~$1.06M raised at Aug capture (not re-verified), no revenue product visible — the **Winglang cautionary tale** ([winglang.md](winglang.md)) applies: a beloved authoring layer with no durable business collapsed in 2025.
- **No reactive data plane, no durable runtime of its own, no tenancy.** Durability is delegated to Cloudflare DOs/Workflows; there is no live-query model ([ADR-0050](../design/adr/03-data-plane.md#adr-0050)), no actor/event-sourced app runtime, no multi-tenant-app primitives ([Plan 50](../design/security-networking.md#plan-50)), no cross-cloud data story ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)).
- **No estate import.** `--adopt` takes over resources one at a time when names match; there is no TF/Pulumi-state or whole-estate ingestion (`hobo import`, [ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).

## Adversarial critique

- **Engine-less means you own the failure modes.** No engine also means no shared implementation of
  locking, retry semantics, partial-failure recovery or concurrent-run safety — each provider author
  re-solves them, or does not.
- **State is a solved problem being re-solved.** Pluggable stores are flexible and put correctness
  under concurrent runs on the user.
- **LLM-authored providers are a real ecosystem strategy and a real quality question.** Rapid
  breadth with uneven verification is a supply-chain characteristic worth naming, not celebrating by
  default.
- **The Effect rewrite is a large conceptual bet.** Effect is powerful and unfamiliar; v1-to-v2 is a
  migration for adopters, and this corpus has already recorded what generational rewrites cost
  (Amplify).
- **Young project, small ecosystem** against Terraform's and Pulumi's provider catalogs.
- **TypeScript only.**
- **No placement decision, no policy, no portability report** — it is a provisioning library, not a
  control plane, and does not claim otherwise.

### Comparisons with adjacent tools

- **vs HoBo:** the deepest overlap of any capture on the **authoring + provisioning core** — TS-native IfC, typed capability bindings, per-PR ephemeral envs, real-cloud fidelity, AI-authored providers, even "telemetry receivers as code." But Alchemy stops exactly where HoBo begins: **no portability model, no governance planes, no event-sourced control plane, no agent identity, no verification of generated code, no polyglot runtime**. Alchemy is a better *engine* than HoBo has shipped; HoBo is a *platform* Alchemy has no ambition to be.
- **vs SST:** both TS-first IfC. SST is a **component framework welded to Pulumi/TF** (150+ providers, AWS-centric high-level components, Live proxy dev, SaaS Console); Alchemy **deleted the engine** — direct-API providers, embeddable library, workerd-local dev, no hosted product. SST has breadth and maturity; Alchemy has architectural purity and the stronger testing/observability story.
- **vs Pulumi/Terraform:** Alchemy's un-bundling thesis targets exactly their layered stack (*"talks directly to cloud services APIs"* with no state protocol, plugin binaries, or DSL). The trade: Pulumi/TF's provider ecosystems are thousands strong and battle-hardened; Alchemy's answer — LLM-author what you need — is genuinely novel and genuinely unproven at scale.
- **vs Encore/Nitric:** all IfC, different bets. Encore = compiler + opinionated backend framework (TS/Go, AWS/GCP); Nitric = portable ports across clouds (the closest to HoBo's equivalence classes); Alchemy = un-bundled engine + Effect composition, portable across *nothing* but expressive over *everything it supports*.

## Primitive mapping

<a id="hobo-mapping"></a>

> HoBo's equivalent for each Alchemy concept (✅ has · ➕ goes further · ◐ designed-but-shallow · 🔜 planned · 🔌 composes as adapter). HoBo design lives in [`../design/`](../design/index.md).

| Alchemy concept | HoBo equivalent | Notes |
|---|---|---|
| One-program IfC (`alchemy.run.ts`, `Alchemy.Stack` + `Effect.gen`) | IfC authoring ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[Plan 2](../design/sdk-api.md#plan-02)); Bindle-first ([ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144)) | ✅ same thesis; ➕ HoBo authors against **portable ports**, not per-provider types |
| Engine-less direct-API providers (no Pulumi/TF) | IaC behind a port: `iac-pulumi` primary + Crossplane/OpenTofu adapters ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)); live default is the in-memory stand-in ([live-provider-matrix](../design/live-provider-matrix.md)) | ◐ HoBo's honest gap — Alchemy ships what HoBo's port *could* host; 🔌 **candidate `iac-alchemy` adapter** (below) |
| Convergent `reconcile` + `read` recovery + deterministic names | Crossplane-style reconcile borrowed at the control plane ([Plan 4](../design/control-plane.md#plan-04)); event-sourced apply ([Plan 11](../design/data-plane.md#plan-11)) | ✅ model parity in design; Alchemy's crash-resumable reconcile is the sharper shipped artifact |
| `--adopt` / `Unowned` per-resource adoption | **`hobo import`** adopt-in-place estates ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)) | ✅/➕ HoBo scopes whole-estate TF/Pulumi/FaaS ingestion; Alchemy ships the per-resource slice |
| Actions (hash-memoized deploy-time Effects) | workflow steps + Deployment Sets/Deltas ([Plan 25](../design/platform-engineering.md#plan-25)); saga steps ([Plan 11](../design/data-plane.md#plan-11)) | ✅ subsumed, event-sourced rather than hash-skipped |
| Bindings-are-the-SDK (`ReadWriteBucket` ⇒ IAM + client) | **triple-effect `.allow()`** + `_generated/` typed bindings ([Plan 21](../design/authoring-resources-wiring.md#plan-21)/[ADR-0037](../design/adr/01-architecture-core.md#adr-0037)); client derivation from resolved binding + connectivity projection **adopted** ([ADR-0157](../design/adr/07-portability-extensibility.md#adr-0157)) | ✅/➕ same least-priv-from-usage insight; HoBo adds the agent effect + language-neutral codegen |
| Binding contract vs implementation Layer (host-conditional, type-error on mismatch) | **Yard binding rows** (`profile → product/connectivity`) constraining ADR-0151 selection; plan-phase `binding.Unavailable` + codegen drift as the polyglot type-error analog ([ADR-0157](../design/adr/07-portability-extensibility.md#adr-0157), [yard-bindings](../design/yard-bindings.md)) | ✅ **adopted at the Yard boundary** — the Yard is the binding authority, audited via `match.Decided` |
| Provider-specific resource configuration at the mapping point (the [aws-eks example](https://github.com/alchemy-run/alchemy/blob/main/examples/aws-eks/alchemy.run.ts) maps a workload to a `Kubernetes.Deployment` with image, `replicas: 2`, port, `LoadBalancer` service and CPU/memory limits) | **Realization parameters** on the Yard binding row (`properties`), merged into the match outcome and scored as non-portable surface; the realization *shape* stays in the versioned Resource Definition so the row parameterizes rather than forks ([ADR-0157](../design/adr/07-portability-extensibility.md#adr-0157) d2) | ✅ **adopted** ➕ HoBo splits shape (versioned definition) from parameters (Yard row) and **scores the parameters into the PortabilityReport**, where Alchemy's inline config carries no portability consequence |
| Phases (plantime/runtime, `ALCHEMY_PHASE`, type-gated `RuntimeContext`) | **`plan`/`init`/`handle` deployment phases**, `ctx.phase`, split WIT init/handler interfaces as the polyglot phase-safety floor ([ADR-0158](../design/adr/01-architecture-core.md#adr-0158)) | ✅ **adopted** — dev is a mode, not a phase, mirroring `ALCHEMY_DEV` vs `ALCHEMY_PHASE` |
| Effect Layers as the composition/DI spine | WIT ports + capability providers ([Plan 20](../design/wasm-runtime-wit.md#plan-20)); **no Effect-TS in public API** ([ADR-0136](../design/adr/03-data-plane-effects-resiliency.md)) | ↔ opposite bets: library-level composition (TS-only) vs contract-level (polyglot, declarative) |
| Tagged Effect errors ("errors in the type system") | `EffectSpec` + `ResilienceProfile` on BoundaryContract ([ADR-0136](../design/adr/03-data-plane-effects-resiliency.md)) | ↔ Alchemy types errors in code; HoBo declares effects/resiliency on contracts where `can-deploy` can see them |
| Stage branching in code (`dev_$USER`/`staging-{n}`/`prod`) | Resource Definitions + Matching → auditable `match.Decided` ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)); Dispatcher cost-routing ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) | ➕ platform-rules layer vs imperative branching |
| State: `.alchemy/` local / DO+SQLite remote snapshots | **event-sourced control plane**, SQLite EventStore, replay/audit ([ADR-0135](../design/adr/03-data-plane-sqlite-default.md)/[Plan 11](../design/data-plane.md#plan-11)) | ➕ who/why/when + time-travel vs current-state store; amusingly both default to SQLite |
| `alchemy dev` (workerd + simulators + `Alchemy.remote()`) | `hobo dev` fidelity matrix (simulate/mock/Camp-only) + `hobo verify` ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)) | ✅ designed; Alchemy's shipped prod-runtime-local + per-resource live routing **is the bar** |
| `Test.make` OOB harness (deploy→assert→destroy, deploy caching, `getWhenReady`, `test.provider`) | **`@hobo/testing` harness**: in-process whole-graph + ephemeral-Camp lanes + provider scratch harness, stages-are-Camps, event-store deploy caching ([ADR-0159](../design/adr/07-portability-extensibility.md#adr-0159)) | ✅ **adopted** (closes GAP-026) ➕ fidelity labels flow into the harness — a green mocked-lane suite can't overclaim |
| Credentials-as-code CI + `staging-{n}` stages + destroy-on-close | broker-minted scoped tokens/OIDC as resources, `pr-<n>` preview Camps, policy-plane prod guard ([ADR-0159](../design/adr/07-portability-extensibility.md#adr-0159)/[ADR-0113](../design/adr/02-identity-security.md#adr-0113)) | ✅ **adopted** ➕ HoBo brokers at runtime too, not just CI setup |
| `Drizzle.Schema` deploy-owned migrations | **drizzle-kit as the default relational diff engine** — plan-phase generation, ADR-0032 gated expand/backfill/contract apply, Drizzle schema modules as accepted input ([ADR-0160](../design/adr/03-data-plane.md#adr-0160)) | ✅ **adopted with a spine** — deploy owns generation; HoBo keeps gated, forward-only apply |
| Better Auth binding (DB + migrations + secret + routes in one declaration) | **Better Auth as the default self-hosted `hobo:auth` adapter**, auth bundle over existing ports, brokered signing secret ([ADR-0161](../design/adr/02-identity-security.md#adr-0161)) | ✅ **adopted** ➕ secret is brokered, never state-persisted; portable via the membrane, not per-platform layers |
| OTel-by-default + dashboards/alarms-as-code | observability plane ([Plan 5](../design/reliability-observability-cost.md#plan-05)); Evidence surfaces | ◐ designed; Alchemy's zero-instrument default + receiver-as-code ships today |
| Schemaless RPC / Effect RPC / Effect HTTP | PACT at service boundaries + protobuf/CUE records ([AGENTS.md](../../AGENTS.md)); `hobo:http` / wRPC membrane ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) | ↔ HoBo requires contracts at boundaries; Alchemy's schemaless internal default trades governance for DX |
| LLM-authored providers + `llms.txt` | **generation pipeline**: scaffold→LLM-fill→validate→repair→**certify** ([Plan 23](../design/generated-stack.md#plan-23)); `site/public/llms.txt` ✅ | ✅/➕ same wager, HoBo adds the verification half Alchemy lacks |
| *(none — agents not principals)* | agents-as-principals + `@hobo/mcp` ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) | ➕ untouched by Alchemy |
| *(none — no policy/cost/residency/contracts)* | policy packs ([Plan 29](../design/contracts-policy-flags.md#plan-29)) · cost plane ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) · fail-closed residency ([ADR-0146](../design/adr/02-identity-security.md#adr-0146)) · contract effects ([ADR-0136](../design/adr/03-data-plane-effects-resiliency.md)) | ➕ the governance moat, wholesale |
| *(none — TS-only)* | language-neutral WIT, any wasm language ([Plan 20](../design/wasm-runtime-wit.md#plan-20)) | ➕ |
| *(none — no reactive/data plane)* | reactive `useQuery()` ([ADR-0050](../design/adr/03-data-plane.md#adr-0050)) · search ([ADR-0034](../design/adr/03-data-plane.md#adr-0034)) · migrations ([ADR-0032](../design/adr/03-data-plane.md#adr-0032)) · tenancy ([Plan 50](../design/security-networking.md#plan-50)) | ➕ |

### Complementary positioning — adopt the concepts, leverage the engine

The question this capture exists to answer: **can HoBo use Alchemy instead of out-competing it?** Yes, on two levels — and the first is already designed, not proposed.

**Level 1 — concept adoption (landed as ADR-0157–0161; narrative in [`yard-bindings.md`](../design/yard-bindings.md)).** The deepest value in Alchemy is not its engine but its articulation of seams HoBo had left implicit, and those are now integrated into HoBo's own design on HoBo's own machinery:

- **Bindings → Yards** ([ADR-0157](../design/adr/07-portability-extensibility.md#adr-0157)): Alchemy's contract/implementation split becomes the Yard's missing authoring surface — **Yard binding rows** mapping capability profiles to provider products/connectivity, hard-filter-only over ADR-0151 selection, with bindings-are-the-SDK client derivation through the ADR-0141 membrane, and a **seeded localhost Yard** on `hobo station init` so the ops-manager first run and deliberate SDK authoring are one surface.
- **Phases** ([ADR-0158](../design/adr/01-architecture-core.md#adr-0158)): `plan`/`init`/`handle` with split WIT interfaces as the polyglot analog of `RuntimeContext` coloring.
- **The developer loop** ([ADR-0159](../design/adr/07-portability-extensibility.md#adr-0159)): the `Test.make`-class OOB harness (in-process whole-graph + ephemeral-Camp + provider scratch lanes, closing GAP-026) and credentials-as-code CI preview lanes.
- **OOB defaults** ([ADR-0160](../design/adr/03-data-plane.md#adr-0160)/[ADR-0161](../design/adr/02-identity-security.md#adr-0161)): drizzle-kit as the default relational diff engine (deploy-owned generation, HoBo-gated apply) and Better Auth as the default self-hosted auth bundle (brokered secret, membrane-portable).

In every case HoBo keeps what Alchemy lacks: auditable selection, fidelity honesty, gated migrations, brokered secrets, polyglot reach.

**Level 2 — engine leverage (optional, unchanged).** With the concepts owned natively, Alchemy-the-library remains attractive as *plumbing*: an **`iac-alchemy` realization adapter** behind the IaC port ([ADR-0069](../design/adr/01-architecture-core.md#adr-0069)) — embeddable, Apache-2.0, engine-less, deepest exactly where HoBo's live-provider matrix is thinnest (Cloudflare/AWS) — with Effect strictly adapter-internal (ADR-0136 bans it from the *public* surface only), versions pinned hard, and Alchemy state wrapped behind HoBo's event-sourced store ([ADR-0135](../design/adr/03-data-plane-sqlite-default.md)) so the who/why/when log stays HoBo's. Likewise Alchemy-provider-shaped Layers as a Plan 23 **codegen target**: HoBo generates them, then adds the sandboxed validation + certification half Alchemy's LLM-provider wager lacks. The market framing stands: **Alchemy is an engine; HoBo is a control plane** — an Alchemy team hitting the second-cloud/compliance/audit wall is a qualified HoBo adopter, not a lost deal.

Risks, stated honestly: **beta instability** (the v1→v2 rewrite replaced the entire authoring model once; `effect@^4.1.0` is itself fast-moving) — which is precisely why the *concepts* were adopted natively rather than depended on; **viability** (~$1.06M, no visible revenue product — an `iac-alchemy` adapter must be forkable, which Apache-2.0 permits); **philosophical friction** (never require Alchemy users to adopt HoBo abstractions — offer the planes above them); **Cloudflare gravity** (state store, local dev, and the deepest provider fleet all assume Cloudflare — fine for a CF-Camp adapter, not a portability story).

### The one-line takeaway

**Alchemy is the closest shipped artifact to HoBo's authoring/provisioning core — TS-native IfC, capability bindings, reconcile lifecycle, real-cloud fidelity, LLM-authored providers — and it validates HoBo's un-bundle-the-engine and AI-authored-ecosystem bets better than any other capture; but it is single-language, Effect-welded, beta, and has *no* portability model, governance plane, event-sourced audit, agent identity, or generation verification.** HoBo's move is not to out-engine it but to **absorb the concepts and optionally leverage the engine**: Yard bindings + the seeded localhost Yard (ADR-0157), deployment phases (ADR-0158), the OOB test harness + credentials-as-code CI (ADR-0159), and the drizzle-kit/Better Auth defaults (ADR-0160/0161) land Alchemy's best ideas on HoBo machinery — with an `iac-alchemy` adapter and a generation-pipeline codegen target as the optional plumbing plays, and a "control plane above the un-bundled engine" position that converts Alchemy's users at exactly the wall where Alchemy stops.

## Better-together / integration posture

- **Borrow** — **provider authoring as an ordinary async function**. The single best lesson here: the
  cost of adding a provider determines how big the ecosystem gets, and Alchemy has driven that cost
  close to zero.
- **Integrate** — a candidate `iac-alchemy` adapter alongside Pulumi, Terraform, OpenTofu and
  Crossplane, none primary.
- **Benchmark** on time-to-write-a-new-provider.
- **Displace** only on the narrow provisioning-core surface.

## Threats and lessons

1. **Provider-authoring cost is the ecosystem lever.** HoBo's generation pipeline is a bet on the
   same insight; Alchemy achieves it with plain functions and no generation at all.
2. **Engine-less is a legitimate architecture** and a reminder that a heavyweight reconciler is a
   choice, not a requirement — worth revisiting when HoBo justifies its own machinery.
3. **LLM-authored ecosystems are arriving.** Verification and conformance testing become the
   differentiator once authoring is cheap, which is exactly what HoBo's conformance gating claims.
4. **Generational rewrites cost adopters.** Third corpus occurrence after Amplify and Upsun.

## Refresh 2026-11-08 — beta.85 shipped, beta.86 merged-to-main

Deltas verified against npm, GitHub releases/PRs, and alchemy.run docs. Body text above is the Aug capture with status/provider/CI claims corrected in place.

- **Shipped since Aug:** GCP, Fly, Hetzner, Railway, Kubernetes, Prisma, Turso, ACME, Stripe v2 (beta.78); `@alchemy.run/domain` (app-level event-sourced DDD/CQRS on Durable Objects + MCP/AI tools — not a control-plane audit log, but the Aug "no MCP / no event log / agents not principals" claims need this qualifier); Effect Workflows; per-cloud state defaults (DynamoDB new AWS default beta.85, GCS, CF-DO); `drift`, programmatic Alchemist API, Provider Contributions; frontend-frameworks x14; AI bindings (Workers AI, Bedrock/AgentCore, Vertex).
- **beta.86 (merged to main, unpublished on npm at check):** sandbox providers Modal/E2B/Daytona/Archil/Boat behind a unified Sandbox handle; Rivet; Effect Cluster; Domain host-as-Layer; `Resource.lookup`; 16 breaking commits. No milestone or GA date exists; beta.86 post was draft PR #3169.
- **Not in beta.86:** Vercel full provider and Azure (open draft PRs), Convex/STACKIT (drafts), Portless (open PRs), Netlify (issue-only), Render (no evidence found).
- **HoBo response:** local-first parity programme — measured L1/L2/L3 local levels primary (code-derived table via `@hobo/cloud-providers` `providerParity()`), cloud live parity as fallback. Sandbox/Domain claims rest partly on npm-unpublished packages; treat as merged-not-shipped until a dist-tag proves otherwise.

## Sources

- [alchemy.run/docs](https://alchemy.run/docs/) — resources, scopes, state stores, v2 Effect model
- [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy) — source and provider ecosystem
- [devtools.fm episode 138](https://www.devtools.fm/episode/138) and [effect.website](https://effect.website) — background on the Effect-based v2 direction

This capture predates the research contract and was restructured to it on 2026-08-20 with its original research preserved, and refreshed 2026-11-08 (status, provider inventory, CI stage naming re-verified; per-resource enumeration inside the big-three distilled SDKs was not opened and is not asserted).
