---
type: Design
title: "Relay Ephemeral State"
description: "The short-lived cache port the hosted CI relay keeps its loss-tolerant state in: TTL, compare-and-set, counters, locks and a capped change ring over any Redis-protocol store, bound to Upstash REST on Vercel or a self-hosted Valkey over TCP with no relay code change."
tags: [hobo, design, ci, data-plane]
---

# Relay Ephemeral State

**Status:** the port, its three bindings and their conformance suite are
implemented. The relay does not use it yet; moving the relay's lease records,
markers and counters onto it is a later phase.

## Why

The hosted CI relay is being redesigned to keep no durable state. What it
still needs between requests is small and rebuildable from GitHub and Vercel:

| State | Shape on the port |
|---|---|
| Per-job lease record | `putIfAbsent` to take, `compareAndSet` to update, versioned `delete` to finish |
| Job-taken marker, webhook/step dedupe key | `putIfAbsent` with a TTL past the redelivery window |
| Per-account in-flight index | a small JSON value updated by `compareAndSet` |
| Rate counter | `increment(..., "on-create")`: the window starts at the first hit and lapses on schedule |
| Scanner lock | `acquireEphemeralLock` / `renewEphemeralLock` / `releaseEphemeralLock` |
| MCP change feed | `createEphemeralRing`: capped, ordered by a monotonic sequence |

Losing any of it costs a rebuild, not correctness, so a cache with TTL is the
right store and a database is not. On 2026-11-10 the relay's hosted Postgres
went over quota and the relay answered 503 to everything
([CI Relay Mesh](./ci-relay-mesh.md#no-hosted-database-in-the-job-path)); a
store the relay can afford to lose does not have that failure mode.

## The port

`EphemeralStatePort` is in `@hobo/core` (`src/ports/ephemeral-state.ts`), next
to the other port contracts, because the relay, its tests and every binding
compile against it and core is the one package all of them already depend on.
Keys, TTLs and versions are parsed into branded types at the boundary; the
wire records are `data-models/ephemeral_state.proto`, constrained by
`ephemeral_state.cue`. Every write carries a TTL of at most 30 days; there is
no way to write a key that never expires.

The lock and ring helpers are built on the port's primitives only, so they
behave the same on every binding. Package docs:
[`@hobo/kv-redis-compatible`](../../packages/kv-redis-compatible/README.md)
has the method table, the command cost of each call, and the conformance lanes.

## Bindings

One implementation (`createRedisEphemeralState`) runs Lua scripts through an
injected executor; only the executor differs.

| Binding | Executor | Package |
|---|---|---|
| Upstash REST (Vercel Marketplace) | `fetch` to the REST endpoint, `EVALSHA`/`EVAL` in the JSON envelope | `@hobo/provider-upstash` |
| Self-hosted Valkey or Redis | RESP over TCP (`ioredis`) | `@hobo/kv-redis-compatible/resp` |
| In-memory (tests) | the scripts' semantics in TypeScript, injectable clock | `@hobo/kv-redis-compatible` |

### Choosing the binding from the environment

A composition root reads names, in this order, and never logs a value:

1. `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, then
   `KV_REST_API_URL` + `KV_REST_API_TOKEN` — `resolveUpstashRestEnv`. Each
   pair is used whole.
2. `VALKEY_URL`, then `REDIS_URL` — `resolveRedisProtocolEnv`.

The Marketplace Upstash integration injects the REST pair under one of the two
names above. Which pair a given project has depends on how its store was
created: `KV_REST_API_*` is the naming of Vercel KV, which Vercel moved to
Upstash in December 2024, and `UPSTASH_REDIS_REST_*` is Upstash's own. The
`@upstash/redis` SDK's `Redis.fromEnv()` reads the same two names in the same
order "for compatibility with Vercel KV", so reading both is what that SDK
does. The integration may also inject `REDIS_URL` (Vercel's chat SDK guide
asks for it), which is why the REST pair is checked first: on Vercel the relay
uses REST, and `REDIS_URL` binds TCP only where no REST pair is set. Sources:
[upstash/redis-js `platforms/nodejs.ts`](https://github.com/upstash/redis-js/blob/main/packages/redis/platforms/nodejs.ts),
[Redis on Vercel](https://vercel.com/docs/redis),
[Chat SDK quickstart](https://vercel.com/docs/chat-sdk/quickstart).
Confirm the names on the project itself before relying on them; this was not
read from a live project.

### Self-hosted Valkey

Set `VALKEY_URL=redis://:<password>@host:6379` (or `rediss://` for TLS) and
leave the REST pair unset. Valkey needs `requirepass` and nothing else: the
scripts use `EXISTS`, `HSET`, `HMGET`, `HINCRBY`, `PEXPIRE` and `DEL` only.
On a clustered Valkey a ring's keys share the `{<ring name>}` hash tag, so its
multi-key read stays in one slot.

## Command budget

Every port call is one backend command once scripts are cached; a ring append
is three and a ring read two. A script's first call against a server that has
not cached it costs one extra `EVAL`. `meterExecutor` counts what is actually
sent by verb, and `commandBudgetStatus` projects it against a monthly
allowance. A relay doing 1,000 leases a day (acquire, renew, release and one
feed append: 6 commands) spends about 180K commands a month.

## What the tests establish

The same 24 conformance cases run on the in-memory engine, on a real
Valkey/Redis over RESP, and through the Upstash REST adapter over a local HTTP
server backed by either engine. The real-server lanes start a local
`valkey-server` or `redis-server` and are skipped when neither binary is
present. Nothing runs against Upstash itself, and nothing claims durability.

## Related

- [CI Relay Mesh](./ci-relay-mesh.md) — the relay this state serves.
- [`@hobo/provider-upstash`](../../packages/providers/provider-upstash/README.md) — the REST binding.
- [`@hobo/core` architecture](../../packages/core/ARCHITECTURE.md) — the port contracts.
