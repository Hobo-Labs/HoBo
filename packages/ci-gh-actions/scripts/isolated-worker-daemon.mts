#!/usr/bin/env node
/** Sidecar on an operator-owned free VM: launch kubernetes/isolated-container leases against the shared relay database. */
import { parseConfiguration } from "@hobo/ci";
import { PostgresCiStore } from "@hobo/ci/postgres";
import {
	attachPostgresPoolErrorHandler,
	createCliDockerDriver,
	createCompositeIsolatedHost,
	createGithubAppTransport,
	createGithubOidcVerifier,
	createHostedRelayRuntime,
	createIsolatedContainerController,
} from "@hobo/ci-gh-actions";
import pg from "pg";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

const pool = new pg.Pool({
	connectionString: required("DATABASE_URL"),
	max: 2,
});
attachPostgresPoolErrorHandler(pool);
const store = new PostgresCiStore(pool);
const github = createGithubAppTransport({
	appId: required("HOBO_CI_GITHUB_APP_ID"),
	privateKey: required("HOBO_CI_GITHUB_APP_PRIVATE_KEY"),
});
const publicOrigin = required("HOBO_CI_PUBLIC_URL");
const workerMemoryMb = Number(process.env.HOBO_CI_WORKER_MEMORY_MB ?? "8192");
if (!Number.isInteger(workerMemoryMb) || workerMemoryMb < 512)
	throw new Error("invalid HOBO_CI_WORKER_MEMORY_MB");
const worker = createIsolatedContainerController({
	store,
	github,
	publicOrigin,
	docker: createCliDockerDriver({ env: process.env }),
	workerAccountId: required("HOBO_CI_WORKER_PROVIDER_ACCOUNT_ID"),
	workerImage: process.env.HOBO_CI_WORKER_IMAGE ?? "hobo-ci-worker:local",
	workerMemoryMb,
});
const host = createCompositeIsolatedHost({ store, worker: worker.host });
if (!host) throw new Error("worker host unavailable");
const identity = createGithubOidcVerifier(publicOrigin);
const secret = required("HOBO_CI_WEBHOOK_SECRET");
const runtime = createHostedRelayRuntime({
	store,
	github,
	identity,
	webhookSecret: secret,
	isolatedHost: host,
	denyUnisolated: true,
	control: async () => undefined,
});

async function tick() {
	await runtime.tick({ maxDeliveries: 0 });
}

const intervalMs = Number(process.env.HOBO_CI_WORKER_POLL_MS ?? "5000");
if (!Number.isFinite(intervalMs) || intervalMs < 1000)
	throw new Error("invalid HOBO_CI_WORKER_POLL_MS");
void parseConfiguration(required("HOBO_CI_CONFIG_JSON"));
console.error(
	JSON.stringify({
		event: "hobo_ci_isolated_worker_started",
		publicOrigin,
		pollMs: intervalMs,
		workerMemoryMb,
	}),
);
setInterval(() => {
	tick().catch((error) => {
		console.error(
			JSON.stringify({
				event: "hobo_ci_isolated_worker_tick_failed",
				message: error instanceof Error ? error.message : "unknown",
			}),
		);
	});
}, intervalMs);
