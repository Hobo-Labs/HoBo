import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/** Box worker: launch isolated-container leases from a local SQLite journal (default) or a shared Postgres relay partition. */
import { toJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema, parseConfiguration } from "@hobo/ci";
import {
	attachPostgresPoolErrorHandler,
	countInFlightWorkerLeases,
	createCliDockerDriver,
	createCompositeIsolatedHost,
	createGithubAppTransport,
	createGithubJobPoller,
	createGithubOidcVerifier,
	createHostedRelayRuntime,
	createIsolatedContainerController,
	createJobDurations,
	createPollLogFilter,
	describeWaitingJobs,
	type HostedInboxStore,
	type IsolatedWorkerStore,
	isIsolatedContainerOffer,
	resolveWorkerStorePlan,
	waitForIsolatedWorkerDrain,
	workerOfferKeys,
} from "@hobo/ci-gh-actions";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function secretOrFile(name: string): string {
	const file = process.env[`${name}_FILE`];
	return file ? readFileSync(file, "utf8").trimEnd() : required(name);
}

function log(
	event: string,
	fields: Readonly<Record<string, string | number | boolean>> = {},
) {
	console.error(JSON.stringify({ event, ...fields }));
}

const plan = resolveWorkerStorePlan(process.env, homedir());
const appId = required("HOBO_CI_GITHUB_APP_ID");
const privateKey = process.env.HOBO_CI_GITHUB_APP_KEY_FILE
	? readFileSync(process.env.HOBO_CI_GITHUB_APP_KEY_FILE, "utf8")
	: secretOrFile("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
const configuration = parseConfiguration(
	process.env.HOBO_CI_CONFIG
		? readFileSync(process.env.HOBO_CI_CONFIG, "utf8")
		: required("HOBO_CI_CONFIG_JSON"),
);
const workerAccountId = required("HOBO_CI_WORKER_PROVIDER_ACCOUNT_ID");
// No ingress in pull mode, so the origin is informational (runner container env).
const publicOrigin =
	plan.admission === "pull"
		? (process.env.HOBO_CI_PUBLIC_URL ?? "http://127.0.0.1")
		: required("HOBO_CI_PUBLIC_URL");
// The secret only authenticates pushed webhooks; pull mode never verifies one.
const webhookSecret =
	plan.admission === "pull" && !process.env.HOBO_CI_WEBHOOK_SECRET
		? randomBytes(32).toString("hex")
		: required("HOBO_CI_WEBHOOK_SECRET");
const workerMemoryMb = Number(process.env.HOBO_CI_WORKER_MEMORY_MB ?? "8192");
if (!Number.isInteger(workerMemoryMb) || workerMemoryMb < 512)
	throw new Error("invalid HOBO_CI_WORKER_MEMORY_MB");
// Concurrent job containers on this host. Size with memory: slots x HOBO_CI_WORKER_MEMORY_MB
// should stay under host RAM (jobs run NODE_OPTIONS=--max-old-space-size=3072, turbo concurrency 1).
const slots = Number(process.env.HOBO_CI_WORKER_SLOTS ?? "2");
if (!Number.isInteger(slots) || slots < 1 || slots > 8)
	throw new Error("invalid HOBO_CI_WORKER_SLOTS");
// Slots that only push, workflow_dispatch and merge_group jobs may take, so a trunk job never waits
// for a pull request's job to finish. The offer's concurrency must equal the slot count.
const trunkSlots = Number(process.env.HOBO_CI_WORKER_TRUNK_SLOTS ?? "0");
if (!Number.isInteger(trunkSlots) || trunkSlots < 0 || trunkSlots >= slots)
	throw new Error("invalid HOBO_CI_WORKER_TRUNK_SLOTS");
const intervalMs = Number(process.env.HOBO_CI_WORKER_POLL_MS ?? "2000");
if (!Number.isFinite(intervalMs) || intervalMs < 1000)
	throw new Error("invalid HOBO_CI_WORKER_POLL_MS");
// A stop waits for running jobs, so the default covers a long job; the
// supervisor's own stop timeout must be longer than this.
const drainTimeoutMs = Number(
	process.env.HOBO_CI_WORKER_DRAIN_TIMEOUT_MS ?? "1800000",
);
if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 1_000)
	throw new Error("invalid HOBO_CI_WORKER_DRAIN_TIMEOUT_MS");

