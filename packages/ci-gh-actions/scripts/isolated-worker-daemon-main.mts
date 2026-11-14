import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statfsSync,
	statSync,
} from "node:fs";
import { cpus, homedir, hostname, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
/** Box worker: launch isolated-container leases from its own SQLite journal. */
import { toJsonString } from "@bufbuild/protobuf";
import {
	ConfigurationSchema,
	type Lease,
	memoryAdmitHeadroom,
	parseConfiguration,
} from "@hobo/ci";
import {
	awaitWorkerBackgroundDrainIdle,
	boxGitMirrorPath,
	boxLeaseIdsOf,
	ciEventSinkFromEnv,
	controllerDigestFromEnv,
	countLiveBoxContainers,
	createBoxGitMirror,
	createCiEventEmitter,
	createCliDockerDriver,
	createCompositeIsolatedHost,
	createContainerStallGuard,
	createDepsImageEnsurer,
	createGithubAppTransport,
	createGithubJobPoller,
	createGithubOidcVerifier,
	createHeldJobPruner,
	createHostedRelayRuntime,
	createHostHealthMonitor,
	createIsolatedContainerController,
	createJobDurations,
	createMemoryPeaks,
	createMergeQueuePositionCache,
	createNodeWorkerStorageFileSystem,
	createPnpmStoreMaintenance,
	createPollIngestCoalesce,
	createPollLogFilter,
	createRelayTrace,
	createRetiredWorkDirectorySweeper,
	createRoutingHolds,
	createRoutingSlipIssuer,
	createRoutingStallWatch,
	createRunnerPickupMemory,
	createStoragePeaks,
	createWorkerMemoryAdmission,
	createWorkerStorageAdmission,
	DEFAULT_DRAIN_BACKGROUND_BOUND_MS,
	DEPS_BUILD_ADMISSION_ID,
	type DepsImageProcessRequest,
	decideRoutingSlipClasses,
	defaultDepsRoot,
	defaultGitMirrorFallbackRoot,
	defaultGitMirrorPreferredRoot,
	describeWaitingJobs,
	evaluateRoutingSlip,
	generalLeaseIdsFor,
	type HostedInboxStore,
	hostPressureBlocksAdmission,
	hostResourcePressureLogFields,
	type IsolatedWorkerStore,
	isIsolatedContainerOffer,
	localWorkerFreeSlots,
	mainShardParallelLaunchCapacity,
	mergeHeldPruneWitness,
	parseWorkerStopMode,
	type RepositoryRunnersView,
	ROUTING_SLIP_SAMPLE_MS,
	type RunnerJobsSeen,
	readAvailableMemoryMb,
	readBoxMemberSettings,
	readBoxRoutingPolicy,
	readHostHealthSample,
	readHostMemory,
	readHostResourcePressureSample,
	readRepositoryRunners,
	refreshHeldPruneWitnessFromStore,
	relayTraceSinkFromEnv,
	releaseEntryPath,
	resolvedStorageReserve,
	resolveGitMirrorRoot,
	resolveWorkerMemoryConfig,
	resolveWorkerSlotConfig,
	resolveWorkerStorePlan,
	retireRepositoryVariables,
	routingEnvironmentNamesSet,
	routingSlipLeader,
	runnerRoutingLabels,
	runningAsControllerRelease,
	singleFlight,
	stopIsolatedWorker,
	storageReserveForClass,
	storageReserveForDepsBuild,
	storageReserveForJob,
	traceGithubTransport,
	withGithubReadCache,
	workerAdmissionPaused,
	workerHostFiles,
} from "@hobo/ci-gh-actions";
import type { FleetView, MemberId } from "@hobo/fleet";
import { z } from "zod";
import { ciRunnerImageVersion } from "../../../scripts/lib/ci-runner-contract.mts";
import { depsKeyForRoot } from "../../../scripts/lib/deps-key.mts";
import { loadWorkerBudgetAdapter } from "./worker-budget-adapter.mts";

const exec = promisify(execFile);

/** The member name a host name gives (a §7.2 short name). */
function memberNameOf(host: string): string {
	const name = host
		.toLowerCase()
		.replace(/[^a-z0-9_-]/gu, "-")
		.replace(/^[^a-z0-9]+/u, "")
		.slice(0, 63);
	return name === "" ? "box" : name;
}

/** This package's version: the agent version the box's fleet member reports. */
function ciGhActionsVersion(): string {
	const manifest = z
		.object({ version: z.string().min(1) })
		.safeParse(
			JSON.parse(
				readFileSync(new URL("../package.json", import.meta.url), "utf8"),
			),
		);
	return manifest.success ? manifest.data.version : "0.0.0";
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function inodeReserve(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined) return fallback;
	if (!/^\d+$/u.test(value))
		throw new Error(`invalid ${name}: expected digits only`);
	const reserve = Number(value);
	if (!Number.isSafeInteger(reserve))
		throw new Error(`invalid ${name}: exceeds safe integer range`);
	return reserve;
}

/** Free megabytes on the filesystem holding `path`; undefined when it cannot be read. */
function freeDiskMbOf(path: string): number | undefined {
	try {
		const stats = statfsSync(path);
		const megabytes = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
		return Number.isSafeInteger(megabytes) && megabytes >= 0
			? megabytes
			: undefined;
	} catch {
		return undefined;
	}
}

function storageLeases(leases: readonly Lease[]) {
	return leases.map((lease) => ({
		id: lease.id,
		sandboxName: lease.sandboxName,
		jobId: String(lease.actualJobId > 0 ? lease.actualJobId : lease.jobId),
	}));
}

function secretOrFile(name: string): string {
	const file = process.env[`${name}_FILE`];
	return file ? readFileSync(file, "utf8").trimEnd() : required(name);
}

// Off unless OTEL_EXPORTER_OTLP_ENDPOINT (or the traces-specific variable) or
// HOBO_CI_TRACE_FILE is set. Every log event below is also a span, and so is
// every GitHub call that changes something: see src/relay-trace.ts.
const traceExport = relayTraceSinkFromEnv(process.env);
const relayTrace = createRelayTrace({
	sink: traceExport.sink,
	resource: {
		"service.name": process.env.OTEL_SERVICE_NAME || "hobo-ci-worker",
		"service.instance.id": hostname(),
	},
	// Written directly: sending it through log() would trace the trace.
	onProblem: (problem) =>
		console.error(
			JSON.stringify({ event: "hobo_ci_trace_export_problem", ...problem }),
		),
});

// CloudEvents for the infrastructure facts among those log events, delivered
// to HOBO_CI_EVENTS_URL when it is set: see src/cloud-events.ts.
const eventExport = ciEventSinkFromEnv(process.env);
const ciEvents = createCiEventEmitter({
	source: {
		tenant: process.env.HOBO_CI_EVENTS_TENANT || "hobo-ci",
		// One ordered stream per start of this worker on this host.
		streamId: `ci-worker/${hostname()}/${randomBytes(4).toString("hex")}`,
		actorId: process.env.OTEL_SERVICE_NAME || "hobo-ci-worker",
	},
	sink: eventExport.sink,
	onProblem: (problem) =>
		console.error(
			JSON.stringify({ event: "hobo_ci_events_export_problem", ...problem }),
		),
});

/** Sends what is queued, without letting a dead endpoint hold up the exit. */
async function closeTrace(): Promise<void> {
	await Promise.race([
		Promise.all([relayTrace.close(), ciEvents.close()]),
		new Promise((resolve) => setTimeout(resolve, 3000).unref()),
	]);
}

function log(
	event: string,
	fields: Readonly<Record<string, string | number | boolean>> = {},
) {
	console.error(JSON.stringify({ event, ...fields }));
	relayTrace.event(event, fields);
	ciEvents.emit(event, fields);
}

async function output(
	command: string,
	args: readonly string[],
	cwd: string,
	timeout: number,
): Promise<string> {
	const { stdout } = await exec(command, args, {
		cwd,
		env: process.env,
		timeout,
		maxBuffer: 1024 * 1024,
	});
	return stdout;
}

function runDepsProcess(request: DepsImageProcessRequest): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env: request.env,
			stdio: ["ignore", "inherit", "inherit"],
			timeout: 45 * 60_000,
			killSignal: "SIGKILL",
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`deps image command failed (${code ?? signal ?? "unknown"})`,
					),
				);
		});
	});
}

