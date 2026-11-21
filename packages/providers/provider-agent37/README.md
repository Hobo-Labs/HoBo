# Agent37 CI runner provider

`createAgent37Client` covers instance create/get/list/delete, sandbox exec, webhook registration/list/delete, and workspace usage. Every response crosses a Zod parser. Instance and webhook deletion require `{ "deleted": true }` on 200 and an empty body on 204. Create-instance inputs reject unknown security controls, and webhook registration accepts HTTPS URLs only. Provider failures become `Agent37Error` values whose messages and serialized details pass through `@hobo/provider-redaction`, including explicit `sk_live_` API-key and `whsec_` webhook-secret redaction.

The transport composes `@hobo/core`'s bounded fetch and guard. It permits HTTPS requests only to `api.agent37.com` and `sandbox.agent37.app` under `/v1/`, refuses redirects, and automatically retries only GET and HEAD requests receiving `no_capacity`, `try_again`, or 5xx responses with bounded attempts, jittered backoff, and `Retry-After` support capped by `AGENT37_MAX_TIMEOUT_MS`. `Agent37Error.retryable` follows the same method-aware policy, with named exec requests marked retryable for an explicit caller-controlled retry; unnamed POST requests, including instance creation, are not retryable.

`publishCapabilityManifest` publishes the `ci/runner` capability, the full-workspace static API key requirements, and estimated per-minute costs transcribed from Agent37's public instance-sizing documentation on 2026-11-20. Agent37 is registered as a refused CD delivery target because CI policy selects it as a runner provider.

## Offline contracts

`test/fake/index.ts` exports an in-process HTTP server and a Testcontainers starter. The fake covers instance CRUD and lifecycle operations, synchronous and background exec with five-minute name idempotency, webhooks with Standard Webhooks signatures, usage, and documented capacity, balance, memory-limit, and injected rate-limit failures. It uses runtime-generated test credentials and never calls the real Agent37 service.

```sh
pnpm --filter @hobo/provider-agent37 test
pnpm --filter @hobo/provider-agent37 build
```

`startFakeAgent37Server({ requireContainer: true })` requires Docker. The starter falls back to the in-process server only with `allowInProcessFallback: true`; otherwise unavailable Docker is an error.

Request handlers follow parse, don't validate: `parseCreateRequest` and `parseExecRequest` convert untrusted JSON into parsed domain types before capacity guards or command execution can use them. Protobuf and CUE fixtures describe the fake's instance, exec, webhook, and error payloads; the PACT fixture records positive and negative API and exec authentication boundaries. Webhook callbacks require HTTPS except for loopback HTTP receivers in local tests. Malformed JSON receives a 400 `invalid_request` response, and unexpected failures return a stable `internal_error` envelope without internal error details.

The client and fake are ephemeral HTTP adapters, not durable applications. They define no command or event family, actor, event store, materialized view or projection, snapshot, or read store. The fake discards its in-memory state when the server closes.

## Live read-only smoke

`test/live-agent37.test.ts` and `pnpm --filter @hobo/provider-agent37 test:live` run only `listInstances` against the documented API. The explicit live command fails unless `AGENT37_API_KEY` is supplied. Default package and CI tests exclude the live test and make no real Agent37 calls.
