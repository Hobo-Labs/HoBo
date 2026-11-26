---
type: Competitive Reference
title: "Lakebed — Competitor Reference"
description: "Lakebed is an agent-native closed PaaS: one full-stack TypeScript app per 'Capsule' on Lakebed's own hosted runtime, sync RPC (queries/mutations), machine-readable contracts (llms.txt), and instant zero-config onboarding."
tags: [hobo, competitors]
competitor:
  slug: lakebed
  name: "Lakebed"
  primary_category: cloud-application-platforms
  categories: [cloud-application-platforms, agentic-infrastructure]
  directness: direct
  role: "agent-native closed PaaS (Capsules, sync RPC, llms.txt) — named head-on competitor"
  posture: [displace]
  hobo_surface: [agent-surface, authoring, delivery]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://docs.lakebed.dev/
---

# Lakebed — Competitor Reference

> Captured for HoBo competitive analysis (research as of 2026-07, from [docs.lakebed.dev](https://docs.lakebed.dev/) / [llms.txt](https://docs.lakebed.dev/llms.txt) / [llms-full.txt](https://docs.lakebed.dev/llms-full.txt)). A faithful capture of Lakebed's developer surface — capsule layout, server/client contracts, CLI, deploy, auth, and inspection — reproduced as factual API/CLI excerpts under the [fair-use note](index.md#sources--fair-use). HoBo↔Lakebed parity in [HoBo mapping](#primitive-mapping).

**Lakebed** is an **alpha-stage, agent-native CLI and runtime** for building small **full-stack TypeScript apps** called **capsules** — *"the whole app"* in one directory: server contract, Preact client, typed state, auth, logs, and a deploy URL. Agents are the primary builder persona: machine-readable docs (`llms.txt`, `llms-full.txt`, `docs.json`) and a single `capsule()` server definition are meant to be authored, inspected, and deployed without leaving code.

| Dimension | Lakebed |
|---|---|
| Category | Agent-native closed PaaS |
| Unit of deploy | **Capsule** — one full-stack TS app on Lakebed's runtime |
| Cloud model | Single closed hosted runtime (Lakebed Cloud); optional `--api` for private workspace |
| Runtime model | **Synchronous RPC** — server-authoritative `query` / `mutation` handlers; bundled server JS in a restricted source runtime on anonymous deploys |
| Data model | Declarative `schema` tables (`string`, `boolean`, `.default()`); `ctx.db` with `where` / `orderBy` / `limit` / `all` / `get` / `insert` / `update` / `delete` |
| Client model | Preact UI; `useQuery` / `useMutation` subscribe/call server handlers; built-in client router |
| Agents | First-class docs (`llms.txt`); agents read contracts and drive the CLI lifecycle |
| Auth | Guest by default; **Google sign-in** built-in; dev guest switching (`npx lakebed auth as alice`) |
| Self-host | ❌ (hosted runtime; contributors can run `@lakebed/hosted` locally for deploy testing) |
| Escape hatches | **HTTP `endpoint`s** + **`.env.lakebed.server`** server env only; no exposed IaC, no arbitrary npm imports (v0) |
| Onboarding | `npx lakebed new` → `npx lakebed dev`; **anonymous `npx lakebed deploy`** first (zero account) |

Lakebed is a **named head-on competitor** to HoBo as an **AI-native meta-cloud** ([ADR-0064](../design/adr/07-portability-extensibility.md#adr-0064)): it optimizes ruthlessly for agent-authored, instant-on full-stack apps on a closed runtime. HoBo tracks it because vision.md borrows its onboarding and machine-readable-contract ethos while deliberately offering cloud-agnostic ports, durable workflows, and adopt-in-place migration.

## What it is

Lakebed targets **agents and developers building small full-stack TypeScript apps** where the platform owns the runtime, database, auth, bundling, and hosting. The pitch is operational simplicity: *"If you are an agent building with Lakebed, treat the capsule directory as the whole app. Write the server contract, write the Preact client, run the Lakebed CLI, inspect the runtime state, and deploy without leaving code."* ([docs.lakebed.dev](https://docs.lakebed.dev/))

HoBo names Lakebed in the **Convex / Lakebed / Nitric** head-on set because both products promise AI-native developer velocity — but Lakebed is a **closed single-runtime PaaS**, while HoBo is a **cloud-agnostic control plane + durable runtime** that can self-host and import existing estates.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Capsule** | The deployable unit — the platform's application abstraction |
| **Sync RPC** | The calling convention between capsules |
| **`llms.txt`** | The agent-facing description of the platform, published as a first-class artifact |

The mental model is **a PaaS whose primary user is an agent**. Lakebed's positioning treats the
coding agent as the consumer of the platform, with documentation and interfaces shaped accordingly.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `agent-surface` | Agent-first platform interfaces |
| `authoring` | Capsules as the application abstraction |
| `delivery` | Deployment of capsules |

Lakebed is recorded in this corpus as a **named head-on competitor** on the agent-native PaaS
positioning, and the honest assessment is that the positioning overlaps far more than the
architecture does.

## Feature surface

### Capsule model & deployment

A **capsule** is one complete Lakebed app: source, server API, client UI, state, auth, logs, and deploy URL. V0 expects:

```txt
server/index.ts
client/index.tsx
shared/
.env.lakebed.server
```

- `server/index.ts` — exports a default `capsule({ schema, queries, mutations, endpoints })` definition.
- `client/index.tsx` — exports the Preact `App` component.
- `shared/` — pure TypeScript shared by server and client (no runtime/DOM/Node/env imports).
- `.env.lakebed.server` — optional server-only env (never exposed to client or anonymous artifacts).

**CLI lifecycle:**

```sh
npx lakebed new my-app --template todo
cd my-app
npx lakebed dev
npx lakebed deploy
```

`npx lakebed create` is an alias for `npx lakebed new`. New capsules get a git repo + initial commit unless created inside an existing repo or `--no-git` is passed.

**Deploy behavior:**

- **Anonymous deploys work first** — no account required; returns a live URL immediately.
- **Claim** when the app needs hosted server env sync or outbound server-side `fetch`; then `npx lakebed deploy` again.
- **Owned deploys:** `npx lakebed auth login` before first deploy; Lakebed writes `lakebed.json` (`deployId` only) at the capsule root for CI/fresh-checkout deploys.
- **CI tokens:** `npx lakebed token create --name github-actions` (deploy-scoped) or `--personal` for owner-wide automation; supply as `LAKEBED_TOKEN` (+ `LAKEBED_TOKEN_API` when using custom `--api`).
- **Domains (claimed deploys):** `npx lakebed domains add my-app.lakebed.app`
- **Public inspection (demos):** `npx lakebed deploy --public-inspect`

There is no `lakebed.config.ts` in v0.

### Runtime model

Server handlers are **synchronous RPC**: queries read, mutations write, all **server-authoritative**. The default export from `server/index.ts`:

```ts
import { capsule, endpoint, json, mutation, query, string, table, text } from "lakebed/server";

export default capsule({
  schema: {
    messages: table({
      body: string(),
      authorId: string()
    })
  },
  queries: {
    messages: query((ctx) =>
      ctx.db.messages
        .where("authorId", ctx.auth.userId)
        .orderBy("createdAt", "desc")
        .all()
    )
  },
  mutations: {
    sendMessage: mutation((ctx, body: string) =>
      ctx.db.messages.insert({ body, authorId: ctx.auth.userId })
    )
  },
  endpoints: {
    webhook: endpoint({ method: "POST", path: "/webhooks/incoming" }, async (ctx, req) => {
      if (req.headers.get("x-webhook-secret") !== ctx.env.WEBHOOK_SECRET) {
        return text("unauthorized", { status: 401 });
      }
      const payload = await req.json<{ body: string }>();
      ctx.db.messages.insert({ body: payload.body, authorId: "webhook" });
      return json({ ok: true });
    })
  }
});
```

Handler context:

- `ctx.auth` — current guest or Google identity.
- `ctx.db` — typed table access.
- `ctx.env` — server-only values from `.env.lakebed.server`.
- `ctx.log` — structured logs captured by the runtime.

**Server authority pattern:** filter user-owned rows by `ctx.auth.userId` in queries; re-check ownership inside mutations before updates/deletes. Anonymous deploys run bundled server JavaScript in a **restricted source runtime** so ordinary JavaScript authorization checks stay authoritative (IR is a future optimization only when it preserves full handler semantics).

**Client subscription model:**

```tsx
import { useAuth, useMutation, useQuery, SignInWithGoogle, signOut } from "lakebed/client";

const messages = useQuery<Message[]>("messages");
const sendMessage = useMutation<[body: string], void>("sendMessage");
```

- `useQuery("name")` subscribes to a server query (reactive push on write).
- `useMutation<TArgs, TResult>("name")` calls a server mutation (returns a promise).
- Client routes via `Router` / `Routes` / `Route` / `Link`; **declared server `GET` endpoints take precedence** over client routes for direct HTTP requests.

**V0 limits (runtime):**

- One server entry (`server/index.ts`), one client entry (`client/index.tsx`).
- No arbitrary npm imports inside capsule code yet.
- No Node built-ins inside capsule modules.
- Local state is **in-memory** and resets when `npx lakebed dev` restarts.
- No file storage in v0.
- Anonymous deploys **disable outbound server-side `fetch`**.
- Non-empty `.env.lakebed.server` requires a claimed deploy before hosted env can sync.

### Machine-readable contracts

Lakebed publishes agent-oriented documentation entrypoints:

- [`llms.txt`](https://docs.lakebed.dev/llms.txt) — curated doc index with Markdown URLs.
- [`llms-full.txt`](https://docs.lakebed.dev/llms-full.txt) — concatenated full public docs.
- [`docs.json`](https://docs.lakebed.dev/docs.json) — programmatic doc metadata.

The site is static HTML; agents are directed to prefer Markdown links or `docs.json` when parsing programmatically. Reference pages include [`capsule-api`](https://docs.lakebed.dev/capsule-api/), [`reference`](https://docs.lakebed.dev/reference/), and working [`examples`](https://docs.lakebed.dev/examples/) (todo, guestbook).

### Onboarding & local ergonomics

Lakebed optimizes for **zero-friction first run**:

```sh
npx lakebed new my-app --template todo
cd my-app
npx lakebed dev
```

**Local inspection** (while dev is running):

```sh
npx lakebed db list --port 3000
npx lakebed db dump --port 3000
npx lakebed logs --port 3000
```

**Hosted inspection:**

```sh
npx lakebed inspect <deploy-id-or-url>
npx lakebed db dump <deploy-id-or-url>
npx lakebed logs <deploy-id-or-url>
```

Local inspection is open on localhost. Hosted deploys keep manifests, state, table names, logs, and usage **private by default** unless `--public-inspect` was used.

**Anonymous deploy** is the instant try-it-now path: publish first, claim later when env/outbound fetch is needed — the Lakebed-style instant feel HoBo explicitly matches with `npx hobo up` anonymous deploys ([Plan 7](../design/developer-experience.md#plan-07)).

### Auth

Every capsule starts with **guest auth**. Dev identity switching:

```sh
npx lakebed auth as alice
# or per-tab: http://localhost:3000/?lakebed_guest=alice
```

Auth shape (client and server):

```ts
type Auth = {
  userId: string;
  displayName: string;
  provider: "guest" | "google";
  isGuest: boolean;
  isAuthenticated: boolean;
  isLoading?: boolean; // client-only
  email?: string;
  emailVerified?: boolean;
  picture?: string;
};
```

Client helpers: `useAuth()`, `SignInWithGoogle`, `signInWithGoogle()`, `signOut()`. Production Google sign-in is the built-in path; there is no documented workload/agent identity layer beyond app user auth.

### Escape hatches & lock-in

| Escape | What Lakebed exposes |
|---|---|
| HTTP APIs / webhooks | `endpoint({ method, path }, handler)` with `req.headers`, `req.query`, `req.text()` / `json()` / `bytes()` |
| Server secrets / config | `.env.lakebed.server` → `ctx.env` (server-only; syncs to hosted deploy after claim) |
| IaC / multi-cloud | ❌ hidden — no Terraform/Pulumi surface |
| Self-host runtime | ❌ — hosted Lakebed runtime (private workspace via `--api` for contributors only) |
| Arbitrary dependencies | ❌ (v0) — no arbitrary npm imports; Lakebed-provided Preact modules + relative imports only |
| Migration off-platform | Rewrite off the `lakebed/server` + `lakebed/client` SDK — no import/adopt path documented |

## Architecture

- **Closed platform.** Capsules run on Lakebed; there is no self-hosting story and no portable
  artifact.
- **Sync RPC** between capsules as the composition mechanism.
- **`llms.txt`** as the agent-discovery surface — a small, genuinely good idea: publishing a
  machine-readable description of the platform so an agent can use it without scraping documentation.
- **State authority** — the platform's.
- **Portability boundary** — none. A capsule is a Lakebed artifact.

## Where Lakebed is stronger

> Shipped, evidenced capability only.


### Headline differentiators

1. **Agent-native docs** — `llms.txt` / `llms-full.txt` / `docs.json` are first-class; the capsule API page is written for agents authoring apps.
2. **Ruthless onboarding** — `npx lakebed new` → `npx lakebed dev`; anonymous deploy before account creation.
3. **Single-directory full-stack** — schema + queries + mutations + Preact client in one capsule; no separate IaC or infra repo.
4. **Server authority by default** — queries/mutations are the source of truth; client hooks subscribe/call; authorization stays in ordinary TypeScript control flow.
5. **Inspectable runtime** — `db list` / `db dump` / `logs` / `inspect` before guessing at state.
6. **Machine-readable + simple auth** — guest + Google sign-in with minimal ceremony.

## Adversarial critique


- **Closed single runtime** — capsules run on Lakebed's hosted runtime; no cloud-agnostic ports or provider mix.
- **No self-host parity** — cannot run the production runtime on your own infra (unlike HoBo's Yard-is-a-Bindle model).
- **No durable workflows / actors / event sourcing** — sync RPC only; no choreography sagas or replayable audit log.
- **No IaC escape hatch** — cannot drop to Pulumi/Terraform or pin tiers to AWS/GCP/Azure independently.
- **No adopt-in-place migration** — leaving Lakebed means rewriting off the SDK; HoBo's `hobo import lakebed` targets Capsule→Bindle mapping ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)).
- **Basic auth only** — guest/Google for end users; no first-class agent principals, MCP control plane, or brokered workload tokens.
- **V0 platform limits** — no file storage, no arbitrary npm deps, no Node built-ins, local state resets on dev restart.
- **Alpha maturity** — docs describe v0 constraints explicitly; production hardening (multi-region, enterprise governance) is not surfaced.

## Primitive mapping

<a id="hobo-mapping"></a>

> For every Lakebed feature, the HoBo equivalent and the design doc that owns it. ✅ = designed at parity · ➕ = HoBo goes further · 🔜 = planned, see iteration hooks. HoBo design lives in [`../design/`](../design/index.md).

### Core model

| Lakebed | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| **Capsule** (one full-stack TS app) | **Bindle** (app topology mapped to any provider mix) | ➕ | [21](../design/authoring-resources-wiring.md#plan-21), [02](../design/sdk-api.md#plan-02) |
| `capsule({ schema, queries, mutations })` | IfC resources + services behind WIT ports; manifest IR from collection | ➕ | [21](../design/authoring-resources-wiring.md#plan-21), [22](../design/authoring-resources-wiring.md#plan-21) |
| Closed hosted runtime | **Camps** + pluggable providers; self-hosted **Yard** | ➕ | [04](../design/control-plane.md#plan-04), [ADR-0031](../design/adr/01-architecture-core.md#adr-0031) |
| Sync RPC queries/mutations | **Actors + durable workflows + choreography sagas** over replayable event store | ➕ | [02](../design/sdk-api.md#plan-02), [11](../design/data-plane.md#plan-11) |
| `useQuery` / `useMutation` client hooks | `useQuery()` reactive primitive + event-log reactor ([ADR-0050](../design/adr/03-data-plane.md#adr-0050)) | ➕ | [32](../design/data-plane.md#plan-32) |
| `llms.txt` / agent-readable app contracts | `llms.txt` / `docs.json` for **operations** + **MCP** control surface | ➕ | [06](../design/ai-native-agent-auth.md#plan-06) |
| Anonymous deploy → claim | Anonymous `npx hobo up` → `hobo claim` | ✅ | [07](../design/developer-experience.md#plan-07) |
| `npx lakebed dev` instant local | `hobo dev` on `runtime-local` + fidelity matrix | ✅/➕ | [07](../design/developer-experience.md#plan-07), [ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042) |
| Guest + Google auth | End-user auth via `auth()` port + **agents as first-class principals** | ➕ | [06](../design/ai-native-agent-auth.md#plan-06), [ADR-0038](../design/adr/02-identity-security.md#adr-0038) |
| `endpoint` HTTP escape hatch | `api` / HTTP actions + ingress/domain ports | ✅ | [21](../design/authoring-resources-wiring.md#plan-21), [ADR-0035](../design/adr/07-portability-extensibility.md#adr-0035) |
| `.env.lakebed.server` server env | Secretless `ctx.env` via references + brokered tokens per Camp | ➕ | [21](../design/authoring-resources-wiring.md#plan-21) |
| Runtime inspect (`db`/`logs`/`inspect`) | `hobo inspect` / logs / replay / MCP projections | ➕ | [07](../design/developer-experience.md#plan-07), [14](../design/reliability-observability-cost.md#plan-05) |

### Competitive frame (from design suite)

| Dimension | Lakebed | HoBo |
|---|---|---|
| Unit of deploy | Capsule (one full-stack TS app on their runtime) | **Bindle** (app topology mapped to *any* provider mix) |
| Cloud model | Single closed hosted runtime | **Cloud-agnostic** ports/adapters, multi-provider, self-hostable |
| IaC | Hidden, none exposed | Pluggable **IaC providers** (Pulumi/Crossplane/Terraform/OpenTofu) |
| Runtime model | Synchronous RPC (queries/mutations) | **Actors + durable workflows + choreography sagas** over a replayable event store |
| Agents | Agent-readable contracts; basic guest/Google auth | **Agents as first-class authenticated principals**; auto-token issuance via capability standard; durable AI agents; MCP control surface |
| Extensibility | Community / first-party | **AI-generated provider plugins** gated by conformance tests |

### Where HoBo deliberately exceeds Lakebed

From vision.md's borrow-and-extend list ([Plan 17](../design/vision.md#plan-17)):

- **Machine-readable contracts extended to operations** — Lakebed's `llms.txt` covers app authoring; HoBo publishes `llms.txt` / `docs.json` for *operations* and exposes MCP tools for deploy/inspect/audit ([Plan 6](../design/ai-native-agent-auth.md#plan-06)).
- **Incremental adoption** — `hobo import lakebed` maps Capsule→Bindle in place ([ADR-0041](../design/adr/07-portability-extensibility.md#adr-0041)); Lakebed offers no strangler-fig path off its runtime.
- **Cloud-agnostic + self-host** — same Bindle ships to one provider or many; Yard-is-a-Bindle self-host parity ([Plan 4](../design/control-plane.md#plan-04)).
- **AI-native operations** — generation pipeline, Operator Agents (the Crew), event-sourced everything — not just agent-readable apps.

### Open parity items (iteration hooks)

- **Single-runtime simplicity as a DX bar** — Lakebed's one-directory, zero-config capsule is the onboarding benchmark HoBo must match via `hobo dev` + anonymous deploy even while offering more surface area.
- **Full-stack UI in one artifact** — Lakebed bundles Preact client + server in one capsule; HoBo's UI generation is design.md-driven behind `ui-render` ports ([Plan 23](../design/generated-stack.md#plan-23)) — parity is intentional breadth, not identical shape.
- **Capsule→Bindle import mappings** — ADR-0041 names `hobo import lakebed`; detailed field-level mapping conformance is an implementation hook.

## Sources & provenance

Primary sources (fetched 2026-07-02):

- [Lakebed Docs](https://docs.lakebed.dev/) — overview, capsule layout, limits ([`index.md`](https://docs.lakebed.dev/index.md))
- [Lakebed Reference](https://docs.lakebed.dev/reference/) — capsule contract, server/client API, CLI ([`reference/index.md`](https://docs.lakebed.dev/reference/index.md))
- [Capsule API](https://docs.lakebed.dev/capsule-api/) — agent-oriented authoring shapes ([`capsule-api/index.md`](https://docs.lakebed.dev/capsule-api/index.md))
- [llms.txt](https://docs.lakebed.dev/llms.txt) · [llms-full.txt](https://docs.lakebed.dev/llms-full.txt) · [docs.json](https://docs.lakebed.dev/docs.json) — machine-readable entrypoints
- [Examples](https://docs.lakebed.dev/examples/) — todo, guestbook working capsules

In-repo characterizations consolidated into this capture (cross-checked, not contradicted):

- `docs/design/vision.md:50` (landscape row) · `docs/design/vision.md:70,80,89,108` (borrows, head-on set, import, risk mitigation)
- `docs/design/index.md:137-144` (competitive frame table)
- `docs/design/developer-experience.md:138,155` (local ergonomics, anonymous deploy)
- `docs/design/ai-native-agent-auth.md:155` (llms.txt ethos)
- `docs/design/adr/07-portability-extensibility.md#adr-0041` (`hobo import lakebed`)

These files are **competitive-research notes** under [`index.md#sources--fair-use`](index.md#sources--fair-use): factual interface excerpts are quoted for commentary and parity comparison; product names and documentation remain Lakebed's property.

## Where HoBo is stronger or intentionally different

State labels follow the research contract.

- **Open and self-hostable** (*implemented*): HoBo runs locally, in-browser and hosted, against
  providers the customer chooses.
- **Agent actions are contract-bounded and recorded** (*implemented*), which is a materially
  different claim from agent-friendly documentation.
- **Provider-abstract description** (*implemented*) versus a platform-specific capsule.
- **Honest caveat.** Lakebed ships a running platform; HoBo's provider coverage is partial (see the
  [live provider matrix](../design/live-provider-matrix.md)).

## Better-together / integration posture

- **Displace** — this is the corpus's clearest head-on positioning competitor for the agent-native
  platform narrative, and should be treated as such.
- **Borrow** — **`llms.txt` as a first-class agent-discovery artifact**. HoBo already publishes
  `site/public/llms.txt`; the lesson is to treat it as a product surface rather than a documentation
  convenience.
- Not an adopt, provider or integrate target.

## Threats and lessons

1. **The agent-native narrative is contested**, and narrative alone is winnable by whoever markets
   hardest. HoBo's defensible version is mechanical — contracts, policy gates, recorded decisions —
   and must be stated that way rather than as a claim to be AI-native.
2. **Closed platforms make the openness argument for you.** An agent-operated platform that cannot be
   self-hosted is a strong illustration of why HoBo's posture matters.
3. **`llms.txt` is cheap and effective**, and worth maintaining deliberately.
