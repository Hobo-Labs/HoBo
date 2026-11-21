# Agent37 provider test fake

This package currently contains only the PR1 test harness for Agent37's Sandbox API. The production export is intentionally empty; the client, bounded transport, and capability manifest belong to a later change.

`test/fake/index.ts` exports an in-process HTTP server and a Testcontainers starter. The fake covers instance CRUD and lifecycle operations, synchronous and background exec with five-minute name idempotency, webhooks with Standard Webhooks signatures, and documented capacity, balance, memory-limit, and injected rate-limit failures. It uses runtime-generated test credentials and never calls the real Agent37 service.

Run the fake self-tests and build the empty production entrypoint with:

```sh
pnpm --filter @hobo/provider-agent37 test
pnpm --filter @hobo/provider-agent37 build
```

`startFakeAgent37Server({ requireContainer: true })` requires Docker. Without that option, the starter uses the container when Docker is available and otherwise falls back to the in-process server.

## Contract boundaries

Request handlers follow parse, don't validate: `parseCreateRequest` and `parseExecRequest` convert untrusted JSON into parsed domain types before capacity guards or command execution can use them. Protobuf and CUE fixtures describe the fake's instance, exec, webhook, and error payloads; the PACT fixture records its API and exec authentication boundaries. Webhook callbacks require HTTPS except for loopback HTTP receivers in local tests. Malformed JSON receives a 400 `invalid_request` response, and unexpected failures return a stable `internal_error` envelope without internal error details.

PR1 is an ephemeral HTTP test double, not a durable application. It accepts command requests and emits synthetic webhook events, but has no actor, event store, materialized view or projection, snapshot, or read store. Its in-memory state is discarded when the server closes.
