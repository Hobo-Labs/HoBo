# @hobo/pack-better-auth

Better Auth as a **HoBo implementation pack** (ADR-0161): the bundle that composes
the self-hosted `hobo:auth` issuer over existing ports — relational storage,
brokered signing secret, and an HTTP route mount — instead of vendoring auth
infrastructure inside the adapter.

`pack.better-auth/v1` implements the `better-auth` issuer adapter selected via
`@hobo/adapter-better-auth`.

## What is in here

- `catalog.ts` — `BETTER_AUTH_PACK_ID` and pack definition metadata.
- `ports.ts` — `BetterAuthBundlePortRefs`, the three bindle/port names the host
  must wire before the bundle can run.
- `plan.ts` — `planBetterAuthBundle`: parse-checked config + port refs → frozen
  plan; calls `assertBetterAuthRuntimeAvailable` when execution is requested.
- `migrations.ts` — `planBetterAuthRelationalMigrations`: ADR-0160
  `diffSchemaIr` from an empty postgres baseline (or supplied current schema)
  to the pinned Better Auth `SchemaIr` fixture — expand-only on first deploy.
- `fixtures/better-auth-schema-ir.ts` — canonical Better Auth table shapes for
  governed data-plane migrations (not adapter-private DDL).
- `secrets.ts` — `wireBetterAuthSigningSecret`: camp `SecretsPort` resolution at
  bundle init; wire record carries locators only (ADR-0161 / ADR-0113).

## HONEST SCOPE

- **No `better-auth` dependency** in this package. The npm module is an optional
  peer installed by the deployed bundle.
- **No database provisioning, migration apply, or HTTP serving** yet. Relational
  schema planning and bundle gating only; SQL execution and runtime wiring land
  in follow-up PRs per
  [`docs/maintenance/alchemy-auth-secrets-onboarding-audit.md`](../../../docs/maintenance/alchemy-auth-secrets-onboarding-audit.md).

## Parse, don't validate

Untrusted JSON crosses one boundary: `parseBetterAuthConfig` in
`@hobo/auth-adapter-contract` and `parseBetterAuthBundlePortRefs` in this
package mint **parsed domain types** (`BetterAuthConfig`,
`BetterAuthBundlePortRefs`, `BetterAuthBundlePlan`). Downstream code never
re-checks primitive strings; an invalid locator or base path is unrepresentable
past the parse boundary. `toBetterAuthBundlePlanRecord` projects a plan into
the durable replay shape. Protobuf records live in
`data-models/pack_better_auth.proto`, constrained by `pack_better_auth.cue`
(`claims_mapping_version` is `better-auth-claims/v1`, bindle names allow `_`).

## Commands, events, and durability

Pure planning today; the host still owns the CQRS loop that will surround execution.

- **Commands** — a Camp **actor** for the auth bundle accepts
  `PlanBetterAuthBundle` (config + port refs, idempotent key =
  `relational_bindle` + `claims_mapping_version`) and, in later PRs,
  `MaterializeBetterAuthBundle` once relational migrations and HTTP serving land.
- **Events** — the actor emits `pack.BetterAuthBundlePlanned` (plan record, no
  secret material), `auth.BundlePortsBound`, and `auth.RoutePatternDeclared`.
  Bodies match `BetterAuthBundlePlanRecord` / port ref records so replay never
  sees signing bytes — only locators.
- **Event store** — the host appends to the durable SQLite-backed **event store**
  under per-stream OCC; bundle effects (npm `better-auth` init, Drizzle migrate)
  run **outside** the transaction with idempotency keys.
- **Projections / materialized views** — fold the stream into the deployed-auth
  **materialized view** the CLI reads (adapter id, base path, route pattern, bound
  bindles) and a conformance **projection** keyed by `claims_mapping_version`.
- **Snapshots / read store** — **snapshots** of the bundle aggregate back the
  **read store** for `hobo auth status`; historical snapshots keep which locator
  was wired before a rotation auditable.

## Contracts

- `data-models/pack_better_auth.proto` — durable plan and port-ref records.
- `data-models/pack_better_auth.cue` — locators are locators, base paths are
  absolute, required ports are non-empty.
- `contracts/pack-better-auth-bundle-plan.pact.json` — consumer pact over the
  in-process `planBetterAuthBundle` entrypoint (no invented HTTP surface).

## Gates

- `pnpm --filter @hobo/pack-better-auth run build`
- `pnpm --filter @hobo/pack-better-auth run test`