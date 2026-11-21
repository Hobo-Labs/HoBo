# Agent37 CI runner provider

`@hobo/provider-agent37` implements the Agent37 Sandbox API boundary used by CI runner controllers. It provides instance create/get/list/delete, synchronous and background exec, webhook registration/list/delete, and usage reads. It does not implement signup, wallet top-up, Git linking, or CD delivery.

## Client and transport

```ts
import { createAgent37Client } from "@hobo/provider-agent37";

const client = createAgent37Client({
	apiKey: process.env.AGENT37_API_KEY ?? "",
	fetchImpl: globalThis.fetch,
});
const instances = await client.listInstances();
```

Every success response is parsed with Zod. This is parse, don't validate: `Agent37Instance`, `Agent37ExecResult`, `Agent37Webhook`, and `Agent37Usage` are derived types inferred from those parsers, so untrusted JSON crosses the transport boundary once and core client methods return parsed values rather than DTOs plus repeated checks. The fake similarly converts request JSON into its parsed `ParsedCreate` and `ParsedExec` domain types before capacity or execution logic can consume them. Request objects reject unknown keys, request and response bodies are capped at 1 MiB, and provider responses become `Agent37Error` values. Error messages, stacks, serialized errors, and schema failures do not retain raw provider causes. `redactAgent37Text` covers `sk_live_` API keys and `whsec_` webhook secrets in addition to the shared provider credential shapes.

The transport composes `@hobo/core` bounded fetch and endpoint guards. It permits HTTPS on the default port only for:

- `api.agent37.com/v1/*` with `Authorization: Bearer`.
- `sandbox.agent37.app/v1/instances/{id}/exec` with `X-Agent37-Key`.

All other hosts, schemes, ports, and path prefixes are refused. Redirects use manual handling and are rejected. Automatic retries apply only to GET and HEAD after `no_capacity`, `try_again`, or a 5xx response. Backoff has bounded attempts and jitter, honors numeric and HTTP-date `Retry-After`, and caps each delay and the cumulative retry window. Network failures and POST/DELETE requests are never replayed automatically. A named exec response has `Agent37Error.retryable: true` so its caller can deliberately replay the idempotent operation; instance creation and unnamed exec remain non-retryable.

Webhook registration accepts public HTTPS URLs and loopback HTTP URLs for local tests. Instance and webhook deletion accept either an empty 204 response or a 200 response containing `{ "id": "...", "deleted": true }`.

## Capability manifest

`publishCapabilityManifest()` emits canonical index, capabilities, auth, and cost documents. The capability is `ci/runner`; Agent37 is not a hosting delivery target. The auth document records `static-api-key`, `staticSecrets: true`, full-workspace scope, manual dashboard rotation, and no OIDC or OAuth support. Cost facts are estimates in USD per instance-minute, transcribed from the public instance-sizing documentation on 2026-11-20. They are ranking inputs, never billing inputs.

## Published offline fake

```ts
import {
	createAgent37FakeServer,
	generateAgent37TestApiKey,
} from "@hobo/provider-agent37/fake";

const fake = await createAgent37FakeServer({
	apiKey: generateAgent37TestApiKey(),
});
const created = await client.createInstance({
	template: "agent37-ubuntu",
	type: "vm",
	region: "us",
	resources: { cpu: 2, memory: 4, disk: 20 },
});
console.log(fake.state.instances, created.id);
await fake.close();
```

The `./fake` export is compiled from `src/fake.ts` and `src/fake/server.ts`, not re-exported from a test directory. Other workspaces such as `@hobo/ci-vercel` can consume it without reaching into this package's tests. Tests in this package import that same subpath.

The in-process HTTP fake covers:

- API and exec authentication, instance CRUD, stop/start/sleep/restart/update, resize, and fork.
- Synchronous and background exec, 512 KiB stdout/stderr limits, and five-minute idempotent replay by instance and exec name.
- Webhook CRUD, the five-webhook ceiling, and Standard Webhooks HMAC-SHA256 signatures.
- Usage responses, insufficient balance, workspace memory limits, regional `no_capacity`, and injected 429/5xx faults.
- Bounded request bodies, malformed JSON errors, and generic internal error envelopes.

State is in memory and disappears on close. Environment variables are write-only in HTTP responses but available to the fake exec handler. The fake is hand-authored from documented behavior; it is not provider-verified and makes no real Agent37 calls.

## Testcontainers

```ts
import { startFakeAgent37Server } from "@hobo/provider-agent37/fake/container";

const started = await startFakeAgent37Server({ requireContainer: true });
await started.close();
```

The wrapper starts `node:24-alpine` with the same fake server. Unavailable Docker is an error by default. `allowInProcessFallback: true` explicitly selects the in-process fallback; `requireContainer: true` forbids it. Normal tests exercise only fallback selection and do not require Docker.

## Contracts and validation

`data-models/agent37_fake.proto` and `data-models/agent37_fake.cue` describe fake instance, exec, webhook, usage, and error records, with valid and invalid JSON fixtures. `contracts/pacts/agent37_sandbox_fake.pact.json` records hand-authored consumer expectations for create, exec, usage, and authentication failures. Runtime parser tests cross-check the JSON fixtures. No provider has verified the PACT document.

The client and fake are ephemeral HTTP adapters, not durable applications. They define no command or event family, actor, event store, materialized view or projection, snapshot, or read store. The fake discards its in-memory state when the server closes.

```sh
pnpm --filter @hobo/provider-agent37 typecheck
pnpm --filter @hobo/provider-agent37 test
pnpm --filter @hobo/provider-agent37 build
```

## Explicit live read-only smoke

`pnpm --filter @hobo/provider-agent37 test:live` calls only `listInstances`. It fails unless `AGENT37_API_KEY` is explicitly supplied. The default package test configuration excludes this file, so normal and CI tests make no live Agent37 calls.
