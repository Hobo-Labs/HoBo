---
type: Maintenance Note
title: "Alchemy auth, secrets, and onboarding audit"
description: "Maps Alchemy auth providers, secrets, Better Auth, Domain, and testing docs to HoBo's auth, secrets, and onboarding code; gaps for durable and cross-machine sessions."
tags: [hobo, auth, secrets, alchemy, better-auth, onboarding, maintenance]
---

# Alchemy-aligned auth, secrets, and onboarding — codebase audit

**Date checked:** 2026-11-25  
**Alchemy doc index:** [`https://alchemy.run/llms.txt`](https://alchemy.run/llms.txt) (v2 beta; HoBo pins `alchemy@2.0.0-beta.87`)  
**Request:** Map Alchemy's auth providers, secrets/config, secret providers, Better Auth, Domain, and testing model onto HoBo's current auth, secrets, and onboarding surfaces. Identify what is already built, what ADRs already decided, and what implementation remains for **durable sessions across restart** and **sessions across machines**.

This document is evidence for implementation work; it does not replace [`docs/design/adr/02-identity-security.md`](../design/adr/02-identity-security.md) (ADR-0038, ADR-0113, ADR-0161) or [`docs/competitors/alchemy.md`](../competitors/alchemy.md).

---

## 1. Alchemy capabilities (2026-11-25 docs)

### 1.1 Auth providers (deploy / cloud API credentials)

Source: [`environments/auth-providers`](https://alchemy.run/environments/auth-providers), [`cli/profile`](https://alchemy.run/cli/profile).

| Concept | Behavior |
| --- | --- |
| **AuthProvider** | Per-cloud registry entry: `configure`, `login`, `logout`, `details`, `read` as Effects; optional `readEnvironment` for CI (`CI=true`) or when required env vars are all set |
| **Profiles** | `~/.alchemy/profiles.json` + `~/.alchemy/credentials/{profile}/`; lazy credential Effects with refresh (e.g. OAuth refresh under file lock) |
| **Resources** | API keys are not resource props; lifecycle code `yield*` environment services that re-resolve credentials per request |
| **CI** | `readEnvironment` + declared `environment` contract; `alchemy provider check-env` preflight |

HoBo analogue today is **infrastructure ownership**, not cloud API deploy auth: owner store session (`owner://`), GitHub App installation tokens, and MCP `choose_secret_store` — not Alchemy profiles.

### 1.2 Secrets and config (application/runtime binding)

Source: [`environments/secrets`](https://alchemy.run/environments/secrets).

| Concept | Behavior |
| --- | --- |
| **Construction vs runtime** | `yield*` `effect/Config` during resource **Construction** so values bind to Worker/Lambda env; runtime-only `yield*` in `fetch` does **not** bind |
| **Redacted** | `Config.Redacted` for deploy-time binding; async Workers use `env: { API_KEY: Config.Redacted("API_KEY") }` |
| **Per stage** | Values come from whoever runs deploy; stage/profile isolation is ordinary code |

HoBo analogue: **secretless-first** (`secretRef`, `owner://`, brokered material) per ADR-0027/0113; camp resolution ladder — not Effect `Config` binding on Workers.

### 1.3 Secret providers (where Config values load from)

Source: [`environments/secret-providers`](https://alchemy.run/environments/secret-providers).

| Concept | Behavior |
| --- | --- |
| **Stack `secrets`** | Ordered list: DotEnv, Doppler, Infisical, custom `ConfigProvider` layers; **later overrides earlier**; process env is implicit last |
| **Stage callbacks** | `secrets: ({ stage }) => …` for dev vs prod sources |
| **Exemptions** | `ALCHEMY_PROFILE` never from providers; Doppler/Infisical tokens read from process env only |
| **Debug** | Names loaded, never values |

HoBo analogue: owner-chosen **SecretsPort** adapters (1Password, Bitwarden, Infisical, auth-md claim path) at **owner** scope, not per-stack Effect providers.

### 1.4 Better Auth on Alchemy

Sources: [`better-auth`](https://alchemy.run/better-auth), [`what-is-better-auth`](https://alchemy.run/better-auth/what-is-better-auth), [`guides/configuration`](https://alchemy.run/better-auth/guides/configuration), [`guides/secondary-storage`](https://alchemy.run/better-auth/guides/secondary-storage), database/sign-in tutorial pages in llms.txt.

| Concept | Alchemy behavior | Session / restart / multi-box |
| --- | --- | --- |
| **Service shape** | `BetterAuth({ … })` as Effect `Context.Service`; DB via Layer (`CloudflareD1`, Neon, Postgres, …) | Sessions in DB when configured; migrations on deploy |
| **Signing secret** | Omitted `secret` → Alchemy provisions random secret, **persisted in Alchemy state** across deploys | Cookie integrity survives redeploy |
| **OAuth/client secrets** | `Config` / env bindings at construction | Stable across deploy if state + env stable |
| **Secondary storage** | Optional `SecondaryStorage` Layer (e.g. Upstash Redis REST): `get/set/delete/getAndDelete/increment`; used for sessions/rate limits when configured | **Strong consistency required**; `storeSessionInDatabase: true` does not replace secondary reads — shared Redis enables multiple Workers/regions if DB + Redis are shared |
| **baseURL** | `AUTH_BASE_URL` optional; else derived from request | Cross-box browser login needs consistent cookie domain / trusted origin configuration ([`neon/guides/production-auth`](https://alchemy.run/neon/guides/production-auth)) |
| **Host portability** | Same `auth.fetch` on Workers and Lambda | Requires shared DB (+ optional Redis), not isolate-local memory |

### 1.5 Domain (DDD + testing stories)

Source: [`domain`](https://alchemy.run/domain).

| Concept | Behavior |
| --- | --- |
| **Model** | Commands, aggregates, events, views, projections, policies; `@alchemy.run/domain` |
| **Tests** | In-memory **stories** (`Story.given/when/then`); production on Cloudflare DO / Rivet / Effect Cluster |
| **Agent skill** | `alchemy-domain` shipped with package |

HoBo analogue: CQRS/event store/actors (ADR-0135) and draft proofs; **no** Alchemy Domain dependency. Onboarding **design** contracts exist ([`docs/design/workspace-onboarding-ux.md`](../design/workspace-onboarding-ux.md)); they are not wired to Alchemy Domain stories.

### 1.6 Testing

Sources: [`testing`](https://alchemy.run/testing), [`testing/testing-a-stack`](https://alchemy.run/testing/testing-a-stack), [`testing/test-harness`](https://alchemy.run/testing/test-harness).

| Concept | Behavior |
| --- | --- |
| **Default** | Real cloud: `beforeAll(deploy(Stack))` → HTTP assertions → `afterAll(destroy)` |
| **Stage** | `test_$USER`, `ci-pr-N` isolation |
| **Local** | `dev: true` → workerd emulators, same suite |
| **Runner** | `@alchemy.run/test` adapters for alchemy-test, Bun, Vitest |

HoBo analogue: PACT/mocked boundaries policy (no default live E2E); `@hobo/iac-alchemy` uses Alchemy in **package tests** (secrets, state, Rivet/Cloudflare fixtures); root `test:behavior` for fleet onboarding. ADR-0159 targets **credentials-as-code CI + OOB harness** aligned with Alchemy's deploy-test loop — partially reflected in iac-alchemy tests, not yet an auth onboarding story suite on Alchemy `Test.make`.

---

## 2. HoBo inventory (current code)

### 2.1 Planes (do not conflate)

| Plane | Packages / entry | Purpose |
| --- | --- | --- |
| **End-user / app auth (`hobo:auth`)** | `bindles` `auth()`, `@hobo/adapter-better-auth`, design proofs under `hobo-63-*` / ADR-0038 | JWT verify, session verbs on port; issuer adapters |
| **Human / owner infrastructure** | `packages/hobo` owner store session, `hobo login`, MCP `choose_secret_store` | CI/CD credentials, relay; **not** app user sessions |
| **Agent principals** | `@hobo/auth-md` | OAuth anonymous agent + human claim; separate from `hobo login` |
| **Fleet device enrollment** | `@hobo/fleet-authority`, `@hobo/fleet` | RS256 enrollment tokens, OIDC/GitHub/atproto sign-in for **devices** |
| **Relay secret store onboarding** | `@hobo/secret-store-claim` | Claim bundle for Infisical / auth-md / Cloudflare temporary (ADR-0179 amendment) |

Tyler's request targets **HoBo product auth** using Alchemy's Better Auth + secrets stack — i.e. **`hobo:auth` bundle + deploy/onboarding**, not replacing owner store or fleet authority.

### 2.2 Better Auth adapter (`@hobo/adapter-better-auth`)

**Status:** Descriptor, parse boundaries, claims mapping, PACT (pact_only). **No** `better-auth` npm dependency, **no** HTTP server, **no** migrations, **no** route mount.

Documented honest scope: [`packages/adapters/adapter-better-auth/README.md`](../../packages/adapters/adapter-better-auth/README.md).

ADR-0161 decisions already recorded:

- Auth bundle over `hobo:data/relational` + **brokered** `secretRef` (not Alchemy state-persisted `Alchemy.Random`).
- Routes on `api()`/`web()` via membrane portability (not N platform layers).
- Runtime gated: `assertBetterAuthRuntimeAvailable` fails closed.

**Gap vs Alchemy:** entire **runtime composition** (DB Layer, Better Auth instance, `auth.fetch`, middleware, secondary storage) is unimplemented in packages; adapter is planning/conformance only.

### 2.3 Secrets and config

| Area | Status |
| --- | --- |
| **Authoring** | `@hobo/bindles` `secret.string().source(...)`, `secretRef`; gate `evaluateSecretlessConfigGate` |
| **Resolution** | `@hobo/identity` `resolveConfigSchema` ladder (ADR-0027) |
| **Owner store** | `packages/hobo/src/owner-store-session.ts` — Infisical / 1Password / Bitwarden sign-in, `owner://` resolver for CD |
| **Relay claim** | `@hobo/secret-store-claim` — provision + one-time claim actions |
| **IaC secrets** | `@hobo/iac-alchemy` — Redacted fingerprinting, Cloudflare secret name derivation, `secret-persistence.test.ts` proves Alchemy **state** round-trip for redacted props (host-owned state dir), not Better Auth signing secret |

**Gap vs Alchemy secret providers:** HoBo has no stack-level `secrets: [DotEnv, Doppler, …]` equivalent on Yard/Station; binding is camp/owner mediated. For Better Auth OAuth client ids, Alchemy expects Construction-time `Config` discovery; HoBo expects **locators** and brokered resolution at runtime/deploy gates.

### 2.4 IaC Alchemy (`@hobo/iac-alchemy`)

**Status:** Production-portable IaC adapter (Cloudflare, Rivet extensions), heavy test surface, pinned `alchemy@2.0.0-beta.87`.

Explicit non-binding note for auth primitive:

```131:131:packages/iac/iac-alchemy/src/cloudflare.ts
		auth: "Auth.OAuthClient and AuthProvider are available, but HoBo identity verification and sessions are not bound.",
```

**Gap:** No bridge from Alchemy `AuthProvider` registry to HoBo owner session; no `BetterAuth` resource mapping in iac-alchemy.

### 2.5 Onboarding

| Surface | Status |
| --- | --- |
| **Workspace onboarding UX** | Design contracts + telemetry map (`docs/design/workspace-onboarding-ux.md`); M0 evidence-oriented |
| **Secret store claim** | Implemented claim plane for relay owner |
| **Owner MCP onboarding** | `choose_secret_store`, owner page tests in `packages/hobo/test/mcp-*.test.ts` |
| **Alchemy Domain stories** | Not present for auth onboarding |

**Gap:** No step-by-step **executable** onboarding path that provisions Better Auth + shared session store + verifies login from a second host, using Alchemy `Test.make` or HoBo draft proofs.

### 2.6 Human `hobo login` vs app sessions

`hobo login` (see `packages/hobo/README.md`) — fixture/OIDC under `HOBO_HOME`, relay variant — is **operator session** for CLI, not the Better Auth cookie session for app users. Documentation must keep these separate when wiring Alchemy Better Auth.

---

## 3. Goal gap analysis

### 3.1 Sessions survive HoBo restarts

| Requirement | Alchemy pattern | HoBo today | Gap |
| --- | --- | --- | --- |
| Session rows durable | Relational DB + migrations on deploy | Adapter **declares** `hobo:data/relational`; no bundle provisions store or runs Better Auth migrations | Implement relational bindle + ADR-0160 migration gate for Better Auth schema |
| Cookie signing key stable | `Alchemy.Random` persisted in state | ADR-0161: **brokered** `secretRef`, never IaC state file | Provision secret once into brokered custody; same locator across restarts |
| Process restart | DB + secret stable → sessions valid | No running Better Auth runtime | Ship bundle runtime + integration tests |
| Deploy/restart of **HoBo control plane** | Alchemy state store separate from app DB | Owner store ≠ session DB | Session DB must be a declared app resource, not `HOBO_HOME` sqlite |

### 3.2 Sessions work logging in from a different box

| Requirement | Alchemy pattern | HoBo today | Gap |
| --- | --- | --- | --- |
| Shared session state | DB (+ optional Redis secondary with consistency contract) | No shared session layer | Deploy relational store accessible from all app instances; optional secondary storage port adapter (Redis-class) if not relying on DB-only session mode |
| Cookie scope | `baseURL` / trusted origins / HTTPS | Config parse has `basePath`; no runtime cookie policy | Production auth guide parity: trusted origins, OAuth callbacks, SMTP |
| Multiple Workers/regions | Secondary storage guide (Redis REST) | Not implemented | If horizontal scale: implement `SecondaryStorage` behind `hobo:` port or host-specific Layer in bundle |
| Browser on machine B | Same API origin or shared parent domain | Named endpoints ADR-0130 (`.hobo.localhost` / `.hobo.test`) for local overlay | Wire auth routes to stable named URL; test cross-host with two browsers or HTTP clients sharing cookie jar |

### 3.3 Use Alchemy auth providers, secrets, secret providers

| Alchemy piece | Intended use in HoBo auth work | Fit |
| --- | --- | --- |
| **Auth providers** | Credentials for **deploying** stacks that include auth Worker/Lambda | Use in **iac-alchemy** / future `alchemy.run.ts` host for auth bundle deploy tests; **not** a substitute for Better Auth end-user OAuth |
| **Secrets & Config** | Bind OAuth client secrets, SMTP, `AUTH_BASE_URL` at Construction | Map to HoBo: camp resolution feeding deploy bindings, or iac-alchemy host passing Redacted into Alchemy resources; respect locator-only rule for signing secret |
| **Secret providers** | DotEnv/Doppler/Infisical for stack config | Optional **host** for local/CI auth stack tests; owner store remains for HoBo operator credentials |
| **Better Auth package** | Runtime issuer | ADR-0161 adapter + new bundle package(s) executing `better-auth` behind membrane |

### 3.4 Alchemy Domains + step-by-step testing

| Alchemy pattern | HoBo alignment |
| --- | --- |
| Domain stories for commands (register, sign-in, claim) | Can mirror in `src/draft/exp-proofs/ux/` **or** package tests; repo rules forbid new planning-only docs |
| `Test.make` deploy → HTTP sign-in → destroy | Fits ADR-0159; should live beside auth bundle once runtime exists (scoped package test, not full-repo E2E) |
| `alchemy-domain` skill | Not required for HoBo; use existing `draft` / `tdd` / PACT patterns |

---

## 4. Architectural constraints (already decided)

These are **not** gaps to re-litigate; implementation must comply:

1. **Brokered signing secret** (ADR-0161) — do not persist Better Auth signing material in Alchemy state like upstream Alchemy demo.
2. **Federate + verify** (ADR-0038) — Better Auth is issuer; JWKS verify path unchanged.
3. **Agents never store secrets** — synthetic CI secrets only; OAuth client secrets via owner store / broker at deploy, not committed.
4. **No vendored auth server in adapter package** — runtime lives in bundle/host package with dependency on `better-auth`.
5. **Portable SQLite EventStore** (ADR-0135) — session DB may be SQLite **partition** for single-writer paths; multi-box requires network relational store or explicitly consistent secondary storage — not multi-writer NFS WAL.
6. **Parallel agents** — avoid broad edits to `AGENTS.md`, root `package.json`, shared CI workflows in this workstream.

---

## 5. Suggested incremental PR stack (implementation sequence)

Ordered for **small green PRs** off `origin/main`; each row is one mergeable unit. Names are illustrative branch themes, not pre-created branches.

| # | Scope | Delivers | Primary touch |
| --- | --- | --- | --- |
| 1 | **This audit** | Shared map for reviewers | `docs/maintenance/alchemy-auth-secrets-onboarding-audit.md` |
| 2 | **Auth bundle skeleton** | Package that composes `better-auth` behind membrane ports; fails closed without deps; no cloud pin | New package under `packages/` (narrow), PACT boundary extension |
| 3 | **Relational + migrations wire** | Gated Better Auth schema via ADR-0160 path against `hobo:data/relational` fixture | Bundle + migration fixtures |
| 4 | **Secret broker wire** | Signing `secretRef` resolution at bundle init; refusal on inline material | `@hobo/identity` / camp secrets port integration in bundle |
| 5 | **iac-alchemy host fixture** | Minimal Alchemy stack test: Worker + D1 or local SQLite + Construction-time Config from DotEnv provider; Vitest `Test.make` or package-local harness | `@hobo/iac-alchemy/test/` + small fixture only |
| 6 | **Session durability tests** | Automated: sign-in → restart process / redeploy stack → session still valid | Package test with synthetic secrets |
| 7 | **Cross-box session test** | Two clients against shared DB URL; cookie replay or second browser lane (mocked boundaries) | Behavior or component test per repo policy |
| 8 | **Onboarding step tests** | One executable step per claim (store sign-in, auth route live, first session) aligned with workspace onboarding evidence map | `src/draft/exp-proofs/ux/` or package tests |
| 9 | **Secret providers in host** | Stage-scoped DotEnv + Infisical/Doppler optional Layer for auth stack CI only | iac-alchemy host, docs touch in same PR |

Dependencies: 2→3→4 sequential; 5 can parallel 3–4 once bundle API stable; 6–7 require 2–5; 8 can start after 6 green; 9 optional for CI parity with Alchemy docs.

---

## 6. Evidence and references

| Item | Location |
| --- | --- |
| Alchemy competitor capture | [`docs/competitors/alchemy.md`](../competitors/alchemy.md) |
| Yard bindings / Alchemy-informed ADRs | [`docs/design/yard-bindings.md`](../design/yard-bindings.md), ADR-0157–0161 |
| Better Auth adapter | [`packages/adapters/adapter-better-auth/`](../../packages/adapters/adapter-better-auth/) |
| IaC Alchemy | [`packages/iac/iac-alchemy/README.md`](../../packages/iac/iac-alchemy/README.md) |
| Owner store session | [`packages/hobo/src/owner-store-session.ts`](../../packages/hobo/src/owner-store-session.ts) |
| Secret store claim | [`packages/secret-store-claim/README.md`](../../packages/secret-store-claim/README.md) |
| Auth.md agents | [`packages/auth-md/README.md`](../../packages/auth-md/README.md) |

---

## 7. Audit conclusion

HoBo **already decided** the Better Auth shape (ADR-0161) and **implemented** the adapter contract surface, owner/relay secret onboarding, and a substantial **iac-alchemy** bridge — but **does not yet run** Better Auth, **does not bind** Alchemy auth providers to product sessions, and **does not prove** cross-restart or cross-machine session continuity.

Closing Tyler's goals requires a **bundle runtime** (not adapter-only), **shared durable session backing**, **stable brokered signing identity**, and **Alchemy-style integration tests** scoped to the auth package — using Alchemy secret providers and Config binding where they accelerate deploy-time OAuth/SMTP wiring, while keeping HoBo's brokered-secret and governance rules intact.