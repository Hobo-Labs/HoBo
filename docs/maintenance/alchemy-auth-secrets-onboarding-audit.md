---
type: Maintenance Note
title: "Alchemy auth, secrets, and onboarding audit"
description: "Maps Alchemy auth providers, secrets, Better Auth, Domain, and testing docs to HoBo's auth, secrets, and onboarding code; gaps for durable and cross-machine sessions."
tags: [hobo, auth, secrets, alchemy, better-auth, onboarding, maintenance]
---

# Alchemy-aligned auth, secrets, and onboarding — codebase audit

**Date checked:** 2026-11-25  
**Alchemy doc index:** [`https://alchemy.run/llms.txt`](https://alchemy.run/llms.txt) (v2 beta). HoBo's lockfile pins `alchemy@2.0.0-beta.87`, `@alchemy.run/cloudflare@2.0.0-beta.87`, and `@alchemy.run/rivet@2.0.0-beta.87` only; packages such as `@alchemy.run/better-auth`, `@alchemy.run/domain`, and `@alchemy.run/test` are **not** pinned and each needs an explicit dependency decision before use.  
**Scope:** Map Alchemy's auth providers, secrets/config, secret providers, Better Auth, Domain, and testing model onto HoBo's current auth, secrets, and onboarding surfaces. Identify what is already built, what ADRs already decided, and what implementation remains for **durable sessions across restart** and **sessions across machines**.

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

HoBo analogue: owner-chosen **SecretsPort** adapters (**1Password, Bitwarden, Infisical**) at **owner** scope via `choose_secret_store` / `owner://`, not per-stack Effect providers. `@hobo/auth-md` is the **agent-principal** plane (OAuth anonymous agent + human claim), not a SecretsPort adapter.

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
| **Model** | Commands, aggregates, events, views, projections, policies; `@alchemy.run/domain` (not in HoBo lockfile) |
| **Tests** | In-memory **stories** (`Story.given/when/then`); production on Cloudflare DO / Rivet / Effect Cluster |
| **Agent skill** | `alchemy-domain` shipped with package |

HoBo analogue: CQRS/event store/actors for the control plane; **ADR-0135** covers the **Camp EventStore / actor journal**, not Better Auth `session` rows on `hobo:data/relational`. **No** `@alchemy.run/domain` dependency. Onboarding **design** contracts exist ([`docs/design/workspace-onboarding-ux.md`](../design/workspace-onboarding-ux.md)); they are not wired to Alchemy Domain stories.

### 1.6 Testing

Sources: [`testing`](https://alchemy.run/testing), [`testing/testing-a-stack`](https://alchemy.run/testing/testing-a-stack), [`testing/test-harness`](https://alchemy.run/testing/test-harness).

| Concept | Behavior |
| --- | --- |
| **Default** | Real cloud: `beforeAll(deploy(Stack))` → HTTP assertions → `afterAll(destroy)` |
| **Stage** | `test_$USER`, `ci-pr-N` isolation |
| **Local** | `dev: true` → workerd emulators, same suite |
| **Runner** | `@alchemy.run/test` adapters for alchemy-test, Bun, Vitest (Alchemy package; not a HoBo lockfile pin) |

HoBo analogue: **PACT / mocked boundaries** and **no traditional full-stack E2E** ([`AGENTS.md`](../../AGENTS.md)). [**ADR-0159**](../design/adr/07-portability-extensibility.md#adr-0159) adopts **`@hobo/testing`** `createTestHarness` (in-process by default, fidelity-labelled; ephemeral Camp fails closed) — not Alchemy `Test.make` or default real-cloud deploy loops. `@hobo/iac-alchemy` already exercises Alchemy in **scoped package tests** (secrets, state, Rivet/Cloudflare fixtures). Root `test:behavior` runs Cucumber suites under `cucumber.yaml` (epic/project proof features, `features/fleet/`, control-yard, CI parity) — not a dedicated auth-onboarding lane. **Gap:** auth bundle onboarding stories beside `createTestHarness` / package-local harness once runtime exists; do **not** add unpinned `@alchemy.run/test` or committed `.env` paths.

---

## 2. HoBo inventory (current code)

### 2.1 Planes (do not conflate)

| Plane | Packages / entry | Purpose |
| --- | --- | --- |
| **End-user / app auth (`hobo:auth`)** | `bindles` `auth()` catalog handle, `@hobo/adapter-better-auth`, design proofs under `hobo-63-*` / ADR-0038 | **Contract** surface for issuer/session port verbs and dev principal shape; **JWT/JWKS verification is not asserted** in the [hobo-63 proof](../design/proofs/hobo-63-auth-contract/index.md) |
| **Human / owner infrastructure** | `packages/hobo` owner store session, `hobo login`, MCP `choose_secret_store` | CI/CD credentials, relay; **not** app user sessions |
| **Agent principals** | `@hobo/auth-md` | OAuth anonymous agent + human claim; separate from `hobo login` and from camp `SecretsPort` |
| **Fleet device enrollment** | `@hobo/fleet-authority`, `@hobo/fleet` | RS256 enrollment tokens, OIDC/GitHub/atproto sign-in for **devices** |
| **Relay secret store onboarding** | `@hobo/secret-store-claim` | Claim bundle for Infisical (built) plus **designed** `auth-md` and `cloudflare-temporary` offers ([`packages/secret-store-claim/README.md`](../../packages/secret-store-claim/README.md); hard-gated unless `allowDesigned`) |

This audit targets **HoBo product auth** — the **`hobo:auth` bundle + deploy/onboarding** path — not replacing owner store or fleet authority.

### 2.2 Better Auth adapter (`@hobo/adapter-better-auth`)

**Status:** Descriptor, parse boundaries, claims mapping, PACT (pact_only). **No** `better-auth` npm dependency, **no** HTTP server, **no** migrations, **no** route mount.

Shared planning vocabulary (`parseBetterAuthConfig`, locator parse, descriptor, runtime gate) lives in **`@hobo/auth-adapter-contract`** so `@hobo/pack-better-auth` can compose the issuer without adapter-to-adapter imports.

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
| **Relay claim** | `@hobo/secret-store-claim` — Infisical provision/claim **built**; `auth-md` / Cloudflare temporary **designed**, not default-offer runnable |
| **IaC secrets** | `@hobo/iac-alchemy` — Redacted fingerprinting, Cloudflare secret name derivation, `secret-persistence.test.ts` proves Alchemy **state** round-trip for redacted props (host-owned state dir), not Better Auth signing secret |

**Gap vs Alchemy secret providers:** HoBo has no stack-level `secrets: [DotEnv, Doppler, …]` on Yard/Station; binding is camp/owner mediated. Tests use **synthetic construction records and memory `SecretsPort`** — never committed `.env` files ([`AGENTS.md`](../../AGENTS.md)). For Better Auth OAuth client ids, Alchemy expects Construction-time `Config` discovery; HoBo expects **locators** and brokered resolution at runtime/deploy gates.

### 2.4 IaC Alchemy (`@hobo/iac-alchemy`)

**Status:** Optional IaC adapter using pinned `alchemy` / `@alchemy.run/cloudflare` / `@alchemy.run/rivet` beta.87; the **host** supplies stack, runtime layer, attestation, and financial port ([`packages/iac/iac-alchemy/README.md`](../../packages/iac/iac-alchemy/README.md)). Substantial package-test surface; many primitives are explicitly rejected or partial.

Explicit non-binding note for auth primitive ([`packages/iac/iac-alchemy/src/cloudflare.ts`](../../packages/iac/iac-alchemy/src/cloudflare.ts)):

> Auth.OAuthClient and AuthProvider are available, but HoBo identity verification and sessions are not bound.

**Gap:** No bridge from Alchemy `AuthProvider` registry to HoBo owner session; no `BetterAuth` resource mapping in iac-alchemy.

### 2.5 Onboarding

| Surface | Status |
| --- | --- |
| **Workspace onboarding UX** | Design contracts + telemetry map (`docs/design/workspace-onboarding-ux.md`); M0 evidence-oriented |
| **Secret store claim** | Infisical paths **built**; relay `auth-md` / Cloudflare temporary **designed** only |
| **Owner MCP onboarding** | `choose_secret_store`, owner page tests in `packages/hobo/test/mcp-*.test.ts` |
| **Alchemy Domain stories** | Not present for auth onboarding |

**Gap:** No **executable** auth-onboarding story using `@hobo/testing` `createTestHarness` (or equivalent scoped package harness) that provisions Better Auth + shared session store + cross-host check once runtime exists.

### 2.6 Human `hobo login` vs app sessions

`hobo login` (see `packages/hobo/README.md`) — fixture/OIDC under `HOBO_HOME`, relay variant — is **operator session** for CLI, not the Better Auth cookie session for app users. Documentation must keep these separate when wiring Alchemy Better Auth.

---

## 3. Goal gap analysis

### 3.1 Sessions survive HoBo restarts

| Requirement | Alchemy pattern | HoBo today | Gap |
| --- | --- | --- | --- |
| Session rows durable | Relational DB + migrations on deploy | Adapter **declares** `hobo:data/relational`; no bundle provisions store or runs Better Auth migrations | Implement relational bindle + **ADR-0160** migration gate for Better Auth schema (postgres-shaped `SchemaIr` fixture; not the EventStore journal) |
| Cookie signing key stable | `Alchemy.Random` persisted in state | ADR-0161: **brokered** `secretRef`, never IaC state file | Provision secret once into brokered custody; same locator across restarts |
| Process restart | DB + secret stable → sessions valid | No running Better Auth runtime | Ship bundle runtime + integration tests (`createTestHarness` or package-local harness; synthetic secrets only) |
| Deploy/restart of **HoBo control plane** | Alchemy state store separate from app DB | Owner store ≠ session DB | Session backing must be a declared **`hobo:data/relational`** app resource, not `HOBO_HOME` sqlite or the Camp EventStore partition |

### 3.2 Sessions work logging in from a different box

| Requirement | Alchemy pattern | HoBo today | Gap |
| --- | --- | --- | --- |
| Shared session state | DB (+ optional Redis secondary with consistency contract) | No shared session layer | Deploy relational store accessible from all app instances; optional secondary storage port adapter (Redis-class) if not relying on DB-only session mode |
| Cookie scope | `baseURL` / trusted origins / HTTPS | Config parse has `basePath`; no runtime cookie policy | Production auth guide parity: trusted origins, OAuth callbacks, SMTP |
| Multiple Workers/regions | Secondary storage guide (Redis REST) | Not implemented | If horizontal scale: implement `SecondaryStorage` behind `hobo:` port or host-specific Layer in bundle |
| Browser on machine B | Same API origin or shared parent domain | Named endpoints ADR-0130 (`.hobo.localhost` / `.hobo.test`) for local overlay | Wire auth routes to stable named URL; test cross-host with mocked boundaries (PACT / package tests, not live E2E) |

### 3.3 Use Alchemy auth providers, secrets, secret providers

| Alchemy piece | Intended use in HoBo auth work | Fit |
| --- | --- | --- |
| **Auth providers** | Credentials for **deploying** stacks that include auth Worker/Lambda | Use in **iac-alchemy** host programs for bundle deploy tests under ADR-0159 harness; **not** a substitute for Better Auth end-user OAuth |
| **Secrets & Config** | Bind OAuth client secrets, SMTP, `AUTH_BASE_URL` at Construction | Map to HoBo: camp resolution and owner store feeding deploy bindings; iac-alchemy Redacted props; respect locator-only rule for signing secret |
| **Secret providers** | DotEnv/Doppler/Infisical on Alchemy stacks | **Do not** mirror with repo `.env` files. Optional **test-only** construction-key layering in package harness; operator material stays **`owner://`** / broker |
| **Better Auth package** | Runtime issuer | ADR-0161 adapter + bundle package(s) executing `better-auth` behind membrane |

### 3.4 Alchemy Domains + step-by-step testing

| Alchemy pattern | HoBo alignment |
| --- | --- |
| Domain stories for commands (register, sign-in, claim) | Mirror in `src/draft/exp-proofs/ux/` **or** package tests; repo rules forbid new planning-only docs |
| Alchemy real-cloud deploy → HTTP sign-in → destroy | **Not** the default HoBo lane; use **`@hobo/testing` `createTestHarness`** scoped package tests with mocked boundaries (ADR-0159) |
| `alchemy-domain` skill | Not required for HoBo; use existing `draft` / `tdd` / PACT patterns |

---

## 4. Architectural constraints (implementation must comply)

These are recorded ADRs and repository rules; treat mismatches as defects, not optional design:

1. **Brokered signing secret** ([ADR-0161](../design/adr/02-identity-security.md)) — do not persist Better Auth signing material in Alchemy state like upstream Alchemy demo.
2. **Federate + verify** ([ADR-0038](../design/adr/02-identity-security.md)) — Better Auth is issuer; JWKS verify path is a separate gate from the hobo-63 contract proof.
3. **Agents never store secrets** ([`AGENTS.md`](../../AGENTS.md)) — synthetic CI secrets only in tests; OAuth client secrets via owner store / broker at deploy; **no** committed `.env` or `env://` shortcuts.
4. **No vendored auth server in adapter package** ([ADR-0161](../design/adr/02-identity-security.md)) — runtime lives in bundle/host package with dependency on `better-auth`.
5. **Relational session backing ≠ EventStore journal** — Better Auth `session` rows belong to **`hobo:data/relational`** with **ADR-0160**-governed migrations (postgres-shaped fixture today). **ADR-0135** SQLite partitions apply to the **Camp EventStore / actor journal**, not as a shortcut around the relational migration gate.
6. **Workstream hygiene** ([`AGENTS.md`](../../AGENTS.md) parallel-work rule) — parallel agents avoid broad edits to `AGENTS.md`, root `package.json`, and shared CI workflows unless the task requires them.

---

## 5. Open stacked PRs (auth implementation series)

Ordered merge units on branches `cursor/alchemy-auth-*-d77e` stacked above this audit. **Only row 1 is in the tree when [#3004](https://github.com/Hobo-Labs/HoBo/pull/3004) merges to `main`; rows 2–9 are open stacked PRs, not behavior on `main` yet** — do not read this table as shipped product state until each PR merges.

| # | PR | Status | Intended scope | Primary touch (when merged) |
| --- | --- | --- | --- | --- |
| 1 | [#3004](https://github.com/Hobo-Labs/HoBo/pull/3004) | **open** | Evidence map for reviewers | `docs/maintenance/alchemy-auth-secrets-onboarding-audit.md` |
| 2 | [#3008](https://github.com/Hobo-Labs/HoBo/pull/3008) | **open** | Auth bundle skeleton: plan/ports/PACT | `packages/packs/pack-better-auth/` |
| 3 | [#3010](https://github.com/Hobo-Labs/HoBo/pull/3010) | **open** | Relational migration **plan** via ADR-0160 `diffSchemaIr` vs Better Auth `SchemaIr` (planning gate, not SQL apply) | Bundle `migrations.ts` + fixtures |
| 4 | [#3011](https://github.com/Hobo-Labs/HoBo/pull/3011) | **open** | `wireBetterAuthSigningSecret` via camp `SecretsPort` | Bundle `secrets.ts` |
| 5 | [#3012](https://github.com/Hobo-Labs/HoBo/pull/3012) | **open** | Package-local harness: `HOBO_AUTH_*` construction records, in-memory Alchemy state, pack planning wire (`@alchemy.run/test` unpinned in lockfile) | `@hobo/iac-alchemy/test/better-auth-host-harness.*` |
| 6 | [#3014](https://github.com/Hobo-Labs/HoBo/pull/3014) | **open** | **Synthetic/mocked** file-backed SQLite session row + signing re-wire across simulated restart — **not** ADR-0160 relational apply or Better Auth runtime durability | `better-auth-session-durability.*` |
| 7 | [#3015](https://github.com/Hobo-Labs/HoBo/pull/3015) | **open** | **Synthetic/mocked** two-harness shared session store path — **not** production cross-box proof | `better-auth-cross-box-session.test.ts` |
| 8 | [#3017](https://github.com/Hobo-Labs/HoBo/pull/3017) | **open** | **Synthetic/mocked** onboarding chain (plan + broker + fixture session row) | `better-auth-onboarding-steps.test.ts` |
| 9 | [#3018](https://github.com/Hobo-Labs/HoBo/pull/3018) | **open** | **Synthetic/mocked** construction-key provider-order labels — **not** live Infisical/DotEnv providers | `better-auth-secret-providers.*` |

Dependencies: 2→3→4; host tests 5–9 depend on pack APIs. All PR tests use synthetic secrets and memory `SecretsPort` only.

---

## 6. Evidence and references

| Item | Location |
| --- | --- |
| Alchemy competitor capture | [`docs/competitors/alchemy.md`](../competitors/alchemy.md) |
| Yard bindings / Alchemy-informed ADRs | [`docs/design/yard-bindings.md`](../design/yard-bindings.md), ADR-0157–0161 |
| ADR-0159 test harness | [`docs/design/adr/07-portability-extensibility.md`](../design/adr/07-portability-extensibility.md#adr-0159) |
| Better Auth adapter | [`packages/adapters/adapter-better-auth/`](../../packages/adapters/adapter-better-auth/) |
| IaC Alchemy | [`packages/iac/iac-alchemy/README.md`](../../packages/iac/iac-alchemy/README.md) |
| Owner store session | [`packages/hobo/src/owner-store-session.ts`](../../packages/hobo/src/owner-store-session.ts) |
| Secret store claim | [`packages/secret-store-claim/README.md`](../../packages/secret-store-claim/README.md) |
| Auth.md agents | [`packages/auth-md/README.md`](../../packages/auth-md/README.md) |

---

## 7. Audit conclusion

HoBo **already decided** the Better Auth shape (ADR-0161) and **implemented** the adapter contract surface, owner onboarding for **built** secret-store offers, and a substantial **iac-alchemy** bridge — but **does not yet run** Better Auth HTTP, **does not bind** Alchemy deploy auth providers to product sessions, and **does not prove** cross-restart or cross-machine session continuity at the full runtime layer.

Closing the remaining goals requires a **bundle runtime** (not adapter-only), **shared durable relational session backing** under ADR-0160, **stable brokered signing identity**, and **ADR-0159-scoped harness tests** — keeping HoBo's owner-store, brokered-secret, and no-`.env` governance rules intact.
