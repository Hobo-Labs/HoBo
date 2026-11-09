# @hobo/core

Shared kernel for HoBo production packages: the event envelope (`EventEnvelope`, with
CloudEvents conversion via `toCloudEvent`/`fromCloudEvent`), capability grants and
enforcement (`parseCapabilityGrant`, `evaluateCapabilityGrants`, `inferCapabilityUsage`),
the capability-manifest bundle parser, a minimal port container (`createContainer`), and
the typed **port contracts** other packages implement: `EventStore`, `Queue`, `Streamer`,
`VirtualClock`, `ComponentHostPort`, `WrpcLinkPort`, `BindingResolverPort`, and
`TrainingEnginePort`.
`TrafficRoutingPort` adds provider-neutral, tenant-scoped multi-backend routing
intent with explicit `full | partial | none` realization and capability notes.

## Provider redaction

`@hobo/core/provider-redaction` (a subpath, not the root: it names provider
credential shapes) is the one redactor for provider text. `redactProviderText`
turns control characters into spaces first, so none can hide a credential
(`PASSWORD\u0000=…`), then replaces the shared credential shapes (private key,
JWT, bearer token, an `Authorization` header in any scheme, `Basic` and `Token`
credentials, connection strings, URL credentials, secret-named keys, prefixed
keys) with `[redacted]`, and cuts to `maxLength`; it searches the first
`REDACTION_WINDOW` (8192) characters, or four times `maxLength`, plus the rest
of the run of non-whitespace the cut falls in, and marks a longer text cut.
`createProviderRedactor(profile)` adds a provider's own structured `patterns`
(searched after the private key and before the other shared shapes) and its
generic `fallbacks`, such as a long-opaque-run rule (searched last, so they
cannot split a JWT or a key the shared shapes redact whole), spans to keep
whole, full percent-decoding (`decodePercentFully`, one pass), and whitespace
collapsing. A pattern is parsed by `redactionPattern`, which refuses one that is
not global or is sticky. Every pattern is linear in the text, each with an
adversarial growth test (`test/provider-redaction.test.ts`, see below);
`JWT_DETECTOR` and `PRIVATE_KEY_DETECTOR` are the same shapes for guards that
refuse instead, and `SIGNED_JWT_PATTERN` is a JWT bounded to its three segments
for a caller that must not count an unsigned token or swallow what follows the
signature. A private-key label is anything up to the next `-`.

## Linear-time tests

`@hobo/core/linear-time` is how the redaction tests prove a pattern linear
without a wall-clock bound that a slow or loaded machine fails.
`measureGrowth(run, input)` times `input(n)` and `input(4n)` in the CPU time of
the thread that runs them (so other processes on a loaded machine do not count),
the better of two runs each, taking turns. n doubles from 4096 (to at most 2^18)
until a run takes 30 ms of CPU time, long against Linux's few-millisecond
CPU-time ticks; an operation too quick for that is repeated within each timed
run, the same number of times at both sizes. `assertGrowsLinearly` throws a
`NonLinearGrowthError` at `LINEAR_GROWTH_LIMIT` (8: linear work grows about 4x,
quadratic about 16x), then runs `input(1 MB)` once. An operation that costs next
to nothing even repeated `MAX_REPEAT` times is linear while 4n stays under 240
ms. `NEGATIVE_CONTROL` holds a test's expected-to-fail pattern to small sizes and
one run, since quadratic work shows its 16x early. The only absolute bound is `HANG_BACKSTOP_MS` (20 s) on a single call, an
`OperationHangError`. `repeatedTo(unit, prefix)` builds the inputs.

## Honest scope

Implemented: parsers, derived record constructors, error taxonomies, the port
type contracts, the deterministic-clock/queue/streamer value helpers, and the
public-API surface guard (`assertCoreApiSnapshot` against `CORE_API_SNAPSHOT`).
Deliberately not here: no port has a production backend in this package — the
`EventStore`, `Queue`, `Streamer`, and host ports are interfaces plus parse
helpers; implementations live in runtime/provider packages. No I/O, no network,
no persistence.

### HONEST SCOPE — deployment phases and schema diff

`ports/phase.ts` (ADR-0158) ships **vocabulary, parse boundaries, and the
`assertCapabilityPhase` enforcement primitive only**. There is no handler
pipeline and no `ctx.bindings` here: nothing in this package intercepts a
capability access, so enforcement happens where a host calls
`assertCapabilityPhase` — a host that never calls it is never protected.

