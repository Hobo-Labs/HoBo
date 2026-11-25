# `@hobo/provider-turso`

The libSQL binding of `EphemeralStatePort` (`@hobo/core`), so a Turso database
— attached to the relay's Vercel project through the Marketplace — can back
the hosted CI relay's cache. Semantics are the Redis binding's, checked by the
same 24-case conformance suite from `@hobo/kv-redis-compatible`. Design:
[Relay Ephemeral State](../../../docs/design/relay-ephemeral-state.md) and the
"Options routed by budget" amendment of
[ADR-0179](../../../docs/design/adr/hosted-relay-stateless.md#adr-0179).

```ts
import { createTursoEphemeralState } from "@hobo/provider-turso";

const cache = createTursoEphemeralState({ env: process.env });
// undefined when TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not set
await cache?.port.putIfAbsent(key, value, ttlMs);
```

## Why a provider package

`packages/providers/provider-<vendor>` is where a hosted vendor's binding and
its environment names live: `@hobo/provider-upstash` holds the Upstash REST
binding of the same port. The other SQLite packages are the wrong home.
`@hobo/data-sqlite` is the `@hobo/data-core` engine over `node:sqlite` for user
workloads, and `@hobo/storage-sqlite` is the durable event store of ADR-0135.
This store is the opposite of durable: every row has a TTL, and losing all of
them costs a rebuild. Only libSQL speaks this wire (Turso, or a self-hosted
`sqld`), so a separate engine-neutral package would hold one binding.

## Storage

One table, `hobo_ephemeral_state` by default, created on first use:

| Column | Holds |
|---|---|
| `k` | the key (`TEXT PRIMARY KEY`, `WITHOUT ROWID`) |
| `v` | the value as UTF-8 bytes (a BLOB, so an embedded NUL survives), or a counter as decimal text |
| `i` | the incarnation: a random UUID chosen by the write that created the key |
| `r` | the revision: 1 on create, +1 on every write |
| `e` | absolute expiry, Unix milliseconds; indexed |

The version a caller sees is `<i>:<r>`. A version from a deleted or expired
incarnation never matches the recreated key, so there is no ABA.

Every conditional write is **one statement** with its condition in the
`WHERE` clause: `INSERT … ON CONFLICT DO UPDATE … WHERE` for `putIfAbsent` and
`increment`, `UPDATE … WHERE` for `compareAndSet` and `expire`, `DELETE … WHERE`
for the versioned delete. SQLite runs each statement in its own write
transaction and a libSQL server serialises writes, so no read-then-write ever
crosses a round trip and independent clients need no lock. `RETURNING` reports
whether it applied.

**Time.** "Now" is the database's clock by default, so every client agrees on
expiry, as with Redis TTLs. A test injects a clock instead.

**Expiry.** Reads treat `e <= now` as absent. Expired rows are removed
lazily: the next `putIfAbsent` or `increment` of the key replaces the row in
place with a new incarnation, an unconditional `delete` removes it, and a
bounded purge (`DELETE` of at most 64 expired rows through the `e` index,
never a scan) rides in the same request as a write at most once a minute per
client.

**Counters.** `increment` refuses a value that is not a decimal integer of at
most 16 digits, or a sum outside the safe integer range: no row returns, the
call is rejected with `EPHEMERAL_BACKEND_REJECTED`, and the stored value is
untouched — never reset, never turned into a float.

Errors are `KvRedisCompatibleError` with the Redis binding's codes, so a host
handles every cache binding alike.

## Rows read and written

Turso bills rows, not requests. Its definitions
([usage and billing](https://docs.turso.tech/help/usage-and-billing)): a row
read is a row scanned while a statement runs; a row written is a row inserted,
updated or deleted. Every statement here reaches at most one row through the
primary key, so:

| Port call | Requests | Rows read (max) | Rows written (max) |
|---|---|---|---|
| `get` | 1 | 1 | 0 |
| `getMany(n)` | 1 (one batch above 256 keys) | n | 0 |
| `putIfAbsent` | 1 | 1 | 1 if applied, else 0 |
| `compareAndSet` | 1 | 1 | 1 if applied, else 0 |
| `delete` (unconditional) | 1 | 1 | 1 if a row existed, live or expired |
| `delete` (versioned) | 1 | 1 | 1 if applied |
| `increment` | 1 | 1 | 1 (0 when rejected) |
| `expire` | 1 | 1 | 1 if the key is live |
| lock acquire / renew / release | 1 | 1 | 1 |
| ring append | 3 | 3 | 3 |
| ring read (window of w) | 2 | 1 + w | 0 |
| purge (in a write's request, ≤ once a minute per client) | +0 | ≤ 2 × removed + 1 | removed (≤ 64) |

`LIBSQL_EPHEMERAL_COST` exports the table. Requests per call equal the Redis
binding's `EPHEMERAL_STATE_COMMAND_COST`, and the conformance suite's cost case
measures them. Rows are upper bounds derived from Turso's definitions, **not
measured**: the libSQL protocol does not return rows read or written, so the
binding reports its own estimate per call through `onRows`, and
`createLibsqlUsageMeter` sums requests and rows. Two things are undocumented
and assumed: that a primary-key lookup that finds nothing bills no read, and
that maintaining the `e` index does not bill an extra written row. If Turso
counts index writes, every write that changes `e` costs two. Compare the
estimate with the database's stats endpoint once deployed.

Turso's free plan allows 500 million rows read and 10 million rows written a
month and blocks the database when either runs out
([pricing](https://turso.tech/pricing), as stated by the relay's design;
`TURSO_FREE_ROWS_ALLOWANCE`). Writes are the binding constraint: at the
relay's measured 62–73 cache operations a job, even if every one wrote a row,
10 million rows cover 10,000,000 / 30 / 73 ≈ 4,500 jobs a day, before purges
and repair ticks.

## Environment

`createTursoEphemeralState({ env })` reads `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN`, the names the Marketplace integration injects; `prefix`
prepends a string verbatim to both, for an integration connected with a custom
prefix. Only names are logged or returned; a value never appears, not even in
an error. Half a pair, a `file:` URL, plain `http:` to a remote host, or a URL
with embedded credentials is refused.

The client is `@libsql/client/http` (pinned 0.18.0, published 2026-09-02):
`fetch` only, no WebSocket, no native module, so it bundles into a Vercel
Function in either runtime. A `libsql://` URL goes over HTTPS: the client
expands `libsql:` with HTTP preferred (`expandConfig(config, true)` in
`@libsql/core`; see the
[client API reference](https://github.com/tursodatabase/libsql-client-ts/blob/main/_autodocs/api-reference/client-web.md)).
The package's root `@libsql/client` entry, which loads the `libsql` native
module for `file:` URLs, is imported only by the tests.

## What the tests establish

All offline; nothing contacts Turso.

| Test | Proves |
|---|---|
| `ephemeral-conformance.test.ts` | The 24 cases pass on four lanes: a `file:` database with four in-process clients; `:memory:` with one client (a memory database is private to its connection); a `file:` database with one client in this thread and three in worker threads, racing real connections and SQLite's locks; and a `file:` database on the database's own clock with real sleeps |
| `libsql-binding.test.ts` | First-use schema creation, query plans that never scan, bounded purging, lazy replacement of expired rows, the counter guard, one request for a 600-key `getMany`, and the rows estimate |
| `statement-pact.test.ts` | The statement pact from both sides (below) |
| `turso-env.test.ts` | Names never values; `libsql:` sent as HTTPS `fetch` with a bearer header and no request before the first call |

Not established: behaviour against a remote Turso database or `sqld` over the
network, and the real rows Turso bills.

## Gates

- **TypeScript:** `pnpm --filter @hobo/provider-turso run build`.
- **Protobuf + CUE:** `data-models/libsql_ephemeral_state.proto` (the stored
  row, the per-operation cost, the usage snapshot, the environment-name
  record) with `libsql_ephemeral_state.cue` constraining every message;
  `src/_generated/` is generated by `pnpm run codegen`. Parse, don't
  validate: the TypeScript types are parsed derived types — keys, TTLs and versions are the
  branded parsed types of `@hobo/core`, incarnations are parsed before they are
  written, and every row read back is parsed into an entry or rejected as a
  contract error.
- **PACT:** [`contracts/libsql-ephemeral-state.pact.json`](./contracts/README.md).

## Architecture placement

This package is a binding behind a port, not a domain service. It handles no
command and emits no events, runs no actor, and keeps no event store,
projection, materialized view, snapshot or read store: the relay's event-driven
state (GitHub as the system of record, queue messages for each lease step)
lives above the port, and what is stored here is the loss-tolerant cache that
design rebuilds from.
