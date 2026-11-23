# Agent37 offline API fake

`@hobo/provider-agent37` publishes an offline, in-memory fake of the Agent37 Sandbox API and a Testcontainers wrapper for cross-process contract tests. This package currently contains only that test boundary; it does not implement the live client, provider manifest, signup, wallet top-up, Git linking, or delivery.

## In-process server

```ts
import {
	createAgent37FakeServer,
	generateAgent37TestApiKey,
} from "@hobo/provider-agent37/fake";

const fake = await createAgent37FakeServer({
	apiKey: generateAgent37TestApiKey(),
	execHandler: ({ command }) => ({
		stdout: `${command}\n`,
		stderr: "",
		exitCode: 0,
	}),
});

const response = await fetch(`${fake.baseUrl}/v1/instances`, {
	method: "POST",
	headers: {
		authorization: `Bearer ${fake.apiKey}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({
		template: "agent37-ubuntu",
		type: "vm",
		region: "us",
		resources: { cpu: 2, memory: 4, disk: 20 },
		env: { HOBO_LEASE_ID: "lease-test" },
	}),
});
console.log(response.status);
await fake.close();
```

The fake covers:

Request JSON crosses one parser boundary and becomes the derived `ParsedCreate` or `ParsedExec` domain type before capacity, lifecycle, or execution logic can consume it. This is parse, don't validate: core fake operations accept those parsed types rather than raw DTOs plus repeated boolean checks.

- Bearer authentication on the API plane and `X-Agent37-Key` authentication on exec.
- Instance create, newest-first list, get, delete, stop, start, sleep, restart, update, resize, and fork.
- Documented instance shapes, regional restrictions, one-day wallet admission, the workspace memory ceiling, and regional `no_capacity` failures.
- Synchronous and background exec, five-minute replay by instance and exec name, 512 KiB stdout/stderr bounds, and a 1 MiB request-body bound.
- Webhook registration, list, delete, the five-registration limit, and Standard Webhooks HMAC-SHA256 status signatures.
- Zeroed usage windows, injected one-request faults with optional `Retry-After`, malformed JSON errors, and generic internal-error envelopes.

State disappears on close. Environment variables are write-only in HTTP responses and visible only to the injected exec handler. API keys and webhook secrets are generated synthetically at runtime. The fake makes no real Agent37 calls and is hand-authored from documented behavior, not provider-verified.

## Testcontainers

```ts
import { startFakeAgent37Server } from "@hobo/provider-agent37/fake/container";

const started = await startFakeAgent37Server({ requireContainer: true });
try {
	console.log(started.baseUrl);
} finally {
	await started.close();
}
```

The wrapper runs the same server on `node:24-alpine`. Docker unavailability is an error by default. `allowInProcessFallback: true` explicitly enables the in-process fallback, while `requireContainer: true` forbids it. The default tests force Docker off and exercise fallback selection and real HTTP behavior without requiring a Docker daemon.

## Contracts and validation

`data-models/agent37_fake.proto` and `data-models/agent37_fake.cue` describe fake instance, exec, webhook, usage, and error records. Valid and invalid JSON fixtures accompany the schema. `contracts/pacts/agent37_sandbox_fake.pact.json` records hand-authored consumer expectations for create, exec, usage, and authentication failures; no provider has verified them.

The HTTP adapter defines no durable command or event family, actor, event store, materialized view, projection, snapshot, or read store. Its in-memory state is intentionally ephemeral.

```sh
pnpm --filter @hobo/provider-agent37 typecheck
pnpm --filter @hobo/provider-agent37 test
pnpm --filter @hobo/provider-agent37 build
```

Reconcile `pnpm-lock.yaml` with `origin/main` before CI runs on the PR merge tree; HoBo CI Fabric installs with `--frozen-lockfile` against that merge ref.

CD never delivers to Agent37: `PROVIDER_DELIVERY_COVERAGE` in `@hobo/hobo` lists it as a refused row, like the CI runner packages, because its sandboxes only supply overflow runner capacity.