// Routing policy is committed configuration (ADR-0181, decision 4): the
// `runnerRouting` block of `.hobo/ci.json` in this daemon's own checkout. No
// environment variable chooses a label, a tier, a pool, a slot split, a limit
// or a reporter here (R2).
const checkoutRoot = defaultDepsRoot(import.meta.url);
const routingPolicy = readBoxRoutingPolicy(checkoutRoot);
const routing = routingPolicy.policy;
// The commit this daemon runs, for its start log and every slip it writes.
const daemonCommit = await exec("git", ["rev-parse", "HEAD"], {
	cwd: checkoutRoot,
})
	.then(({ stdout }) => stdout.trim())
	.catch(() => "")
	.then((sha) => (/^[0-9a-f]{40}$/u.test(sha) ? sha : undefined));
const plan = resolveWorkerStorePlan(
	process.env,
	homedir(),
	routing.box.jobAdmission,
);
const appId = required("HOBO_CI_GITHUB_APP_ID");
const privateKey = process.env.HOBO_CI_GITHUB_APP_KEY_FILE
	? readFileSync(process.env.HOBO_CI_GITHUB_APP_KEY_FILE, "utf8")
	: secretOrFile("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
// A worker's configuration is its own file or variable.
const localConfiguration = process.env.HOBO_CI_CONFIG
	? readFileSync(process.env.HOBO_CI_CONFIG, "utf8")
	: process.env.HOBO_CI_CONFIG_JSON;
const configuration = parseConfiguration(
	localConfiguration ?? required("HOBO_CI_CONFIG_JSON"),
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
// Slots bound container count only. Memory admission also requires active + reserved
// requests (including a warm container) to fit the host/cgroup budget, and reserves
// the heavy class for trunk. While a trunk lease is active, prCapWithTrunk limits
// new non-trunk reservations; the cap disappears with the trunk lease. The job heap
// is per process, not a container budget: native code, pnpm/turbo children and page
// cache must fit in the class too.
// One slot is reserved for hobo-trunk jobs by default when there are at least two.
// Shared-label jobs never borrow it unless runnerRouting.box.trunkLend is 1.
// The offer's concurrency must equal the slot count, so the box's own offers
// take it from the committed policy, whatever the configuration says.
const { slots, trunkSlots, mergeGroupLeases, prCapWithTrunk } =
	resolveWorkerSlotConfig(routing.box);
for (const account of configuration.accounts)
	for (const offer of account.offers)
		if (
			isIsolatedContainerOffer(offer) &&
			offer.providerAccountId === workerAccountId &&
			offer.concurrency !== slots
		) {
			log("hobo_ci_isolated_worker_offer_concurrency", {
				accountId: account.id,
				offerId: offer.id,
				configured: offer.concurrency,
				slots,
			});
			offer.concurrency = slots;
		}
const workRoot =
	process.env.HOBO_CI_WORKER_WORK_ROOT ??
	join(
		process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
		"hobo-ci",
		"work",
	);
mkdirSync(workRoot, { recursive: true, mode: 0o755 });
const memoryPeaks = createMemoryPeaks({
	path: join(workRoot, "memory-peaks.json"),
	log,
});
const hostMemorySample = readHostMemory();
const memoryConfig = resolveWorkerMemoryConfig(
	process.env,
	{
		...hostMemorySample,
		trunkSlots,
	},
	memoryPeaks.history,
);
const hostMemMb = Math.min(
	hostMemorySample.totalMemoryMb,
	hostMemorySample.cgroupMemoryLimitMb ?? Number.MAX_SAFE_INTEGER,
);
const workerMemoryMb = memoryConfig.classes.heavy;
const capacityVolatilityMb = routing.box.capacityVolatilityMb;
let lastHostPressureLogAt = 0;
const hostPressureSample = () => readHostResourcePressureSample(Date.now());
const containerStallGuard = createContainerStallGuard({
	read: hostPressureSample,
});
// A started job's reservation stays counted against host memory this long.
const memoryRampMs = Number(
	process.env.HOBO_CI_WORKER_MEMORY_RAMP_MS ?? "120000",
);
if (!Number.isInteger(memoryRampMs) || memoryRampMs < 0)
	throw new Error("invalid HOBO_CI_WORKER_MEMORY_RAMP_MS");
// Free memory has to have lasted this long before a job is admitted on it.
const memoryLowWaterMs = Number(
	process.env.HOBO_CI_WORKER_MEMORY_LOW_WATER_MS ?? "60000",
);
if (!Number.isInteger(memoryLowWaterMs) || memoryLowWaterMs < 0)
	throw new Error("invalid HOBO_CI_WORKER_MEMORY_LOW_WATER_MS");
const memoryAdmission = createWorkerMemoryAdmission(memoryConfig, {
	log,
	prCapWithTrunk,
	availableMemoryMb: readAvailableMemoryMb,
	volatilityMb: capacityVolatilityMb,
	hostPressure: hostPressureSample,
	hostCores: () => cpus().length,
	memoryRampMs,
	availableWindowMs: memoryLowWaterMs,
});
const lendTrunkSlots = routing.box.trunkLend === 1;
const intervalMs = Number(process.env.HOBO_CI_WORKER_POLL_MS ?? "2000");
if (!Number.isFinite(intervalMs) || intervalMs < 1000)
	throw new Error("invalid HOBO_CI_WORKER_POLL_MS");
const inboxDeliveryTimeoutMs = Number(
	process.env.HOBO_CI_INBOX_DELIVERY_TIMEOUT_MS ?? "5000",
);
if (
	!Number.isFinite(inboxDeliveryTimeoutMs) ||
	inboxDeliveryTimeoutMs < 500 ||
	!Number.isInteger(inboxDeliveryTimeoutMs)
)
	throw new Error("invalid HOBO_CI_INBOX_DELIVERY_TIMEOUT_MS");
const inboxDrainBudgetMs = Number(
	process.env.HOBO_CI_INBOX_DRAIN_BUDGET_MS ?? "30000",
);
if (
	!Number.isFinite(inboxDrainBudgetMs) ||
	inboxDrainBudgetMs < 1_000 ||
	!Number.isInteger(inboxDrainBudgetMs)
)
	throw new Error("invalid HOBO_CI_INBOX_DRAIN_BUDGET_MS");
const drainTimeoutMs = Number(
	process.env.HOBO_CI_WORKER_DRAIN_TIMEOUT_MS ?? "1800000",
);
if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 1_000)
	throw new Error("invalid HOBO_CI_WORKER_DRAIN_TIMEOUT_MS");
const noContainerDrainMaxMs = Number(
	process.env.HOBO_CI_WORKER_DRAIN_NO_CONTAINER_MS ?? "60000",
);
if (!Number.isFinite(noContainerDrainMaxMs) || noContainerDrainMaxMs < 1_000)
	throw new Error("invalid HOBO_CI_WORKER_DRAIN_NO_CONTAINER_MS");
const stopMode = parseWorkerStopMode(process.env.HOBO_CI_WORKER_STOP_MODE);
const depsPollMs = Number(process.env.HOBO_CI_DEPS_POLL_MS ?? "300000");
if (!Number.isFinite(depsPollMs) || depsPollMs < 1_000)
	throw new Error("invalid HOBO_CI_DEPS_POLL_MS");
const depsBuildMemoryMb = Number(
	process.env.HOBO_CI_DEPS_BUILD_MEMORY_MB ?? "4096",
);
if (!Number.isInteger(depsBuildMemoryMb) || depsBuildMemoryMb < 512)
	throw new Error("invalid HOBO_CI_DEPS_BUILD_MEMORY_MB");
const configuredGcIntervalMs = Number(
	process.env.HOBO_CI_WORKER_GC_MS ?? String(5 * 60_000),
);
if (!Number.isFinite(configuredGcIntervalMs) || configuredGcIntervalMs < 60_000)
	throw new Error("invalid HOBO_CI_WORKER_GC_MS");
const gcIntervalMs = Math.min(configuredGcIntervalMs, 5 * 60_000);
const pnpmStorePruneIntervalMs = Number(
	process.env.HOBO_CI_PNPM_STORE_PRUNE_INTERVAL_MS ?? "21600000",
);
if (
	!Number.isSafeInteger(pnpmStorePruneIntervalMs) ||
	pnpmStorePruneIntervalMs < 60_000
)
	throw new Error("invalid HOBO_CI_PNPM_STORE_PRUNE_INTERVAL_MS");

let store: HostedInboxStore & IsolatedWorkerStore;
let closeStore: () => Promise<void> = async () => {};
// Where this worker meets its host's CD agent (`hobo deploy agent run`): the
// agent closes admission with a marker file here (src/runner-host-worker-jobs.ts).
// The mesh advert it used to read is gone; the agent reads this box's fleet
// observation, whose agent version is the controller release below.
const runnerHostFiles = workerHostFiles(plan.store.path);
const admissionPausedByAgent = () => workerAdmissionPaused(runnerHostFiles);
// The release this worker runs, when its daemon's supervisor started it at
// one (runner-controller-process.ts): the fleet member reports it as its
// agent version.
const controllerDigest = controllerDigestFromEnv(process.env);
const budgetAdapter = await loadWorkerBudgetAdapter(
	process.env.HOBO_CI_TRUSTED_BUDGET_ADAPTER,
	plan.store.kind,
);
try {
	const { SqliteCiStore } = await import("@hobo/ci/sqlite");
	mkdirSync(dirname(plan.store.path), { recursive: true, mode: 0o700 });
	const sqlite = new SqliteCiStore(
		plan.store.path,
		budgetAdapter ? { sharedBudget: budgetAdapter.hooks } : {},
	);
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
} catch (error) {
	try {
		await closeStore();
	} finally {
		await budgetAdapter?.close?.();
	}
	throw error;
}
const closeUnderlyingStore = closeStore;
let storeClosed = false;
closeStore = async () => {
	if (storeClosed) return;
	storeClosed = true;
	try {
		await closeUnderlyingStore();
	} finally {
		await budgetAdapter?.close?.();
	}
};

try {
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

	log("hobo_ci_trace_export", {
		enabled: relayTrace.enabled,
		endpoint: traceExport.targets.endpoint,
		file: traceExport.targets.file,
	});
	log("hobo_ci_events_export", {
		enabled: ciEvents.enabled,
		target: eventExport.target,
	});
	const github = traceGithubTransport(
		withGithubReadCache(createGithubAppTransport({ appId, privateKey })),
		relayTrace,
	);
	// The poller learns job durations from the jobs lists it already reads; the
	// relay admits each run's longest expected job first.
	const jobDurations = createJobDurations();
	const workerRunnerLabels: Parameters<typeof generalLeaseIdsFor>[2] =
		new Map();
	// Shared pnpm content-addressable store, bind-mounted into every job container
	// (uid 1000 owns it). Empty string disables the mount.
	const pnpmStore =
		process.env.HOBO_CI_PNPM_STORE_DIR ??
		join(homedir(), ".cache", "hobo-ci", "pnpm-store");
	if (pnpmStore) mkdirSync(pnpmStore, { recursive: true, mode: 0o755 });
	const PNPM_STORE_TARGET = "/pnpm-store";
	const depsRepository =
		process.env.HOBO_CI_DEPS_REPOSITORY ?? "Hobo-Labs/HoBo";
	const depsImage = process.env.HOBO_CI_DEPS_IMAGE ?? "hobo-ci-deps:local";
	// A release staged by digest has no checkout to find the repository from.
	const depsRoot = releaseEntryPath({
		env: process.env,
		name: "HOBO_CI_DEPS_ROOT",
		release: runningAsControllerRelease(),
		fallback: () => defaultDepsRoot(import.meta.url),
	});
	if (pnpmStore && statSync(pnpmStore).dev !== statSync(workRoot).dev)
		throw new Error(
			"pnpm store and work root must share a filesystem for hardlinks",
		);
	// The host Docker socket only while this box's fleet allows it (S1, §6.11).
	let fleetHostDocker = () => false;
	const docker = createCliDockerDriver({
		env: process.env,
		log,
		hostDocker: () => fleetHostDocker(),
	});
	const workFs = createNodeWorkerStorageFileSystem();
	const retiredSweep = createRetiredWorkDirectorySweeper({
		fs: workFs,
		workRoot,
		log,
	});
	retiredSweep.trigger();
	const dockerDataRoot = await docker.dataRoot();
	const storagePeaksPath = join(workRoot, "storage-peaks.json");
	const storagePeaks = createStoragePeaks({ path: storagePeaksPath, log });
	const storageAdmission = createWorkerStorageAdmission({
		dockerDataRoot,
		workRoot,
		fs: workFs,
		docker,
		activeLeases: async () => storageLeases(await store.activeLeases()),
		scheduleRetiredSweep: retiredSweep.trigger,
		drainRetiredSweep: retiredSweep.drain,
		defaultJobReserve: storageReserveForClass("standard"),
		pnpmStore: pnpmStore
			? createPnpmStoreMaintenance({
					path: pnpmStore,
					env: process.env,
					minIntervalMs: pnpmStorePruneIntervalMs,
				})
			: undefined,
		pnpmStoreIdle: async () => {
			if (!pnpmStore) return false;
			try {
				if ((await store.activeLeases()).length !== 0) return false;
				return (await docker.containersUsingVolume(pnpmStore)) === 0;
			} catch {
				return false;
			}
		},
		builderCacheCap:
			process.env.HOBO_CI_WORKER_BUILDER_CACHE_CAP ??
			process.env.HOBO_CI_WORKER_BUILDER_KEEP_STORAGE ??
			"4GB",
		jobInodes: {
			workRoot: inodeReserve("HOBO_CI_WORKER_WORKDIR_INODES", 200_000),
			dockerDataRoot: inodeReserve("HOBO_CI_WORKER_CONTAINER_INODES", 170_000),
		},
		log,
	});
	const storageJobReserve = (jobName: string) =>
		resolvedStorageReserve(
			jobName,
			storagePeaks.history[jobName],
			storageReserveForJob(jobName),
		);
	const listWorkerContainers = () => {
		if (docker.listWorkerContainers) return docker.listWorkerContainers();
		if (!docker.list) throw new Error("docker driver missing list");
		return docker.list("hobo.ci/isolated=1");
	};
	try {
		for (const container of await listWorkerContainers()) {
			if (container.state !== "running" || !container.name.startsWith("hobo-"))
				continue;
			log("hobo_ci_worker_adopt_running_container", {
				name: container.name,
				containerId: container.containerId,
			});
		}
	} catch (error) {
		log("hobo_ci_worker_adopt_failed", {
			message: error instanceof Error ? error.message : "unknown",
		});
	}
	const hostHealthPaths = [dockerDataRoot, workRoot];
	// Collection cannot start inside the tick that noticed the pressure; it is
	// asked for here and started when that tick ends.
	let gcRequested = false;
	const hostHealth = createHostHealthMonitor({
		sample: () => {
			const availableMb = readAvailableMemoryMb();
			return readHostHealthSample({
				loadAverage1m: loadavg()[0] ?? 0,
				// Load average is the whole host's, so the divisor is too: not the
				// daemon's own cgroup share.
				cpus: cpus().length,
				memory:
					availableMb === undefined
						? undefined
						: { availableMb, totalMb: hostMemorySample.totalMemoryMb },
				paths: hostHealthPaths,
				statfs: workFs.statfs,
			});
		},
		log,
		// Collect now, not at the next interval: a job is about to need the room.
		onPressure: (verdict) => {
			if (
				verdict.state === "pressured" ||
				verdict.state === "critical" ||
				verdict.reasons.some((reason) => reason.startsWith("storage"))
			)
				gcRequested = true;
		},
	});
	await storageAdmission.reap();
	const jobPickupMetadata = new Map<
		string,
		{ event?: string; jobCreatedAt?: string }
	>();
	const preferredGitMirrorRoot = defaultGitMirrorPreferredRoot();
	const gitMirrorRoot = resolveGitMirrorRoot(
		preferredGitMirrorRoot,
		defaultGitMirrorFallbackRoot(),
	);
	if (gitMirrorRoot !== preferredGitMirrorRoot) {
		log("hobo_ci_git_mirror_root_fallback", {
			preferred: preferredGitMirrorRoot,
			root: gitMirrorRoot,
		});
	}
	const gitMirrorEnabled = process.env.HOBO_CI_GIT_MIRROR !== "0";
	const gitMirrors = new Map<string, ReturnType<typeof createBoxGitMirror>>();
	function gitMirrorFor(repository: string) {
		const key = repository.toLowerCase();
		const existing = gitMirrors.get(key);
		if (existing) return existing;
		const created = createBoxGitMirror({ root: gitMirrorRoot, repository });
		gitMirrors.set(key, created);
		return created;
	}
	const containerEnv: Record<string, string> = {};
	const memoryPeaksPath = join(workRoot, "memory-peaks.json");
	const memoryPeaksTarget = "/run/hobo-ci/memory-peaks.json";
	if (existsSync(memoryPeaksPath)) {
		containerEnv.HOBO_CI_MEMORY_PEAKS_PATH = memoryPeaksTarget;
	}
	if (pnpmStore) {
		containerEnv.npm_config_store_dir = PNPM_STORE_TARGET;
		containerEnv.npm_config_package_import_method = "hardlink";
		containerEnv.HOBO_CI_PNPM_STORE_MOUNTED = "1";
	}
	if (gitMirrorEnabled) {
		containerEnv.HOBO_CI_GIT_MIRROR_ROOT = gitMirrorRoot;
	}
	const worker = createIsolatedContainerController({
		store,
		github,
		onStorageGrantRelease: (jobId) => storageAdmission.release(String(jobId)),
		publicOrigin,
		docker,
		workerAccountId,
		workerImage: process.env.HOBO_CI_WORKER_IMAGE ?? "hobo-ci-worker:local",
		depsRepository,
		depsImage,
		workerMemoryMb,
		prewarmMemoryMb: memoryConfig.classes.standard,
		memoryClasses: memoryConfig.classes,
		memoryPeaks,
		storagePeaks,
		memoryAdmission,
		generalLeaseIds: (activeLeases) =>
			generalLeaseIdsFor(activeLeases, github, workerRunnerLabels),
		jobPickupMetadata,
		gitMirror: gitMirrorEnabled
			? {
					pathFor: (repository) => {
						try {
							return boxGitMirrorPath(gitMirrorRoot, repository);
						} catch {
							return undefined;
						}
					},
					ensure: (repository, sha) => gitMirrorFor(repository).ensure(sha),
				}
			: undefined,
		headShaFor: async (lease): Promise<string | undefined> =>
			runtime.admissionOrder.headSha({
				installationId: lease.installationId,
				repository: lease.repository,
				runId: lease.originalRunId,
				jobId: lease.jobId,
			}),
		log,
		slots,
		volumes: [
			...(pnpmStore ? [{ source: pnpmStore, target: PNPM_STORE_TARGET }] : []),
			...(existsSync(memoryPeaksPath)
				? [
						{
							source: memoryPeaksPath,
							target: memoryPeaksTarget,
							readonly: true,
						},
					]
				: []),
		],
		containerEnv,
		workRoot,
		workFs,
		storageAdmission,
		scheduleRetiredSweep: retiredSweep.trigger,
		containerStallGuard,
		noContainerDrainMaxMs,
	});
	const firstReconciliation = await worker.reconcileLeases();
	let liveLaunchSlotsInUse = countLiveBoxContainers(await store.activeLeases());
	let drainJobInFlight = firstReconciliation.drainJobInFlight;
	let inUseWorkerMemoryMb = firstReconciliation.inUseMemoryMb;
	await worker.reconcileOrphanJobs();
	await worker.reconcileStallRecoveries();
	let depsImageEnsurer: ReturnType<typeof createDepsImageEnsurer> | undefined;
	let depsImageWorkRunning = false;
	let warmContainersStarting = 0;
	if (depsImage && depsRepository.toLowerCase() === "hobo-labs/hobo") {
		depsImageEnsurer = createDepsImageEnsurer({
			root: depsRoot,
			repository: depsRepository,
			buildMemoryMb: depsBuildMemoryMb,
			git: {
				defaultBranchHead: async (root) => {
					const head = (
						await output("git", ["-C", root, "rev-parse", "HEAD"], root, 30_000)
					).trim();
					if (!/^[0-9a-f]{40}$/u.test(head))
						throw new Error("default branch head unavailable");
					return head;
				},
			},
			fs: {
				depsKey: async (root, toolchain) =>
					depsKeyForRoot(
						root,
						`linux/${process.arch === "x64" ? "amd64" : process.arch}`,
						toolchain,
					),
			},
			docker: {
				toolchain: async (root) => {
					const computed = ciRunnerImageVersion(root);
					const computedExists = await output(
						"docker",
						["image", "inspect", `hobo-ci-worker:${computed}`],
						root,
						30_000,
					).then(
						() => true,
						() => false,
					);
					if (computedExists) return computed;
					if (!docker.inspectImage)
						throw new Error("docker image inspection unavailable");
					const worker = await docker.inspectImage("hobo-ci-worker:local");
					const toolchain = worker.repoTags
						.map((tag) => tag.match(/^hobo-ci-worker:(v[0-9a-f]{12})$/)?.[1])
						.find((tag) => tag !== undefined);
					if (!toolchain)
						throw new Error("local worker toolchain tag unavailable");
					return toolchain;
				},
				imageExists: (image) =>
					output("docker", ["image", "inspect", image], depsRoot, 30_000).then(
						() => true,
						() => false,
					),
				pull: async (image) => {
					await output("docker", ["pull", image], depsRoot, 45 * 60_000);
				},
				tag: async (source, target) => {
					await output("docker", ["tag", source, target], depsRoot, 30_000);
				},
			},
			processes: { run: runDepsProcess },
			idleForBuild: async () => {
				try {
					return (await store.activeLeases()).length === 0;
				} catch {
					return false;
				}
			},
			// The grant is refused when the build's reserve does not fit.
			onBuildSlot: {
				acquire: async () =>
					storageAdmission.admit(
						storageLeases(await store.activeLeases()),
						DEPS_BUILD_ADMISSION_ID,
						storageReserveForDepsBuild(),
					),
				release: () => storageAdmission.release(DEPS_BUILD_ADMISSION_ID),
			},
			onEvent: ({ event, ...fields }) => {
				// The box's own deps-image work: while it runs the box is not idle.
				if (event === "hobo_ci_deps_image_ensure_started")
					depsImageWorkRunning = true;
				else if (
					event === "hobo_ci_deps_image_ensure" ||
					event === "hobo_ci_deps_image_ensure_failed"
				)
					depsImageWorkRunning = false;
				log(event, fields);
			},
		});
	}
	const host = createCompositeIsolatedHost({ store, worker: worker.host });
	if (!host) throw new Error("worker host unavailable");
	let workerReconcileMs = 0;
	const mergeQueueBranch = process.env.HOBO_CI_MERGE_QUEUE_BRANCH ?? "main";
	const mergeQueueCache = createMergeQueuePositionCache({
		github,
		branch: mergeQueueBranch,
		connections: async () =>
			(await store.configuration())?.configuration?.connections ?? [],
	});
	const localFleetCapacitySnapshot = async () => {
		const active = await store.activeLeases();
		const hoboFreeSlots = localWorkerFreeSlots(slots, active);
		const capacity = await fleetMember?.daemon.fleetCapacity();
		return capacity === undefined
			? { hoboFreeSlots }
			: { hoboFreeSlots, fleetFreeSlots: capacity.freeSlots };
	};
	const headroomFleetDeferMs = routing.box.trunkHeadroomFleetDeferMs;
	const unlaunchedReserveMs = Number(
		process.env.HOBO_CI_UNLAUNCHED_RESERVE_MS ?? "25000",
	);
	if (
		!Number.isFinite(unlaunchedReserveMs) ||
		unlaunchedReserveMs < 0 ||
		!Number.isInteger(unlaunchedReserveMs)
	)
		throw new Error("invalid HOBO_CI_UNLAUNCHED_RESERVE_MS");
	const unlaunchedBacklogMinAgeMs = Number(
		process.env.HOBO_CI_UNLAUNCHED_BACKLOG_MIN_AGE_MS ??
			String(unlaunchedReserveMs),
	);
	if (
		!Number.isFinite(unlaunchedBacklogMinAgeMs) ||
		unlaunchedBacklogMinAgeMs < 0 ||
		!Number.isInteger(unlaunchedBacklogMinAgeMs)
	)
		throw new Error("invalid HOBO_CI_UNLAUNCHED_BACKLOG_MIN_AGE_MS");
	const unlaunchedReReserveCooldownMs = Number(
		process.env.HOBO_CI_UNLAUNCHED_RE_RESERVE_COOLDOWN_MS ?? "30000",
	);
	if (
		!Number.isFinite(unlaunchedReReserveCooldownMs) ||
		unlaunchedReReserveCooldownMs < 0 ||
		!Number.isInteger(unlaunchedReReserveCooldownMs)
	)
		throw new Error("invalid HOBO_CI_UNLAUNCHED_RE_RESERVE_COOLDOWN_MS");
	// Set when shutdown starts, before the fleet agent drains.
	let fleetMemberDraining = false;
	let fleetMember:
		| Readonly<{
				daemon: Readonly<{
					fleetCapacity(): Promise<{ freeSlots: number } | undefined>;
					fleetView(): Promise<FleetView | undefined>;
					memberId(): MemberId | undefined;
					hostDocker(): boolean;
					refreshFleet(): Promise<void>;
					agent: Readonly<{
						start(): Promise<void>;
						drain(): Promise<void>;
						stop(): Promise<void>;
					}>;
				}>;
				timer: ReturnType<typeof setInterval>;
		  }>
		| undefined;
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
		mergeGroupLeaseLimit: mergeGroupLeases,
		jobPickupMetadata,
		lendTrunkSlots,
		trunkSlots,
		memoryAdmission,
		storageAdmission,
		storageJobReserve,
		mergeQueuePositions: () => mergeQueueCache.snapshot(),
		headroomFleetDeferMs,
		unlaunchedReservationRelease: {
			boundMs: unlaunchedReserveMs,
			backlogMinAgeMs: unlaunchedBacklogMinAgeMs,
			reReserveCooldownMs: unlaunchedReReserveCooldownMs,
			launchSlots: slots,
			backlogImmediate:
				process.env.HOBO_CI_UNLAUNCHED_BACKLOG_IMMEDIATE !== "0",
		},
		parallelLaunchCapacity: () =>
			mainShardParallelLaunchCapacity({
				availableMb: memoryAdmission.availableLowWaterMb(),
				requestMb: memoryConfig.classes.standard,
				reserveMb: memoryConfig.reserveMb,
				volatilityMb: capacityVolatilityMb,
				launchSlots: slots,
			}),
		fleetCapacity: { snapshot: localFleetCapacitySnapshot },
		control: async () => undefined,
		onTickTiming: (timing) =>
			log("hobo_ci_isolated_worker_tick_slow", {
				...timing,
				workerReconcileMs,
			}),
		inboxDeliveryTimeoutMs,
		inboxDrainBudgetMs,
		onInboxDeliveryEvent: (event, fields) => log(event, fields),
	});
	// HoBo Fleet (ADR-0183): with a committed `fleet` block in .hobo/ci.json
	// (D61) this box is a DEDICATED fleet member with roles DISPATCHER and
	// EXECUTOR. Its memory, storage and host-health admission is its capacity;
	// GitHub's queue reaches it as the github-actions-job work kind, and each
	// order runs in a sandbox from @hobo/fleet-agent behind the agent's egress
	// proxy. Without the block, or before the box is enrolled and with no
	// bootstrap token file, the box takes GitHub's queue alone, as before. No
	// fleet setting is read from the environment: only the state directory and
	// the token's file path come from the process.
	const memberSettings = readBoxMemberSettings(checkoutRoot, process.env, {
		journalDirectory: dirname(plan.store.path),
	});
	const memberKeys = memberSettings
		? (await import("@hobo/fleet-agent")).createFileKeyStore(
				memberSettings.home,
			)
		: undefined;
	const memberEnrolled =
		memberKeys !== undefined &&
		(await memberKeys.readState()).trust !== undefined;
	if (
		memberSettings &&
		memberKeys &&
		(memberEnrolled || memberSettings.bootstrapTokenFile !== undefined)
	) {
		const authorityUrl = memberSettings.authorityUrl;
		const fleetName = memberSettings.fleet;
		const tenant = memberSettings.tenant;
		// D58's sandbox settings come from the committed block on the box:
		// whatever the environment says is replaced before the drivers read it.
		for (const [name, value] of [
			["HOBO_FLEET_SANDBOX_RUNTIME", memberSettings.sandbox.runtime],
			["HOBO_FLEET_SANDBOX_CACHE", memberSettings.sandbox.cache],
			[
				"HOBO_FLEET_SANDBOX_DOWNLOAD",
				memberSettings.sandbox.download ? undefined : "0",
			],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		const [ciGh, fleetAgent, fleetNats, core] = await Promise.all([
			import("@hobo/ci-gh-actions"),
			import("@hobo/fleet-agent"),
			import("@hobo/fleet-nats"),
			import("@hobo/core"),
		]);
		const fleetLog = (
			event: string,
			fields: Readonly<Record<string, string | number | boolean>>,
		) => log(event, fields);
		const connections = async () =>
			(await store.configuration())?.configuration?.connections ?? [];
		const keys = memberKeys;
		const standardDiskMb = Math.ceil(
			storageReserveForClass("standard").workRootBytes / (1024 * 1024),
		);
		let daemon: ReturnType<typeof ciGh.composeFleetDaemon>;
		const egress = fleetAgent.createEgressProxyFactory({
			fleetAllow: () => daemon.fleetAllow(),
			log: fleetLog,
		});
		daemon = ciGh.composeFleetDaemon({
			keys,
			authorityUrl,
			tenant: core.parseTenantId(tenant),
			fleet: fleetName,
			connector: fleetNats.createNatsBusConnector(),
			admission: {
				slots,
				labels: trunkSlots > 0 ? ["hobo", "hobo-trunk"] : ["hobo"],
				read: async () => {
					const availableMb = readAvailableMemoryMb();
					const freeDisk = freeDiskMbOf(workRoot);
					const budgetLeftMb = memoryConfig.budgetMb - inUseWorkerMemoryMb;
					return {
						usedSlots: liveLaunchSlotsInUse,
						hostHealth: hostHealth.current().state,
						draining: fleetMemberDraining,
						memoryAdmits:
							!hostPressureBlocksAdmission(hostPressureSample()) &&
							memoryAdmitHeadroom(
								availableMb,
								memoryConfig.classes.standard,
								memoryConfig.reserveMb,
								capacityVolatilityMb,
							),
						storageAdmits: freeDisk === undefined || freeDisk >= standardDiskMb,
						freeMemoryMb:
							availableMb === undefined
								? budgetLeftMb
								: Math.min(
										budgetLeftMb,
										availableMb - memoryConfig.reserveMb - capacityVolatilityMb,
									),
						freeDiskMb: freeDisk,
					};
				},
			},
			work: {
				source: ciGh.createGithubActionsWorkSource({
					poller: {
						github,
						durations: jobDurations,
						connections,
						ingest: (delivery) => runtime.ingestWebhook(delivery),
					},
					mintRegistration: ciGh.createJitRegistrationMinter({
						github,
						connections,
					}),
					now: Date.now,
					log: fleetLog,
				}),
				runner: ciGh.createGithubActionsWorkRunner(),
			},
			sandboxes: await fleetAgent.sandboxDrivers({ log: fleetLog }),
			egress,
			agentVersion: controllerDigest ?? ciGhActionsVersion(),
			now: Date.now,
			log: fleetLog,
			fetch,
		});
		// First start: enroll with the single-use bootstrap token, read from a
		// file so it never appears on a command line or in the environment.
		if (!memberEnrolled && memberSettings.bootstrapTokenFile !== undefined) {
			const enrolled = await daemon.agent.enroll(
				ciGh.boxEnrollment({
					tenant: core.parseTenantId(tenant),
					fleet: fleetName,
					name: memberSettings.memberName ?? memberNameOf(hostname()),
					bootstrapToken: readFileSync(
						memberSettings.bootstrapTokenFile,
						"utf8",
					).trim(),
					region: memberSettings.region,
					platform: { os: process.platform, arch: process.arch },
				}),
			);
			if (!enrolled.ok)
				throw new Error(`fleet enrollment failed: ${enrolled.error.code}`);
		}
		await daemon.agent.start();
		fleetHostDocker = () => daemon.hostDocker();
		const timer = setInterval(() => {
			void daemon.refreshFleet().catch(() => undefined);
		}, 10_000);
		timer.unref();
		void daemon.refreshFleet().catch(() => undefined);
		fleetMember = { daemon, timer };
	}
	log("hobo_ci_fleet_member", {
		enabled: fleetMember !== undefined,
		fleet: memberSettings?.fleet ?? "",
		configured: memberSettings !== undefined,
		enrolled: memberEnrolled,
	});
	const pollIngestCoalesce = createPollIngestCoalesce();
	const heldJobPruner =
		plan.admission === "pull"
			? createHeldJobPruner({
					store,
					coalesce: pollIngestCoalesce,
					clearTrunkWait: (job) => runtime.clearTrunkWait(job),
					log: (event, fields) => log(event, fields),
				})
			: undefined;
	const poller =
		plan.admission === "pull" && fleetMember === undefined
			? createGithubJobPoller({
					github,
					durations: jobDurations,
					admissionOrder: runtime.admissionOrder,
					ingestCoalesce: pollIngestCoalesce,
					connections: async () =>
						(await store.configuration())?.configuration?.connections ?? [],
					ingest: (delivery) => runtime.ingestWebhook(delivery),
					onIngestError: (jobId, message) =>
						log("hobo_ci_isolated_worker_job_ingest_failed", {
							jobId,
							message,
						}),
					onGithubError: (failure) =>
						log("hobo_ci_isolated_worker_github_read_failed", { ...failure }),
					beforePoll: () => mergeQueueCache.refresh(),
					onMainFabricTrunkQueued: (repository) => {
						warmContainersStarting += 1;
						void worker
							.prewarm(repository)
							.catch((error) =>
								log("hobo_ci_main_fabric_prewarm_failed", {
									repository,
									message: error instanceof Error ? error.message : "unknown",
								}),
							)
							.finally(() => {
								warmContainersStarting -= 1;
							});
					},
				})
			: undefined;
	const pollWorthLogging = createPollLogFilter();
	// What the routing slip reads of GitHub: the last completed poll's jobs on
	// routed labels, and the jobs runners took lately.
	const runnerPickups = createRunnerPickupMemory();
	let latestRunnerJobs: RunnerJobsSeen | undefined;

	let draining = false;
	let workerDrainStartedAtMs: number | undefined;
	let shutdownSignalCount = 0;
	let shutdownForceExitInFlight = false;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let jobPollTimer: ReturnType<typeof setInterval> | undefined;
	let inboxDrainTimer: ReturnType<typeof setInterval> | undefined;
	let gcTimer: ReturnType<typeof setInterval> | undefined;
	let tickInFlight: Promise<void> | undefined;
	let inboxDrainInFlight: Promise<void> | undefined;
	let jobPollInFlight: Promise<void> | undefined;
	let gcInFlight: Promise<void> | undefined;
	let orphanReconcileInFlight: Promise<void> | undefined;
	let lastOrphanReconcileAt = 0;
	const orphanReconcileMinMs = Number(
		process.env.HOBO_CI_ORPHAN_RECONCILE_MIN_MS ?? "60_000",
	);

	function runOrphanJobReconcile(): void {
		if (draining || orphanReconcileInFlight) return;
		const now = Date.now();
		if (now - lastOrphanReconcileAt < orphanReconcileMinMs) return;
		lastOrphanReconcileAt = now;
		orphanReconcileInFlight = worker
			.reconcileOrphanJobs()
			.then(() => worker.reconcileStallRecoveries())
			.catch((error) => {
				log("hobo_ci_orphan_job_reconcile_failed", {
					message: error instanceof Error ? error.message : "unknown",
				});
			})
			.finally(() => {
				orphanReconcileInFlight = undefined;
			});
	}

	const reconcileAndLaunch = singleFlight(async () => {
		// Sampled at most every ten seconds; never fails the tick.
		await hostHealth.observe();
		const pressureAt = Date.now();
		if (pressureAt - lastHostPressureLogAt >= 10_000) {
			lastHostPressureLogAt = pressureAt;
			log(
				"hobo_ci_host_resource_pressure",
				hostResourcePressureLogFields(hostPressureSample()),
			);
		}
		const workerReconcileStartedAt = Date.now();
		const reconciliation = await worker.reconcileLeases();
		workerReconcileMs = Date.now() - workerReconcileStartedAt;
		liveLaunchSlotsInUse = countLiveBoxContainers(await store.activeLeases());
		drainJobInFlight = reconciliation.drainJobInFlight;
		inUseWorkerMemoryMb = reconciliation.inUseMemoryMb;
		runOrphanJobReconcile();
		if (!reconciliation.inventoryKnown) return;
		// Pull workers drain the inbox on a separate timer so admission ticks stay
		// under slow-tick alerting; push relay hosts still bound inbox work in tick.
		// The host's CD agent may have closed admission to swap the controller:
		// inspect leases, admit nothing new; running jobs are untouched.
		await runtime.tick({
			maxDeliveries: poller ? 0 : 10,
			admit: !admissionPausedByAgent(),
		});
		if (heldJobPruner) {
			const pruned = await heldJobPruner.maybePrune();
			if (pruned > 0) void runTick().catch(() => undefined);
		}
	});

	function runInboxDrain(): void {
		if (draining || !poller || inboxDrainInFlight) return;
		inboxDrainInFlight = runtime
			.drainInbox()
			.then((result) => {
				if (result.processed > 0 || result.failed > 0 || result.timedOut > 0) {
					log("hobo_ci_inbox_drain_pass", {
						processed: result.processed,
						failed: result.failed,
						timedOut: result.timedOut,
						deliveriesMs: result.deliveriesMs,
						budgetExhausted: result.budgetExhausted,
					});
				}
				if (result.ingressWantsDispatch) void runTick();
			})
			.catch((error) => {
				log("hobo_ci_inbox_drain_failed", {
					message: error instanceof Error ? error.message : "unknown",
				});
			})
			.finally(() => {
				inboxDrainInFlight = undefined;
			});
	}

	function runTick(): Promise<void> {
		if (tickInFlight) return tickInFlight;
		if (draining || gcInFlight) return Promise.resolve();
		const current = reconcileAndLaunch();
		const tracked = current.finally(() => {
			if (tickInFlight === tracked) tickInFlight = undefined;
			if (gcRequested) {
				gcRequested = false;
				runGc();
			}
		});
		tickInFlight = tracked;
		return tracked;
	}

	function runJobPoll(): void {
		if (draining || !poller || jobPollInFlight) return;
		jobPollInFlight = poller
			.poll()
			.then(async (summary) => {
				heldJobPruner?.observePollWitness(
					summary.heldPruneWitness ?? {
						terminalRuns: [],
						terminalJobs: [],
					},
				);
				const { waiting, runnerJobs, ...counts } = summary;
				if (runnerJobs) {
					latestRunnerJobs = runnerJobs;
					runnerPickups.remember(runnerJobs);
				}
				const pruned = (await heldJobPruner?.maybePrune()) ?? 0;
				if (summary.accepted > 0 || pruned > 0)
					void runTick().catch(() => undefined);
				if (!pollWorthLogging(summary, Date.now())) return;
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

	let depsEnsureTimer: ReturnType<typeof setTimeout> | undefined;

	function runDepsImageEnsure(): void {
		if (draining || !depsImageEnsurer) return;
		void depsImageEnsurer
			.ensure()
			.then((result) => {
				if (draining) return;
				const delay =
					result.status === "failed" || result.status === "backoff"
						? result.retryMs
						: depsPollMs;
				depsEnsureTimer = setTimeout(runDepsImageEnsure, delay);
			})
			.catch((error) => {
				log("hobo_ci_deps_image_ensure_failed", {
					key: "unknown",
					action: "hit",
					ms: 0,
					message: error instanceof Error ? error.message : "unknown",
					retryMs: depsPollMs,
				});
				if (!draining)
					depsEnsureTimer = setTimeout(runDepsImageEnsure, depsPollMs);
			});
	}

	function runGc(): void {
		retiredSweep.trigger();
		if (draining || gcInFlight || tickInFlight) return;
		gcInFlight = store
			.activeLeases()
			.then((leases) =>
				storageAdmission.maintain(storageLeases(leases), { pnpmStore: true }),
			)
			.catch((error) => {
				log("hobo_ci_isolated_worker_gc_failed", {
					message: error instanceof Error ? error.message : "unknown",
				});
			})
			.finally(() => {
				gcInFlight = undefined;
			});
	}

	log("hobo_ci_isolated_worker_started", {
		commit: daemonCommit ?? "unknown",
		routingPolicy: routingPolicy.source,
		store: plan.store.kind,
		admission: plan.admission,
		publicOrigin,
		pollMs: intervalMs,
		jobPollMs: plan.jobPollMs,
		inboxDeliveryTimeoutMs,
		inboxDrainBudgetMs,
		hostMemMb,
		workerMemoryMb,
		memoryBudgetMb: memoryConfig.budgetMb,
		memoryReserveMb: memoryConfig.reserveMb,
		memoryLightMb: memoryConfig.classes.light,
		memoryStandardMb: memoryConfig.classes.standard,
		memoryTrunkReservationMb: memoryConfig.trunkReservationMb,
		memoryHolMs: memoryConfig.holMs,
		slots,
		trunkSlots,
		mergeGroupLeases,
		lendTrunkSlots,
		workRoot,
		pnpmStoreMounted: pnpmStore !== "",
		pnpmStorePruneIntervalMs,
		gcIntervalMs,
		drainTimeoutMs,
		stopMode,
	});
	// Routing comes from committed policy (ADR-0181, decision 4): name, once, any
	// routing variable still set on the box, so an override that stopped
	// applying is visible. Never its value.
	const ignoredRoutingNames = routingEnvironmentNamesSet(process.env);
	if (ignoredRoutingNames.length > 0)
		log("hobo_ci_routing_environment_ignored", {
			names: ignoredRoutingNames.join(","),
			policy: routingPolicy.source,
		});

	gcTimer = setInterval(runGc, gcIntervalMs);
	pollTimer = setInterval(() => {
		void runTick().catch((error) => {
			log("hobo_ci_isolated_worker_tick_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
		});
	}, intervalMs);
	if (poller) {
		const inboxDrainIntervalMs = Math.min(intervalMs, 5_000);
		runInboxDrain();
		inboxDrainTimer = setInterval(runInboxDrain, inboxDrainIntervalMs);
		void (async () => {
			if (heldJobPruner) {
				const storeWitness = await refreshHeldPruneWitnessFromStore({
					store,
					github,
				});
				if (
					storeWitness.terminalRuns.length > 0 ||
					storeWitness.terminalJobs.length > 0
				) {
					heldJobPruner.observePollWitness(
						mergeHeldPruneWitness(
							{ terminalRuns: [], terminalJobs: [] },
							storeWitness,
						),
					);
					const pruned = await heldJobPruner.maybePrune(true);
					if (pruned > 0) void runTick().catch(() => undefined);
				}
			}
			runJobPoll();
		})().catch((error) => {
			log("hobo_ci_held_job_startup_prune_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
			runJobPoll();
		});
		jobPollTimer = setInterval(() => {
			runJobPoll();
			runOrphanJobReconcile();
		}, plan.jobPollMs);
	}
	runDepsImageEnsure();

	// The routing slip (ADR-0181). Every 10 s, on its own unreferenced timer,
	// the slip leader (rank 0 of the fleet's live DISPATCHER members; a box
	// outside a fleet leads itself) decides each connected repository's routing
	// and writes it to refs/hobo/routing-slip when it changes and as a
	// heartbeat. The decision is an adapter over `fleetVerdict`
	// (routing-slip-decision.ts), with peers from the authority's signed fleet
	// view. Nothing in admission, dispatch or the poller awaits it.
	const routedLabels =
		trunkSlots > 0
			? [routing.labels.fleet, routing.labels.trunk]
			: [routing.labels.fleet];
	// The fleet view and this box's member id, when it is a member; a view that
	// cannot be read is no view, and the slip treats peers as unknown (R3).
	const memberFleet = async () => {
		const self = fleetMember?.daemon.memberId();
		if (!fleetMember || self === undefined) return undefined;
		const view = await fleetMember.daemon.fleetView().catch(() => undefined);
		return view === undefined ? undefined : { view, self };
	};
	const evaluateRouting = async (
		runners: RepositoryRunnersView | undefined,
		active: Awaited<ReturnType<typeof store.activeLeases>>,
	) => {
		const nowMs = Date.now();
		const idle =
			active.length === 0 &&
			liveLaunchSlotsInUse === 0 &&
			!depsImageWorkRunning &&
			warmContainersStarting === 0 &&
			gcInFlight === undefined;
		const pickups = runnerPickups.list(nowMs);
		const ownLeaseIds = new Set<string>();
		for (const id of boxLeaseIdsOf(pickups))
			if (await store.get(id)) ownLeaseIds.add(id);
		const seen = latestRunnerJobs;
		return evaluateRoutingSlip({
			nowMs,
			labels: routedLabels,
			idle,
			freeSlots: Math.max(0, slots - liveLaunchSlotsInUse),
			draining,
			host: {
				availableMb: readAvailableMemoryMb(),
				pressure: hostPressureSample(),
				health: hostHealth.current(),
			},
			admission: {
				standardClassMb: memoryConfig.classes.standard,
				reserveMb: memoryConfig.reserveMb,
				volatilityMb: capacityVolatilityMb,
			},
			pools: routing.externalPools,
			minFreeRunners: routing.verdict.minFreeRunners,
			poll:
				seen === undefined
					? undefined
					: {
							completedAtMs: Date.parse(seen.completedAt),
							inProgress: seen.inProgress.map((job) => ({
								label: job.label,
								runnerName: job.runnerName,
								startedAtMs: Date.parse(job.startedAt ?? seen.completedAt),
							})),
						},
			runners: { view: runners },
			fleet: await memberFleet(),
			ownLeaseIds,
			pickups,
		});
	};
	// GitHub's runner list per repository, read only when pools are declared
	// and no more than every 30 s; a failed read is unknown (R3).
	const runnerViews = new Map<string, RepositoryRunnersView | undefined>();
	const runnerViewReadAt = new Map<string, number>();
	const readRunners = async (
		installationId: number,
		repository: string,
	): Promise<RepositoryRunnersView | undefined> => {
		const nowMs = Date.now();
		if (routing.externalPools.length === 0)
			return { readAtMs: nowMs, runners: [] };
		if (nowMs - (runnerViewReadAt.get(repository) ?? 0) < 30_000)
			return runnerViews.get(repository);
		runnerViewReadAt.set(repository, nowMs);
		const view = await readRepositoryRunners(
			github,
			{ installationId, repository },
			nowMs,
		);
		runnerViews.set(repository, view);
		return view;
	};
	const connectedTargets = async () => {
		const seen = new Map<string, number>();
		for (const connection of (await store.configuration())?.configuration
			?.connections ?? [])
			if (!seen.has(connection.repository))
				seen.set(connection.repository, connection.installationId);
		return [...seen].map(([repository, installationId]) => ({
			repository,
			installationId,
		}));
	};
	const slipHolds = new Map<string, ReturnType<typeof createRoutingHolds>>();
	const STALL_WAITING_STATES = new Set([
		"reserved",
		"dispatching",
		"dispatched",
		"claiming",
	]);
	const stallWatch = createRoutingStallWatch({
		stallMs: routing.verdict.stallMs,
		startedAtMs: Date.now(),
	});
	const labelOfLease = (lease: Lease) =>
		workerRunnerLabels.get(`${lease.repository}:${lease.jobId}`) ===
		routing.labels.trunk
			? routing.labels.trunk
			: routing.labels.fleet;
	const decideSlip = async (repository: string) => {
		const nowMs = Date.now();
		const target = (await connectedTargets()).find(
			(entry) => entry.repository === repository,
		);
		const active = await store.activeLeases();
		const evaluation = await evaluateRouting(
			target ? await readRunners(target.installationId, repository) : undefined,
			active,
		);
		let holds = slipHolds.get(repository);
		if (!holds) {
			holds = createRoutingHolds({
				labels: routedLabels,
				enterMs: routing.verdict.enterMs,
				exitMs: routing.verdict.exitMs,
			});
			slipHolds.set(repository, holds);
		}
		holds.observe(nowMs, new Set(evaluation.blocked.keys()));
		// A label stalls on the box, whatever repository its work came from, so
		// the watch sees every lease: filtered per repository, a running job of
		// another repository would read as a fresh start on every pass. Work is
		// waiting from reservation until its runner starts it, so a container
		// whose runner never takes the job counts too.
		const stalled = stallWatch.observe(
			nowMs,
			active.map((lease) => ({
				id: lease.id,
				label: labelOfLease(lease),
				waiting: STALL_WAITING_STATES.has(lease.state),
				started: lease.state === "running",
				assignedAtMs: Date.parse(lease.createdAt) || nowMs,
			})),
		);
		return decideRoutingSlipClasses({
			policy: routing,
			served: evaluation.served,
			refused: holds.blocked(),
			stalled,
			full: evaluation.full,
		});
	};
	const hostSlipNodeId = hostname()
		.replace(/[^A-Za-z0-9_-]/g, "-")
		.slice(0, 64);
	// Known once the agent is enrolled; the slip names the member that wrote it.
	const slipNodeId = fleetMember?.daemon.memberId() ?? hostSlipNodeId;
	const slipIssuer = daemonCommit
		? createRoutingSlipIssuer({
				github,
				labels: runnerRoutingLabels(routing),
				relay: { nodeId: slipNodeId, commit: daemonCommit },
				// rank 0 of rankMembers over the fleet's live dispatchers
				// (`leaderOf`, replacing main's lowest-node-id election); a box
				// outside a fleet leads itself.
				leader: async () => {
					if (!fleetMember) return true;
					const fleet = await memberFleet();
					if (fleet === undefined) return true;
					return routingSlipLeader(fleet, Date.now()) === fleet.self;
				},
				targets: connectedTargets,
				decide: decideSlip,
				enabled: () => !draining,
				log,
				// Once per start, on the leader: delete the retired variables
				// (ADR-0181, decision 6). A 403 is logged once and never retried here.
				onFirstLead: async () => {
					for (const target of await connectedTargets())
						await retireRepositoryVariables(github, {
							installationId: target.installationId,
							repository: target.repository,
							names: routing.retiredVariables,
							log,
						});
				},
			})
		: undefined;
	if (!slipIssuer)
		log("hobo_ci_slip_leader", {
			leader: false,
			nodeId: slipNodeId,
			reason: "commit-unknown",
		});
	const slipTimer = slipIssuer
		? setInterval(() => void slipIssuer.tick(), ROUTING_SLIP_SAMPLE_MS)
		: undefined;
	slipTimer?.unref();
	void slipIssuer?.tick();

	let shutdownOnce: Promise<void> | undefined;
	let runningWorkerContainers = 0;

	async function shutdown(signal: string) {
		if (shutdownOnce) return shutdownOnce;
		shutdownOnce = (async () => {
			draining = true;
			workerDrainStartedAtMs = Date.now();
			if (pollTimer) clearInterval(pollTimer);
			if (jobPollTimer) clearInterval(jobPollTimer);
			if (inboxDrainTimer) clearInterval(inboxDrainTimer);
			if (depsEnsureTimer) clearTimeout(depsEnsureTimer);
			if (gcTimer) clearInterval(gcTimer);
			await worker.discardWarm().catch(() => undefined);
			log("hobo_ci_isolated_worker_draining", { signal });
			// Tell the fleet at once: dispatchers stop offering this box work.
			fleetMemberDraining = true;
			if (fleetMember) {
				clearInterval(fleetMember.timer);
				await fleetMember.daemon.agent.drain().catch(() => undefined);
			}
			// No more slips: the last one expires on its own (ADR-0181).
			if (slipTimer) clearInterval(slipTimer);
			const backgroundKinds = (): (
				| "tick"
				| "inbox"
				| "jobPoll"
				| "gc"
				| "orphanReconcile"
			)[] => {
				const kinds: (
					| "tick"
					| "inbox"
					| "jobPoll"
					| "gc"
					| "orphanReconcile"
				)[] = [];
				if (tickInFlight) kinds.push("tick");
				if (inboxDrainInFlight) kinds.push("inbox");
				if (jobPollInFlight) kinds.push("jobPoll");
				if (gcInFlight) kinds.push("gc");
				if (orphanReconcileInFlight) kinds.push("orphanReconcile");
				return kinds;
			};
			const background = await awaitWorkerBackgroundDrainIdle({
				inFlight: backgroundKinds,
				boundMs: DEFAULT_DRAIN_BACKGROUND_BOUND_MS,
				onProgress: ({ inFlight, elapsedMs, boundMs }) =>
					log("hobo_ci_drain_progress", {
						phase: "background",
						inFlight: inFlight.join(","),
						elapsedMs,
						boundMs,
					}),
			});
			if (background.timedOut) {
				log("hobo_ci_drain_progress", {
					phase: "background",
					timedOut: true,
					inFlight: background.inFlight.join(","),
					boundMs: DEFAULT_DRAIN_BACKGROUND_BOUND_MS,
				});
			}
			tickInFlight = undefined;
			jobPollInFlight = undefined;
			inboxDrainInFlight = undefined;
			gcInFlight = undefined;
			orphanReconcileInFlight = undefined;
			const reconcileDrain = async () => {
				const workerReconcileStartedAt = Date.now();
				const reconciliation = await worker.reconcileLeases({
					draining: true,
					drainStartedAtMs: workerDrainStartedAtMs,
				});
				workerReconcileMs = Date.now() - workerReconcileStartedAt;
				liveWorkerLeaseIds = reconciliation.liveLeaseIds;
				liveLaunchSlotsInUse = countLiveBoxContainers(
					await store.activeLeases(),
				);
				drainJobInFlight = reconciliation.drainJobInFlight;
				inUseWorkerMemoryMb = reconciliation.inUseMemoryMb;
				await worker.reconcileOrphanJobs();
				await worker.reconcileStallRecoveries();
				if (reconciliation.inventoryKnown) await runtime.tick({ admit: false });
				try {
					const listed = await listWorkerContainers();
					runningWorkerContainers = listed.filter(
						(c) => c.state === "running" && c.name.startsWith("hobo-"),
					).length;
				} catch {
					runningWorkerContainers = 0;
				}
			};
			const inFlight = async () => drainJobInFlight;
			await reconcileDrain();
			if (stopMode === "drain")
				log("hobo_ci_isolated_worker_drain_started", {
					inFlight: await inFlight(),
					timeoutMs: drainTimeoutMs,
				});
			let reported = -1;
			const result = await stopIsolatedWorker({
				mode: stopMode,
				inFlight,
				reconcile: reconcileDrain,
				pollMs: Math.min(intervalMs, 5_000),
				timeoutMs: drainTimeoutMs,
				onWaiting: (remaining) => {
					if (remaining === reported) return;
					reported = remaining;
					log("hobo_ci_isolated_worker_drain_waiting", { remaining });
				},
				onProgress: ({ remaining, elapsedMs, timeoutMs }) =>
					log("hobo_ci_drain_progress", {
						phase: "jobs",
						remaining,
						elapsedMs,
						timeoutMs,
						runningWorkerContainers,
					}),
			});
			if (result.mode === "handoff") {
				log("hobo_ci_isolated_worker_handoff", { running: result.remaining });
			} else if (result.drained) {
				log("hobo_ci_isolated_worker_drained", { remaining: 0 });
			} else {
				log("hobo_ci_isolated_worker_drain_timeout", {
					remaining: result.remaining,
				});
			}
			if (stopMode === "drain") await retiredSweep.drain();
			await closeStore();
			await Promise.race([
				fleetMember?.daemon.agent.stop().catch(() => undefined),
				new Promise((resolve) => setTimeout(resolve, 2000).unref()),
			]);
			await closeTrace();
			process.exit(result.mode === "handoff" || result.drained ? 0 : 1);
		})().catch(async (error) => {
			await closeStore().catch(() => undefined);
			log("hobo_ci_isolated_worker_shutdown_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
			await closeTrace();
			process.exit(1);
		});
		return shutdownOnce;
	}

	// `on`, not `once`: a supervisor that signals the whole process group (and a
	// parent that forwards the same signal) sends it twice, and a second signal
	// with no listener would kill the drain.
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.on(signal, () => {
			shutdownSignalCount += 1;
			void (async () => {
				if (
					!shutdownForceExitInFlight &&
					draining &&
					shutdownSignalCount >= 2
				) {
					let running = runningWorkerContainers;
					try {
						const listed = await listWorkerContainers();
						running = listed.filter(
							(c) => c.state === "running" && c.name.startsWith("hobo-"),
						).length;
					} catch {
						/* keep last runningWorkerContainers */
					}
					const { shouldForceExitDrainOnRepeatSignal } = await import(
						"../src/isolated-worker/daemon-shutdown.js"
					);
					if (
						await shouldForceExitDrainOnRepeatSignal({
							signalCount: shutdownSignalCount,
							draining: true,
							runningWorkerContainers: running,
						})
					) {
						shutdownForceExitInFlight = true;
						log("hobo_ci_isolated_worker_drain_force_exit", {
							signal,
							signals: shutdownSignalCount,
							running,
						});
						await closeStore().catch(() => undefined);
						await closeTrace();
						process.exit(0);
					}
				}
			})();
			void shutdown(signal);
		});
} catch (error) {
	await closeStore().catch(() => undefined);
	throw error;
}
