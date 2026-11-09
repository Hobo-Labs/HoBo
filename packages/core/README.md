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
replaces the shared credential shapes (private key, JWT, bearer token, an
`Authorization` header in any scheme, `Basic` and `Token` credentials,
connection strings, URL credentials, secret-named keys, prefixed keys) with
`[redacted]`, turns control characters into spaces, and cuts to `maxLength`; it
searches the first `REDACTION_WINDOW` (8192) characters, or four times
`maxLength`, plus the rest of the run of non-whitespace the cut falls in, and
marks a longer text cut.

Every shape searches the same text, and the spans they match are merged and
replaced once (`redactMatches`): searched in turn over a text being rewritten,
one shape's match cut short a run another needed whole, or took another's name.
Each is searched twice, as the text came (a control character is not
whitespace, so `Bearer abcd\u0007SECRET` is one credential) and with control
characters as spaces (so `PASSWORD\u0000=…` is found); flattening puts one
character for one, so both searches' spans are in the same text. A shape's
search resumes at the last run of a match, so a match that starts inside it is
still found (`**Token**: api_key=**Token:** …`); the runs before it are not
read again, so each character is read at most twice.

`createProviderRedactor(profile)` adds a provider's own `patterns` and generic
`fallbacks` (a long-opaque-run rule), spans to `keep` whole, full
percent-decoding (`decodePercentFully`, one pass), and whitespace collapsing.
The whole text is searched with each kept span masked by a run character no
shape's class holds, so a value glued to a kept digest (`password=sha256:…-x`)
is still a key and its value; a kept span a credential span reaches is
redacted with it. A pattern is parsed by `redactionPattern`, which refuses one
that is not global or is sticky.

Some rules the shapes hold, each with a test:

- A private key is found in code (`keySpans`), with one pass for BEGIN lines and
  one for END lines, in any case. It runs from its BEGIN line to the last END
  line before the next BEGIN, when that line starts a line (after whitespace,
  the start, or an escaped `\n`), with the rest of that line's run. With no
  such END line, or one another shape's match ran over (`Bearer -----END …`),
  it runs to the next BEGIN or the end. A label is anything up to the next `-`.
  `PRIVATE_KEY_PATTERN` on its own takes BEGIN to the next BEGIN.
- A JWT is an `ey` header and two segments of ten or more (`JWT_PATTERN`), or an
  `eyJ` one of eight or more and three segments (`JSON_JWT_PATTERN`, also
  `SIGNED_JWT_PATTERN`); `my-eyewear-store.myshopify.com` is neither. It is
  searched from the start of its run and redacted from its `ey`: the word
  before a hyphen is kept (`token-[redacted]`), as #1773 keeps it.
- `Basic` or `Token` and a credential of eight characters or more with a digit,
  a symbol or mixed case; a word in prose (`Token required`, `Basic
  authentication`) is not one.
- A URL with a user is a credential, with or without a password and with or
  without a scheme: a token is often the user (`https://ghp_…@github.com/…`,
  `Token ://…@host`).
- A locator (`hobo-token://…`, `hobo-secret://…`, `secret://…`, `env://…`) is a
  reference, not a secret, and is kept, as a key's value too, when its run is
  clean: 256 characters or fewer, no control character in it, ending at
  whitespace or the end. One a control character runs on through is redacted.
  Only those schemes: `password://…` and `api-key://…` are a key and its value.
- A secret-named key (`token`, `secret`, `auth`, `authorization`, `session`,
  `password`, `api_key`, `secret_key`, `access_key`, `private_key`, …) whose
  value ends in a separator, or has one after it (`api_key=password: …`,
  `token=Token =…`), takes the run after it too, and the one after that while
  each does (`api_key=a,password= b= SECRET`).

`JWT_DETECTOR` and `PRIVATE_KEY_DETECTOR` are the same shapes for guards that
refuse instead.

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
one run, since quadratic work shows its 16x early. The only absolute bound is
`HANG_BACKSTOP_MS` (20 s) on a single call, an `OperationHangError`.
`repeatedTo(unit, prefix)` builds the inputs.

`@hobo/core/linear-sweep` runs one pattern or function on inputs nobody has to
think of: runs of each character of its alphabet and of the separator classes
(`_`, whitespace, `.`, `-`, `%`, `+`, `:`, quotes, `*`, `=`, `/`, `@`, `,`, two
control characters), every ordered pair of them, its own words before each run,
and runs between its literal fragments (`patternFragments`: every literal of
three or more characters in its source, and `=` and `:`): a fragment, a run,
and a fragment or a terminator after it, and a whole sample (a word), a run, a
terminator and a fragment (`key … aaa -----END`). An input whose one call on 16
Ki characters takes under 0.5 ms of wall time is linear; one above is timed as
four calls on a quarter of the length, the better of two, and only one that
still looks quadratic is measured as growth in CPU time. A call that reaches
the hang backstop is an offender, named. `assertPatternSweepLinear` sweeps one
pattern through the redactor's own search, with its fragments taken from its
source, and `profilePatterns` lists a profile's.

`@hobo/core/redaction-differential` holds a redactor to the one it replaced.
`assertRevealsNoMore(old, now)` generates texts of credential shapes,
separators and control characters carrying random markers, and fails when the
new redactor shows half a marker the old one hid. The texts carry credentials
at their real lengths with a marker inside (AKIA keys, `ghp_`, Stripe, GitLab
and Slack tokens, a full JWT, private keys with and without END), percent
encodings, non-ASCII, zero-width and direction characters, secret names used as
schemes, and digests a value is glued to. The one exception is a marker in a
clean locator's own path or in the name of the key it is the value of, which
the shared redactor keeps on purpose (`decode` says what the redactor does to a
text first). `assertFindsNoLess(old, now, pieces)` does the same for a
detector: every text the old one found, the new one finds.

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
