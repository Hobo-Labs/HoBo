# `@hobo/provider-vercel-blob`

The Vercel Blob binding of `EphemeralStatePort` (`@hobo/core`), so the hosted
CI relay ([ADR-0179](../../../docs/design/adr/hosted-relay-stateless.md#adr-0179))
can keep its loss-tolerant cache in a private Blob store connected to its own
Vercel project, authenticated by the deployment's OIDC token with no stored
secret. Semantics are the Redis binding's, checked by the same 24-case
conformance suite from `@hobo/kv-redis-compatible`. Design:
[Relay Ephemeral State](../../../docs/design/relay-ephemeral-state.md#vercel-blob).

```ts
import { createVercelBlobEphemeralStateFromEnv } from "@hobo/provider-vercel-blob";

const cache = createVercelBlobEphemeralStateFromEnv({ env: process.env });
// undefined when no BLOB_STORE_ID is set
await cache?.port.putIfAbsent(key, value, ttlMs);
```

## Why a separate provider package

`packages/providers/provider-<vendor>` is where a hosted vendor's binding and
its environment names live; `@hobo/provider-upstash` (Upstash REST) and
`@hobo/provider-turso` (libSQL) hold bindings of the same port.
`@hobo/provider-vercel` is the wrong home despite the vendor: it is the Vercel
*CloudProvider* (equivalence, temporary stations, the sponsored project
transfer), private, and depends on `@hobo/claims` and `@hobo/bindings`. Adding
`@vercel/blob` and the cache port there would put an SDK the provider does not
need into its graph and pull the provider's graph into the relay's function
bundle. This package depends on `@hobo/core`, `@hobo/kv-redis-compatible` (the
shared error codes and the conformance suite) and `@vercel/blob`, nothing else.

## Storage

One **private** blob per key, at `<namespace>/<base64url(key)>`
(`hobo-ephemeral/` by default). Port keys may hold `/`, `:` and braces; Blob
treats `/` as a folder separator, refuses `//` and does not support control
characters ([pathname characters](https://vercel.com/docs/vercel-blob#pathname-characters)),
so the key is encoded. A 512-character key under a 200-character namespace
stays under the SDK's 950-character pathname limit.

The body is a `VercelBlobEphemeralRecord` (`data-models/`) in protobuf JSON:

| Field | Holds |
|---|---|
| `format` | `hobo.vercel-blob.ephemeral/v1`; any other body under the namespace is a contract error, never overwritten |
| `value` | the value, as a JSON string (an embedded NUL survives) |
| `incarnation` | a random UUID chosen by the write that created the key |
| `revision` | 1 on create, +1 on every value write |
| `expiresAtMs` | absolute expiry, Unix milliseconds, by the writer's clock |
| `writeId` | a random id per write (see *Lost replies*) |

The version a caller sees is `<incarnation>:<revision>`, so a version from a
deleted or expired incarnation never matches the recreated key (no ABA). The
blob's **ETag** is what each conditional write binds to.

## How each call maps to Blob

Every read is `get(pathname, { access: "private", useCache: false })`, an
origin read that "guarantees the latest content"
([consistent reads](https://vercel.com/docs/vercel-blob/private-storage#consistent-reads));
a cached read could return a version up to 60 seconds old and is never used.

| Port call | Blob calls (uncontended) | Why it is atomic |
|---|---|---|
| `get` | `get` | — |
| `getMany(n)` | `n` parallel `get`s (8 in flight by default) | — |
| `putIfAbsent` | `put` with `allowOverwrite: false`; if refused, `get`; if the stored record has expired, `put` with `ifMatch` on its ETag | The store refuses a create-only upload on an existing pathname; of two callers replacing one expired blob, only one `ifMatch` can match |
| `compareAndSet` | `get`, check version and expiry, `put` with `ifMatch` | The ETag binds the version check to the write: any rewrite in between changes it, and the write is refused (`BlobPreconditionFailedError`) |
| `delete` | `get`, then `del` with `ifMatch` | Same; the read is also how a delete reports whether a *live* key was removed |
| `increment` | `get`, then `put` with `ifMatch` (or create-only if absent) | Read-and-compare-and-set; a refused write re-reads and tries again |
| `expire` | `get`, then `put` with `ifMatch` of the same record with a new expiry | Same; the version does not change |

Conditional `put` and `del` with `ifMatch`, and `get` with `useCache`, are in
the pinned SDK 2.8.2 (`DeleteCommandOptions.ifMatch`, `PutCommandOptions.ifMatch`,
`GetCommandOptions.useCache` in its `dist/index.d.ts`;
[SDK reference](https://vercel.com/docs/vercel-blob/using-blob-sdk),
[conditional writes](https://vercel.com/docs/vercel-blob#conditional-writes)).
`head()` also returns an `etag`, but the binding never needs it: it needs the
version inside the body, and a `get` returns the body and its ETag together.
A delete is conditional, never a tombstone.

### Contention

A refused conditional write re-reads and decides again, after a jittered
exponential backoff (5 ms doubling to 250 ms, full jitter), at most 64 rounds
(`retry` options). `compareAndSet` and a versioned `delete` retry only while
the stored version still equals the expected one — that happens when an
`expire` rewrote the blob without changing its version — and otherwise report
a lost race. `increment` and the replacement of an expired key retry until they
apply. Each lost round costs one more read and one more upload, so `n`
clients incrementing one key at the same moment cost O(n²) operations in the
worst case; past 64 rounds the call throws `VercelBlobContentionError` and
nothing is applied. A ring's sequence counter is such a hot key: a busy ring
on Blob is markedly more expensive than on Redis, where an increment is one
command whatever the contention.

### Lost replies

The SDK retries a request after a network error or a 5xx (10 times by default,
`VERCEL_BLOB_RETRIES`). If the first attempt landed, the retry of a
conditional upload is refused, which would look like a lost race. Every write
carries a fresh `writeId`, and after a refusal the binding reads the blob
back: if it holds one of this call's write ids, the call reports success. A
`delete` whose reply was lost cannot be recognised that way (nothing is left
to read) and reports `false`; for a lock release that means a release that
worked is reported as not having held the lock.

### Time and expiry

Blob has no TTL. Expiry is the record's `expiresAtMs`, set from this client's
clock (`now`, default `Date.now`), so relay instances must agree on time to
within the precision their TTLs need. Reads treat an expired record as absent.
Expired blobs are replaced in place by the next `putIfAbsent` or `increment`
of the key, removed by a `delete` (which still reports `false`), and swept by
`purgeExpiredBlobs` — a bounded pass for a scheduled job, never a request
path:

- one `list` page (up to 1,000 pathnames, one advanced operation) per pass by
  default;
- a blob last uploaded more than the longest TTL (30 days, the port's limit)
  plus one minute of clock skew ago is expired whatever it holds, and is
  deleted on its listed ETag **without being read**;
- up to `maxReads` (64) younger blobs are read (one simple operation each)
  and deleted if expired;
- every delete is ETag-conditional, so a blob rewritten since it was listed
  or read is kept. Deletes are free. Lazy expiry is already correct without a
  purge; the purge only stops dead keys from accruing storage.

## Operations per call, and what they cost

Blob bills **simple operations** (a cache-miss read or a metadata read),
**advanced operations** (an upload, copy or list) and storage; **deletes are
free** but count against the advanced-operation rate limit
([usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing),
page dated 2026-09-23). Every read here is an origin read, counted as one
simple operation. A refused upload is budgeted as a billed advanced
operation: the docs do not say otherwise.

| Port call | Simple | Advanced | Deletes |
|---|---|---|---|
| `get` | 1 | 0 | 0 |
| `getMany(n)` | n (distinct keys) | 0 | 0 |
| `putIfAbsent`, key absent | 0 | 1 | 0 |
| `putIfAbsent`, key live (lost) | 1 | 1 | 0 |
| `putIfAbsent`, expired blob replaced | 1 | 2 | 0 |
| `compareAndSet` | 1 | 1 | 0 |
| `compareAndSet`, stale version | 1 | 0 | 0 |
| `delete` | 1 | 0 | 1 |
| `increment` | 1 | 1 | 0 |
| `expire` | 1 | 1 | 0 |
| lock acquire / renew / release | 0 / 1 / 1 | 1 / 1 / 0 | 0 / 0 / 1 |
| ring append (once full) | 2 | 2 | 1 |
| ring read (window of w) | 1 + w | 0 | 0 |
| each lost conditional write | +1 | +1 | 0 |
| purge, per listed page | 0 | 1 | free deletes |

`VERCEL_BLOB_EPHEMERAL_COST` exports the table; `meterVercelBlobSdk` counts
the SDK calls actually made by class, and `test/blob-cost.test.ts` asserts the
two agree for every row. A read also bills Blob Data Transfer and Fast Origin
Transfer for the body's bytes (a record is the value plus about 200 bytes). Whether a read of a missing blob (a 404) bills a simple operation is
not documented; it is counted as one.

**Prices** ([vercel.com/pricing](https://vercel.com/pricing), read
2026-11-11; `VERCEL_BLOB_PRICING`): on **Pro**, $0.40 per million simple
operations, $5.00 per million advanced operations and $0.023 per GB-month of
storage, drawn from the plan's $20 monthly usage credit and then on demand;
Blob data transfer is "Included in Flat Rate CDN". Prices are regional; the
docs' pricing example uses these for `iad1`, with Blob Data Transfer at
$0.05/GB and Fast Origin Transfer at $0.06/GB. **Hobby** includes 10,000
simple and 2,000 advanced operations, 1 GB of storage and 10 GB of transfer a
month, and blocks Blob for 30 days once one is exceeded. Rate limits: Pro
7,200 simple and 4,500 advanced operations a minute, Hobby 1,200 and 900
([operation rate limits](https://vercel.com/docs/vercel-blob/usage-and-pricing#operation-rate-limits)).

### Compared with the other bindings

The design's reference load is 1,000 leases a day, each an acquire, a renew, a
release and one feed append
([command budget](../../../docs/design/relay-ephemeral-state.md#command-budget)):

| Binding | Per lease | A month (30,000 leases) | Against |
|---|---|---|---|
| Upstash REST (`@hobo/provider-upstash`) | 6 commands | 180,000 commands | 500,000 commands a month free ([ADR-0179 cost table](../../../docs/design/hosted-relay-stateless.md)) |
| Turso (`@hobo/provider-turso`) | 6 requests; at most 6 rows read and 6 written | at most 180,000 rows written | 10 million rows written a month free, per that package's README |
| **Vercel Blob (this package)** | 4 simple, 4 advanced, 2 free deletes | 120,000 simple + 120,000 advanced | **Pro: about $0.65** of the $20 credit; **Hobby: over its 2,000 advanced operations after about 500 leases** |

Blob is the only binding with no free tier that fits the relay, and the only
one whose contended writes cost more than one operation. What it buys is
first-party storage on the relay's own Vercel project with no third-party
account and no stored secret. Every figure above is derived from the
published definitions, not measured on a bill; compare with the store's
Observability → Blob page once deployed.

## Environment and provisioning

`createVercelBlobEphemeralStateFromEnv({ env })` and `resolveVercelBlobEnv(env)`
read `BLOB_STORE_ID` (with an optional `prefix` for a store connected under a
custom prefix) and report, by name and presence only, whether
`VERCEL_OIDC_TOKEN` and `BLOB_READ_WRITE_TOKEN` are set. The store id is "an
identifier, not a secret"
([OIDC access by default](https://vercel.com/docs/vercel-blob#oidc-access-by-default))
and is passed explicitly to every call; no token is ever read, passed or
logged by this package. The SDK resolves the credential itself — the OIDC
token, which it refreshes, then `BLOB_READ_WRITE_TOKEN` — and the docs warn
that passing the OIDC token explicitly bypasses that refresh. In a Vercel
Function the OIDC token arrives per request, so `oidcTokenInEnv` is false
there and the SDK still finds it. A host that must stay secretless (ADR-0027)
should refuse to bind when `readWriteTokenPresent` is true.

**The store is created and connected by the project owner, or by the CI
deploy step** — the dashboard (Storage → Create → Blob → Private) or
`vercel blob create-store <name> --access private --yes` from the linked
project ([private storage](https://vercel.com/docs/vercel-blob/private-storage#creating-a-private-blob-store)).
Connecting it is what adds `BLOB_STORE_ID` and the OIDC trust. An agent's MCP
identity is refused this operation and must not be used for it.

## What the tests establish

All offline; nothing contacts Vercel.

| Test | Proves |
|---|---|
| `ephemeral-conformance.test.ts` | The 24 cases pass on three lanes: the in-memory store with four clients; with eight clients, a random delay before every call and the default jittered backoff; and the real `@vercel/blob` 2.8.2 SDK over HTTP to a local emulator with three clients |
| `blob-cost.test.ts` | Every row of the cost table, counted at the SDK, including one lost race |
| `blob-binding.test.ts` | Record format and pathname encoding, refusal classification, lost-reply recovery, the contention limit and backoff, a `compareAndSet` racing an `expire`, foreign blobs refused, lazy expiry, the purge (unread deletes of long-dead blobs, read budget, cursor, ETag-conditional deletes) |
| `sdk-wire.test.ts` | What the pinned SDK sends for the binding's options (`x-allow-overwrite`, `x-if-match`, `x-vercel-blob-access`, `?cache=0`, the delete body) and how it decodes `412` and `404` |
| `blob-pact.test.ts` | The HTTP pact from both sides ([contracts](./contracts/README.md)) |
| `env.test.ts` | Names and presence, never a token; the store id reaches every call |

The in-memory store (`createMemoryBlobSdk`, exported for relay tests) throws
the SDK's own error classes and hands out ETags from one increasing counter.
The concurrency cases (32 racing `putIfAbsent`s, 50 concurrent increments
across clients, 16 lock contenders, 20 concurrent ring appends) run on every
lane. The suite's cost case asserts the Redis table, one command per call;
here it counts port calls, which checks the lock and ring helpers, while the
Blob operations per call are `blob-cost.test.ts`'s.

**Not established:** behaviour against a real Blob store. In particular the
API's answer to a create-only upload on an existing pathname, and to a
conditional delete of a blob that is already gone, are undocumented; the
binding treats any refusal it cannot classify as "read and decide", so a
different answer costs a read rather than a wrong result, but it has not been
observed. Nor are the billed figures measured.

## Gates

- **TypeScript:** `pnpm --filter @hobo/provider-vercel-blob run build`; the
  real SDK's functions are assigned to the binding's `VercelBlobSdk` type, so a
  signature change in `@vercel/blob` fails the build.
- **Protobuf + CUE:** `data-models/vercel_blob_ephemeral_state.proto` (the
  stored record, the per-operation cost, the usage snapshot, the purge report,
  the environment-name record) with `vercel_blob_ephemeral_state.cue`
  constraining every message; `src/_generated/` is generated by
  `pnpm run codegen`. Parse, don't validate: the TypeScript types are parsed
  derived types — keys, TTLs and versions are the branded parsed types of
  `@hobo/core`, the namespace is a branded `VercelBlobNamespace`, and every
  body read back is decoded by the generated schema and parsed into a
  `StoredRecord` or rejected as a contract error.
- **PACT:** [`contracts/vercel-blob-ephemeral-state.pact.json`](./contracts/README.md).

## Architecture placement

This package is a binding behind a port, not a domain service. It handles no
command and emits no events, runs no actor, and keeps no event store,
projection, materialized view, snapshot or read store: the relay's
event-driven state (GitHub as the system of record, queue messages for each
lease step) lives above the port, and what is stored here is the loss-tolerant
cache that design rebuilds from.
