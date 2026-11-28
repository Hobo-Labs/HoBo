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
  to the Better Auth `SchemaIr` for the bundle plan. The diff is scoped to
  pack-owned tables, so a host table is left in place. `drop-table`,
  `drop-column`, `narrow-column`, and `drop-index` are refused. Migration
  planning accepts `data.relational/v1` and `data.postgres/v1`; its shared
  schema definitions are immutable across plans.
- Bundle replay records keep the configured base path and route pattern in
  sync, and accept only registered relational v1 profiles.
- `fixtures/better-auth-schema-ir.ts` — canonical Better Auth table shapes for
  governed data-plane migrations (not adapter-private DDL).
  `buildBetterAuthRelationalSchemaIr` adds `organization`, `member`, and
  `invitation`, plus `session.activeOrganizationId`, when
  `config.organizations.enabled` is set.
- `secrets.ts` — `wireBetterAuthSigningSecret`: camp `SecretsPort` resolution at
  bundle init; the caller supplies the selected camp's authority, and only an
  unfragmented `hobo-secret` locator for that authority is accepted. Other
  providers need their own matching resolver. The wire record carries locators
  only (ADR-0161 / ADR-0113). A caller-supplied instant must match
  `YYYY-MM-DDTHH:mm:ss.sssZ`, and material that would appear on the record is
  refused.

## HONEST SCOPE

- **No `better-auth` npm dependency** in this package or lockfile slice. Runtime
  wiring lands in a later stack PR.
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
the durable replay shape, including `parsed_config` with database profile,
email/password, social providers, and organizations flags. Protobuf records live
in `data-models/pack_better_auth.proto`, constrained by `pack_better_auth.cue`
(`claims_mapping_version` is `better-auth-claims/v[1-9]+`, bindle names allow `_`).

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
