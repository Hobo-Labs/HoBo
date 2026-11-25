---
type: Technology Reference
title: "Varlock"
description: "**Varlock** is an open-source tool (by dmno-dev) that replaces the plain `.env` file with a **schema-first** approach to environment-variable management. Its tagline is **\"AI-safe "
tags: [hobo, technologies]
---

# Varlock

> Technology — `.env`-native configuration & secrets with a committed schema. Source: [varlock.dev](https://varlock.dev/) · [Schema guide](https://varlock.dev/guides/schema/) · [Secrets guide](https://varlock.dev/guides/secrets/) · [Root decorators](https://varlock.dev/reference/root-decorators/) · [GitHub `dmno-dev/varlock`](https://github.com/dmno-dev/varlock) (MIT). Excerpts quoted for analysis (fair use).

## What it is
**Varlock** is an open-source tool (by dmno-dev) that replaces the plain `.env` file with a **schema-first** approach to environment-variable management. Its tagline is **"AI-safe `.env` files: schemas for agents, secrets for humans."** Instead of storing secrets as plaintext on disk, it defines the *shape and rules* of configuration in a **`.env.schema`** file that is **safe to commit to version control**, then resolves the actual values at runtime — from defaults, from local (optionally encrypted) overrides, or from external secret managers.

The schema is expressed with **`@env-spec`**, a DSL that attaches schema and metadata to `.env` files using **JSDoc-style decorator comments**. `@env-spec` is a separate package (a parser + the spec itself) that Varlock builds on. The "AI-safe" angle: an agent can read `.env.schema` for full configuration context **without accessing the secret values**, reducing the chance of leaking credentials into AI services or generated code.

## Key features
- **`@env-spec` decorator comments** define a committable schema inline in `.env.schema`. Item decorators include `@sensitive` (mark secret), `@required`, `@type` (e.g. `@type=enum(development, production)`, or string constraints like `startsWith=sk-ant-api`), `@docs(...)` (link docs); root/file decorators (e.g. `@defaultSensitive`, `@defaultRequired`, `@envFlag`, `@generateTypes`) set file-wide defaults and behavior. Most decorators take a single value and apply once; some (`@docs()`, `@import()`) are function calls usable multiple times.
- **Schema validation & coercion**: the schema is the single source of truth; the more complete it is, the more Varlock validates, coerces types, and catches misconfiguration **early** with clear errors.
- **Typed config generation**: generates **TypeScript types** from the schema for IDE autocomplete and compile-time safety.
- **Resolver functions & provider plugins**: values can be resolved by composable functions instead of static literals. Official plugins fetch secrets from **1Password, Infisical, AWS Secrets Manager, Azure Key Vault, Google Secret Manager, Bitwarden** (and any CLI tool). Plugins can register new decorators and resolver functions.
- **Encrypted local overrides**: local secrets can be stored encrypted (e.g. `varlock(local:...)`) rather than as plaintext.
- **Redaction & leak prevention**: the CLI redacts sensitive values in its own output (e.g. `varlock explain` shows partial masking like `my▒▒▒▒▒`); runtime protection redacts secrets from logs/console and detects leaks in bundled client code and server responses; `varlock scan` (with git-hook support) proactively detects leaked secrets.
- **CLI**: `varlock init` (set up), `varlock scan` (leak detection), `varlock run -- <command>` (inject validated env into a process), plus auto-load via `import 'varlock/auto-load'`; multi-environment files (`.env.development`, `.env.production`) and variable expansion (`${VAR}`).
- **Framework integrations**: drop-in support for Next.js, Astro, Vite, etc.; an MIT license; a third-party Laravel integration exists. Newer/young project — verify current decorator/plugin surface against the live docs.

## Relevance to HoBo
Varlock is a strong **inspiration and a candidate optional config provider** for HoBo's config/secrets plane, but HoBo's stance is *more* aggressive than Varlock's: HoBo prefers **no secret at all** over a well-managed one.

- **Secretless-first config** ([`../design/31-config-secretless-secrets.md`](../design/authoring-resources-wiring.md#plan-21), [`../design/adr/ADR-0027-secretless-config-and-secrets.md`](../design/adr/02-identity-security.md#adr-0027)). HoBo's principle 1 is "the best secret is no secret": a bound resource is reached via the app's **SVID → brokered short-lived token**, so there is nothing to store or leak. Varlock still resolves a *value* (even if from a vault) at runtime; HoBo's preferred path (`fromBinding`) never produces a static secret at all. Where HoBo *does* allow a secret (`secretRef`), it stores a **reference, not a value**, resolved per-Camp at use-time — aligning with Varlock's "schema commits the shape, never the value" idea, but going further by avoiding the literal even in the runtime environment.
- **Schema / validation / typed config — direct overlap.** Varlock's `@env-spec` schema + generated TS types + early validation is the same goal as HoBo's typed `config()` / `env()` / `secretRef()` SDK surface (Plan 31), which is declared inline (IfC) and read via `ctx.config`. Varlock validates `.env`; HoBo validates the declared config against the Camp's resolved sources and warns on cross-Camp drift via `hobo doctor` / `config.Resolved` events.
- **Redaction / leak prevention — shared discipline, different layer.** Varlock redacts at the CLI/runtime boundary and scans for leaks; HoBo redacts at **capture time** — values are scrubbed *before* an event/span/training trajectory is stored, never on export (Plan 31; never in the event log, OTel/OpenInference spans, or training data per [Plan 23](../design/generated-stack.md#plan-23)). HoBo's `secret.Accessed` audit and `varlock scan`-style hygiene are complementary.
- **Provider plugins ↔ per-Camp secret stores.** Varlock's resolver/provider model (1Password, AWS Secrets Manager, Azure Key Vault, …) is exactly HoBo's per-Camp `fromSecretStore("aws:secretsmanager", ...)` resolution — *where* a secret comes from is a Camp concern. Varlock could plausibly sit **behind an optional config/secrets provider** for local dev or for teams committed to `.env` workflows; its `.env.schema` is a natural fit for HoBo's local Camp (`runtime-local`), which already resolves `secretRef` against a gitignored `.env.local`, the OS keychain, or a prompt.
- **AI-safe schemas ↔ HoBo's agent/Forge guardrails.** Varlock's "agents read the schema, not the secrets" maps onto HoBo's agent-auth model ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) and its ban on secrets entering training trajectories — both keep the *contract* visible to agents while the *value* stays out of reach.

Net: **informs + candidate optional provider.** Varlock validates HoBo's schema-committed / reference-not-value / redaction-at-capture instincts and could back the `.env`/local-dev config path behind a port — but HoBo's brokered, secretless-first default ([ADR-0027](../design/adr/02-identity-security.md#adr-0027)) is intentionally a step beyond Varlock's vault-resolution model.

## Sources
- Varlock homepage — https://varlock.dev/
- Schema guide — https://varlock.dev/guides/schema/
- Secrets management — https://varlock.dev/guides/secrets/
- Root decorators reference — https://varlock.dev/reference/root-decorators/
- CLI commands — https://varlock.dev/reference/cli-commands/
- GitHub `dmno-dev/varlock` — https://github.com/dmno-dev/varlock