`ports/schema-diff.ts` (ADR-0160) owns the canonical schema IR and the
forward-only expand/backfill/contract differ. What it deliberately does **not**
do: it emits **no SQL** (`CANONICAL_SCHEMA_DIFF_ENGINE` has no `emitSql`; SQL
emission belongs to toolchain adapters such as `@hobo/adapter-drizzle`, which
fail closed when the toolchain is missing); it models **postgres only** and
refuses any other `dialect` rather than pretending to model it; it models
tables, columns and indexes, so foreign keys, check constraints, enums,
sequences, partitions, views, triggers, and column ordinal position are **not**
represented and a schema that relies on them is under-described rather than
mis-described; the type-widening lattice is a small documented set
(`smallint→integer→bigint→numeric`, `real→double precision`,
`char→varchar→text`, plus parameter growth like `varchar(32)→varchar(64)`) and
every conversion outside it is classified as a **narrowing** — conservative on
purpose, because calling an unknown conversion safe is how an expand phase
loses data. Redefining an index in place (same name, different columns or
uniqueness) yields both an `expand` add and a `contract` drop of that name; the
differ does not model index renames, so distinct names are expected.

## Commands

```bash
pnpm --filter @hobo/core run build
pnpm --filter @hobo/core run typecheck
pnpm --filter @hobo/core run lint
pnpm --filter @hobo/core run test
pnpm --filter @hobo/core run test:contract:consumer
pnpm --filter @hobo/core run test:contract:provider
```

## Parse, don't validate

Untrusted input crosses named parser boundaries and becomes frozen derived types:
`parseEventEnvelope` → `EventEnvelope`, `parseCapabilityGrant` → `CapabilityGrant`,
`parseCapabilityManifestBundle` → `CapabilityManifestBundle`, plus branded ids like
`ResourceId`, `QueueName`, `TrajectoryId`, and `WireVersion` from their `parse*`
functions. Failures throw typed errors (`EnvelopeParseError`, `CapabilityParseError`,
`QueueParseError`, …) — parse, don't validate. Wire forms live in `data-models/*.proto`
with CUE constraints alongside.

The deployment-phase and schema-diff ports follow the same boundary:
`parseDeploymentPhase` / `parsePhaseScope` / `parsePhaseScopeFromEnv` →
`DeploymentPhase` and `PhaseScope` (an unknown `HOBO_PHASE` or `HOBO_DEV` value
is refused, never defaulted), and `parseSchemaIr` → a deeply frozen,
name-sorted `SchemaIr` whose derived types `diffSchemaIr` turns into a
`MigrationPlan` — a pure, deterministic, forward-only expand/backfill/contract
plan whose `digest` covers the engine id and version, so an engine upgrade is a
visible plan change. Refusals carry `SchemaIrParseError` /
`PhaseParseError` codes; a phase-scoped capability touched outside its phase
raises `PhaseViolationError` with `code: "PHASE_VIOLATION"`.

Traffic routing follows the same boundary: `parseRoutingPlan` produces a deeply
frozen `RoutingPlan` with branded plan/backend/Station identifiers, while
`TrafficRoutingParseError` rejects malformed plans before adapters see them.
`parseTrafficRoutingPlanRecord` and `toTrafficRoutingPlanRecord` reconcile the
generated protobuf record/JSON enums with that frozen domain view; protobuf's
absent scalar/list defaults normalize optional `degraded`/`notes` to `false`/`[]`.

## Position in the event architecture

`@hobo/core` defines the vocabulary of the event architecture — envelopes, principal
refs, and the `EventStore`/`Queue`/`Streamer` port contracts — but hosts no actor,
appends nothing to any event store, and maintains no projection or read store itself.
Commands, events, actors, and materialized views are owned by the packages that
implement or consume these ports; this package only guarantees their records parse.

The bounded WHATWG HTTP adapter treats `TransportResponse.body` as UTF-8 text.
It rejects malformed or truncated UTF-8, preserves an observed leading BOM, and
cancels a failed response before releasing its reader. This prevents text
normalization from making different served bytes appear to match an approved
artifact digest. Binary protocols need an explicit bytes/base64 boundary;
replacement characters are not a valid binary transport.