let store: HostedInboxStore & IsolatedWorkerStore;
let closeStore: () => Promise<void>;
if (plan.store.kind === "sqlite") {
	const { SqliteCiStore } = await import("@hobo/ci/sqlite");
	mkdirSync(dirname(plan.store.path), { recursive: true, mode: 0o700 });
	const sqlite = new SqliteCiStore(plan.store.path);
	store = sqlite;
	closeStore = async () => sqlite.close();
	// This worker owns its journal, so the operator's config file is the policy
	// source: apply it when it changed. A refused change (for example an active
	// lease pinning a provider identity) keeps the stored policy and says why.
	const current = await sqlite.configuration();
	const desired = toJsonString(ConfigurationSchema, configuration);
	if (
		!current?.configuration ||
		toJsonString(ConfigurationSchema, current.configuration) !== desired
	) {
		try {
			const applied = await sqlite.configure(
				configuration,
				current?.revision ?? 0,
				new Date().toISOString(),
			);
			log("hobo_ci_isolated_worker_configured", {
				revision: applied.revision,
			});
		} catch (error) {
			if (!current?.configuration) throw error;
			log("hobo_ci_isolated_worker_configuration_kept", {
				revision: current.revision,
				message: error instanceof Error ? error.message : "unknown",
			});
		}
	}
} else {
	const [{ PostgresCiStore }, { default: pg }] = await Promise.all([
		import("@hobo/ci/postgres"),
		import("pg"),
	]);
	const pool = new pg.Pool({
		connectionString: required(plan.store.urlEnv),
		max: 2,
	});
	attachPostgresPoolErrorHandler(pool);
	store = new PostgresCiStore(pool);
	closeStore = () => pool.end();
}

for (const account of configuration.accounts)
	for (const offer of account.offers) {
		const ours =
			isIsolatedContainerOffer(offer) &&
			offer.providerAccountId === workerAccountId;
		log("hobo_ci_isolated_worker_offer", {
			accountId: account.id,
			offerId: offer.id,
			provider: offer.provider,
			launchable: ours,
			enabled: offer.enabled,
			concurrency: offer.concurrency,
			validUntil: offer.validUntil,
			expired: Date.parse(offer.validUntil) <= Date.now(),
		});
	}

const github = createGithubAppTransport({ appId, privateKey });
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
// The poller learns job durations from the jobs lists it already reads; the
// relay admits each run's longest expected job first.
const jobDurations = createJobDurations();
const runtime = createHostedRelayRuntime({
	store,
	github,
	identity: createGithubOidcVerifier(publicOrigin),
	webhookSecret,
	isolatedHost: host,
	denyUnisolated: true,
	jobDurations,
	// With no trunk slots this is the slot count, all the host could run anyway.
	generalLeaseLimit: slots - trunkSlots,
	control: async () => undefined,
});
const poller =
	plan.admission === "pull"
		? createGithubJobPoller({
				github,
				durations: jobDurations,
				connections: async () =>
					(await store.configuration())?.configuration?.connections ?? [],
				ingest: (delivery) => runtime.ingestWebhook(delivery),
				onIngestError: (jobId, message) =>
					log("hobo_ci_isolated_worker_job_ingest_failed", { jobId, message }),
				onGithubError: (failure) =>
					log("hobo_ci_isolated_worker_github_read_failed", { ...failure }),
			})
		: undefined;
const pollWorthLogging = createPollLogFilter();

