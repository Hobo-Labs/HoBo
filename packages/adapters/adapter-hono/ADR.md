# ADR — `@hobo/adapter-hono`

## Status

Accepted

## Context

Apps often use Hono for HTTP. HoBo core must stay framework-free so local and
isolated-wasm hosts only see `(Request) => Response` and wasi:http guests.

## Decision

Ship Hono support as an **L2 adapter package** under `packages/adapters/`:

- Package name: `@hobo/adapter-hono`
- Depends on `@hobo/core` + `hono` only (adapter → core rule)
- Exports `honoEntrypoint` / `toFetchHandler` for bindle local-host entrypoints
- Does **not** live in `@hobo/hobo` or `@hobo/core`
- Does **not** componentize Hono into wasm; isolated-wasm guests remain app-supplied

## Consequences

- Bindles that want Hono take an explicit dependency on `@hobo/adapter-hono`
- New frameworks (Express, Fastify, …) follow the same `packages/adapters/adapter-*` pattern
- Architecture boundary classification treats `packages/adapters/*` as L2 adapters
