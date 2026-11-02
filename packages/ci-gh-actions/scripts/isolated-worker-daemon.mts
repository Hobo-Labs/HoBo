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
	waitForIsolatedWorkerDrain,
} from "@hobo/ci-gh-actions";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function log(
	event: string,
	fields: Readonly<Record<string, string | number | boolean>> = {},
) {
	console.error(JSON.stringify({ event, ...fields }));
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
const workerAccountId = required("HOBO_CI_WORKER_PROVIDER_ACCOUNT_ID");
// Concurrent job containers on this host. Size with memory: slots x HOBO_CI_WORKER_MEMORY_MB
// should stay under host RAM (jobs run NODE_OPTIONS=--max-old-space-size=3072, turbo concurrency 1).
const slots = Number(process.env.HOBO_CI_WORKER_SLOTS ?? "2");
if (!Number.isInteger(slots) || slots < 1 || slots > 8)
	throw new Error("invalid HOBO_CI_WORKER_SLOTS");
// Shared pnpm content-addressable store, bind-mounted into every job container
// (uid 1000 owns it). Empty string disables the mount.
const pnpmStore =
	process.env.HOBO_CI_PNPM_STORE_DIR ??
	join(homedir(), ".cache", "hobo-ci", "pnpm-store");
if (pnpmStore) mkdirSync(pnpmStore, { recursive: true, mode: 0o755 });
const PNPM_STORE_TARGET = "/pnpm-store";
const worker = createIsolatedContainerController({
	store,
	github,
	publicOrigin,
	docker: createCliDockerDriver({ env: process.env }),
	workerAccountId,
	workerImage: process.env.HOBO_CI_WORKER_IMAGE ?? "hobo-ci-worker:local",
	workerMemoryMb,
	slots,
	volumes: pnpmStore ? [{ source: pnpmStore, target: PNPM_STORE_TARGET }] : [],
	containerEnv: pnpmStore
		? {
				npm_config_store_dir: PNPM_STORE_TARGET,
				HOBO_CI_PNPM_STORE_MOUNTED: "1",
			}
		: {},
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

const intervalMs = Number(process.env.HOBO_CI_WORKER_POLL_MS ?? "2000");
if (!Number.isFinite(intervalMs) || intervalMs < 1000)
	throw new Error("invalid HOBO_CI_WORKER_POLL_MS");
const drainTimeoutMs = Number(
	process.env.HOBO_CI_WORKER_DRAIN_TIMEOUT_MS ?? "120000",
);
if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 1_000)
	throw new Error("invalid HOBO_CI_WORKER_DRAIN_TIMEOUT_MS");
void parseConfiguration(required("HOBO_CI_CONFIG_JSON"));

let draining = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let tickInFlight: Promise<void> | undefined;

function runTick(): Promise<void> {
	if (draining) return Promise.resolve();
	const current = (async () => {
		await runtime.tick({ maxDeliveries: 0 });
	})();
	tickInFlight = current.finally(() => {
		if (tickInFlight === current) tickInFlight = undefined;
	});
	return tickInFlight;
}

log("hobo_ci_isolated_worker_started", {
	publicOrigin,
	pollMs: intervalMs,
	workerMemoryMb,
	slots,
	pnpmStoreMounted: pnpmStore !== "",
	drainTimeoutMs,
});

pollTimer = setInterval(() => {
	void runTick().catch((error) => {
		log("hobo_ci_isolated_worker_tick_failed", {
			message: error instanceof Error ? error.message : "unknown",
		});
	});
}, intervalMs);

let shutdownOnce: Promise<void> | undefined;

async function shutdown(signal: string) {
	if (shutdownOnce) return shutdownOnce;
	shutdownOnce = (async () => {
		draining = true;
		if (pollTimer) clearInterval(pollTimer);
		await worker.discardWarm().catch(() => undefined);
		log("hobo_ci_isolated_worker_draining", { signal });
		if (tickInFlight) {
			await tickInFlight.catch(() => undefined);
		}
		const result = await waitForIsolatedWorkerDrain({
			activeLeases: () => store.activeLeases(),
			workerAccountId,
			pollMs: Math.min(intervalMs, 5_000),
			timeoutMs: drainTimeoutMs,
		});
		if (result.drained) {
			log("hobo_ci_isolated_worker_drained", { remaining: 0 });
		} else {
			log("hobo_ci_isolated_worker_drain_timeout", {
				remaining: result.remaining,
			});
		}
		await pool.end();
		process.exit(result.drained ? 0 : 1);
	})().catch((error) => {
		log("hobo_ci_isolated_worker_shutdown_failed", {
			message: error instanceof Error ? error.message : "unknown",
		});
		process.exit(1);
	});
	return shutdownOnce;
}

process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});