let draining = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let jobPollTimer: ReturnType<typeof setInterval> | undefined;
let tickInFlight: Promise<void> | undefined;
let jobPollInFlight: Promise<void> | undefined;

function runTick(): Promise<void> {
	if (draining) return Promise.resolve();
	const current = (async () => {
		// In push mode the hosted relay drains the shared inbox; in pull mode
		// this worker is the only consumer of its own.
		await runtime.tick({ maxDeliveries: poller ? 10 : 0 });
	})();
	tickInFlight = current.finally(() => {
		if (tickInFlight === current) tickInFlight = undefined;
	});
	return tickInFlight;
}

function runJobPoll(): void {
	if (draining || !poller || jobPollInFlight) return;
	jobPollInFlight = poller
		.poll()
		.then((summary) => {
			if (!pollWorthLogging(summary, Date.now())) return;
			const { waiting, ...counts } = summary;
			log("hobo_ci_isolated_worker_jobs_polled", {
				...counts,
				waitingJobs: waiting.length,
				waiting: describeWaitingJobs(waiting),
			});
		})
		.catch((error) => {
			log("hobo_ci_isolated_worker_job_poll_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
		})
		.finally(() => {
			jobPollInFlight = undefined;
		});
}

log("hobo_ci_isolated_worker_started", {
	store: plan.store.kind,
	admission: plan.admission,
	publicOrigin,
	pollMs: intervalMs,
	jobPollMs: plan.jobPollMs,
	workerMemoryMb,
	slots,
	trunkSlots,
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
if (poller) {
	runJobPoll();
	jobPollTimer = setInterval(runJobPoll, plan.jobPollMs);
}

let shutdownOnce: Promise<void> | undefined;

async function shutdown(signal: string) {
	if (shutdownOnce) return shutdownOnce;
	shutdownOnce = (async () => {
		draining = true;
		if (pollTimer) clearInterval(pollTimer);
		if (jobPollTimer) clearInterval(jobPollTimer);
		await worker.discardWarm().catch(() => undefined);
		log("hobo_ci_isolated_worker_draining", { signal });
		await jobPollInFlight;
		if (tickInFlight) {
			await tickInFlight.catch(() => undefined);
		}
		// Running jobs count: a lease leaves `running` only when a reconcile sees
		// its runner exit, so each check is a tick that admits nothing new.
		const inFlight = async () =>
			countInFlightWorkerLeases(
				await store.activeLeases(),
				workerOfferKeys(
					(await store.configuration())?.configuration,
					workerAccountId,
				),
			);
		log("hobo_ci_isolated_worker_drain_started", {
			inFlight: await inFlight(),
			timeoutMs: drainTimeoutMs,
		});
		let reported = -1;
		const result = await waitForIsolatedWorkerDrain({
			inFlight,
			reconcile: () => runtime.tick({ admit: false }),
			pollMs: Math.min(intervalMs, 5_000),
			timeoutMs: drainTimeoutMs,
			onWaiting: (remaining) => {
				if (remaining === reported) return;
				reported = remaining;
				log("hobo_ci_isolated_worker_drain_waiting", { remaining });
			},
		});
		if (result.drained) {
			log("hobo_ci_isolated_worker_drained", { remaining: 0 });
		} else {
			log("hobo_ci_isolated_worker_drain_timeout", {
				remaining: result.remaining,
			});
		}
		await closeStore();
		process.exit(result.drained ? 0 : 1);
	})().catch((error) => {
		log("hobo_ci_isolated_worker_shutdown_failed", {
			message: error instanceof Error ? error.message : "unknown",
		});
		process.exit(1);
	});
	return shutdownOnce;
}

// `on`, not `once`: a supervisor that signals the whole process group (and a
// parent that forwards the same signal) sends it twice, and a second signal
// with no listener would kill the drain.
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, () => {
		void shutdown(signal);
	});
