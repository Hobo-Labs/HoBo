import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
import { createTrustedMeshBoard } from "@hobo/ci/mesh";
import {
	awaitWorkerBackgroundDrainIdle,
	boxGitMirrorPath,
	ciEventSinkFromEnv,
	countLiveBoxContainers,
	createBoxGitMirror,
	createCiEventEmitter,
	createCliDockerDriver,
	createCompositeIsolatedHost,
	createContainerStallGuard,
	createDepsImageEnsurer,
	createFleetCapacityPublisher,
	createFleetRoutePublisher,
	createFleetStatePublisher,
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
	createMeshTrust,
	createNodeWorkerStorageFileSystem,
	createPnpmStoreMaintenance,
	createPollIngestCoalesce,
	createPollLogFilter,
	createRelayTrace,
	createRetiredWorkDirectorySweeper,
	createStoragePeaks,
	createWorkerMemoryAdmission,
	createWorkerMesh,
	createWorkerStorageAdmission,
	DEFAULT_DRAIN_BACKGROUND_BOUND_MS,
	type DepsImageProcessRequest,
	defaultDepsRoot,
	defaultGitMirrorFallbackRoot,
	defaultGitMirrorPreferredRoot,
	describeWaitingJobs,
	freeDiskMb,
	generalLeaseIdsFor,
	type HostedInboxStore,
	hostPressureBlocksAdmission,
	hostResourcePressureLogFields,
	type IsolatedWorkerStore,
	isIsolatedContainerOffer,
	loadMeshIdentity,
	localWorkerFreeSlots,
	type MeshJournal,
	memoryRequestForJob,
	mergeHeldPruneWitness,
	meshReliabilityJournal,
	meshReliabilityResetToken,
	meshSettingsFromEnv,
	parseWorkerStopMode,
	readAvailableMemoryMb,
	readHostHealthSample,
	readHostMemory,
	readHostResourcePressureSample,
	refreshHeldPruneWitnessFromStore,
	relayTraceSinkFromEnv,
	resolvedStorageReserve,
	resolveGitMirrorRoot,
	resolveWorkerMemoryConfig,
	resolveWorkerSlotConfig,
	resolveWorkerStorePlan,
	singleFlight,
	stopIsolatedWorker,
	storageReserveForClass,
	storageReserveForJob,
	traceGithubTransport,
	withGithubReadCache,
} from "@hobo/ci-gh-actions";
import { ciRunnerImageVersion } from "../../../scripts/lib/ci-runner-contract.mts";
import { depsKeyForRoot } from "../../../scripts/lib/deps-key.mts";
import { loadWorkerBudgetAdapter } from "./worker-budget-adapter.mts";

const exec = promisify(execFile);

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

/** Optional NATS credentials, from the variable or its `_FILE`. */
function natsCredentials() {
	const read = (name: string) => {
		const file = process.env[`${name}_FILE`];
		const value = file
			? readFileSync(file, "utf8").trimEnd()
			: process.env[name];
		return value ? value : undefined;
	};
	return {
		token: read("HOBO_CI_NATS_TOKEN"),
		user: read("HOBO_CI_NATS_USER"),
		password: read("HOBO_CI_NATS_PASSWORD"),
	};
}

function storageLeases(leases: readonly Lease[]) {
	return leases.map((lease) => ({
		id: lease.id,
		sandboxName: lease.sandboxName,
		jobId: String(lease.jobId),
	}));
}

function secretOrFile(name: string): string {
	const file = process.env[`${name}_FILE`];
	return file ? readFileSync(file, "utf8").trimEnd() : required(name);
}

/**
 * Set once the worker has joined a mesh: its own log events say what became
 * of the jobs it took, and that is what its reliability is scored from.
 */
let meshOutcomes:
	| ((
			event: string,
			fields: Readonly<Record<string, string | number | boolean>>,
	  ) => void)
	| undefined;

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
	meshOutcomes?.(event, fields);
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

const plan = resolveWorkerStorePlan(process.env, homedir());
const appId = required("HOBO_CI_GITHUB_APP_ID");
const privateKey = process.env.HOBO_CI_GITHUB_APP_KEY_FILE
	? readFileSync(process.env.HOBO_CI_GITHUB_APP_KEY_FILE, "utf8")
	: secretOrFile("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
// A worker's configuration is its own file or variable. One that has
// neither and is told where a mesh is asks the mesh, so adding a box takes a
// NATS address and App credentials and nothing else.
const meshBootSettings = meshSettingsFromEnv(process.env, hostname());
const localConfiguration = process.env.HOBO_CI_CONFIG
	? readFileSync(process.env.HOBO_CI_CONFIG, "utf8")
	: process.env.HOBO_CI_CONFIG_JSON;
const sharedConfiguration =
	localConfiguration === undefined && meshBootSettings
		? await (await import("@hobo/ci-gh-actions/mesh-nats")).readNatsMeshConfig({
				servers: meshBootSettings.servers,
				namespace: meshBootSettings.namespace,
				replicas: meshBootSettings.replicas,
				name: `hobo-ci-worker ${meshBootSettings.nodeId} (configuration)`,
				...natsCredentials(),
			})
		: undefined;
const configuration = parseConfiguration(
	localConfiguration ??
		sharedConfiguration?.value ??
		required("HOBO_CI_CONFIG_JSON"),
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
// Shared-label jobs never borrow it unless HOBO_CI_WORKER_TRUNK_LEND=1.
// The offer's concurrency must equal the slot count.
const { slots, trunkSlots, mergeGroupLeases, prCapWithTrunk } =
	resolveWorkerSlotConfig(process.env);
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
const capacityVolatilityMb = Number(
	process.env.HOBO_CI_FLEET_CAPACITY_VOLATILITY_MB ?? "1024",
);
if (
	!Number.isFinite(capacityVolatilityMb) ||
	capacityVolatilityMb < 0 ||
	!Number.isInteger(capacityVolatilityMb)
)
	throw new Error("invalid HOBO_CI_FLEET_CAPACITY_VOLATILITY_MB");
let lastHostPressureLogAt = 0;
const hostPressureSample = () => readHostResourcePressureSample(Date.now());
const containerStallGuard = createContainerStallGuard({
	read: hostPressureSample,
});
const memoryAdmission = createWorkerMemoryAdmission(memoryConfig, {
	log,
	prCapWithTrunk,
	availableMemoryMb: readAvailableMemoryMb,
	volatilityMb: capacityVolatilityMb,
	hostPressure: hostPressureSample,
	hostCores: () => cpus().length,
});
const trunkLend = process.env.HOBO_CI_WORKER_TRUNK_LEND ?? "0";
if (trunkLend !== "0" && trunkLend !== "1")
	throw new Error("invalid HOBO_CI_WORKER_TRUNK_LEND");
const lendTrunkSlots = trunkLend === "1";
// Off unless set: the relay then keeps HOBO_CI_FLEET_ROUTES current so new jobs
// can ask a label provider for a runner while the box is full. The App needs
// repository "Variables: write" for it; a refused write is logged and ignored.
const fleetRoutesFlag = process.env.HOBO_CI_FLEET_ROUTES ?? "0";
if (fleetRoutesFlag !== "0" && fleetRoutesFlag !== "1")
	throw new Error("invalid HOBO_CI_FLEET_ROUTES");
const publishFleetRoutes = fleetRoutesFlag === "1";
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
// The worker's own SQLite journal, when it has one: where its mesh
// reliability record is kept, and beside which its identity key lives.
let meshJournal: MeshJournal | undefined;
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
	meshJournal = sqlite;
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
	const depsRoot =
		process.env.HOBO_CI_DEPS_ROOT ?? defaultDepsRoot(import.meta.url);
	if (pnpmStore && statSync(pnpmStore).dev !== statSync(workRoot).dev)
		throw new Error(
			"pnpm store and work root must share a filesystem for hardlinks",
		);
	const docker = createCliDockerDriver({ env: process.env, log });
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
			onEvent: ({ event, ...fields }) => log(event, fields),
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
	const fleetRoutes = publishFleetRoutes
		? createFleetRoutePublisher({
				github,
				log,
				unhealthyOfferIds: (account) => {
					const bad = new Set<string>();
					const isolated = account.offers.filter(
						(offer) =>
							isIsolatedContainerOffer(offer) &&
							offer.providerAccountId === workerAccountId,
					);
					if (hostHealth.current().state === "critical") {
						for (const offer of isolated) bad.add(offer.id);
						return bad;
					}
					const availableMb = readAvailableMemoryMb();
					const pressure = hostPressureSample();
					if (
						hostPressureBlocksAdmission(pressure) ||
						!memoryAdmitHeadroom(
							availableMb,
							memoryConfig.classes.heavy,
							memoryConfig.reserveMb,
							capacityVolatilityMb,
						)
					) {
						for (const offer of isolated) bad.add(offer.id);
					}
					return bad;
				},
			})
		: undefined;
	const fleetCapacityPublisher = publishFleetRoutes
		? createFleetCapacityPublisher({ github, log })
		: undefined;
	const localFleetCapacitySnapshot = async () => {
		const active = await store.activeLeases();
		const hoboFreeSlots = localWorkerFreeSlots(slots, active);
		const meshCap = await mesh?.observe();
		if (!meshCap) return { hoboFreeSlots };
		const meshFree = meshCap.freeSlots;
		return {
			hoboFreeSlots,
			meshFreeSlots: meshFree,
			arcFreeSlots: Math.max(0, meshFree - hoboFreeSlots),
		};
	};
	const headroomFleetDeferMs = Number(
		process.env.HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS ?? "45000",
	);
	if (
		!Number.isFinite(headroomFleetDeferMs) ||
		headroomFleetDeferMs < 1_000 ||
		!Number.isInteger(headroomFleetDeferMs)
	)
		throw new Error("invalid HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS");
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
	let mesh: ReturnType<typeof createWorkerMesh> | undefined;
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
		fleetRoutes,
		headroomFleetDeferMs,
		unlaunchedReservationRelease: {
			boundMs: unlaunchedReserveMs,
			backlogMinAgeMs: unlaunchedBacklogMinAgeMs,
			reReserveCooldownMs: unlaunchedReReserveCooldownMs,
			launchSlots: slots,
			backlogImmediate:
				process.env.HOBO_CI_UNLAUNCHED_BACKLOG_IMMEDIATE !== "0",
		},
		fleetCapacity: {
			publish: async (input) => {
				if (!fleetCapacityPublisher) return undefined;
				return fleetCapacityPublisher.publish(input);
			},
			snapshot: localFleetCapacitySnapshot,
		},
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
	// Relay mesh: off unless HOBO_CI_NATS_URL names a server. With it, this
	// worker advertises its free slots and takes a queued job only on its turn
	// (see docs/design/ci-relay-mesh.md). It only applies when the worker reads
	// GitHub's queue itself.
	const meshSettings =
		plan.admission === "pull"
			? meshSettingsFromEnv(process.env, hostname())
			: undefined;
	const natsMesh = meshSettings
		? (await import("@hobo/ci-gh-actions/mesh-nats")).createNatsMesh({
				servers: meshSettings.servers,
				namespace: meshSettings.namespace,
				replicas: meshSettings.replicas,
				name: `hobo-ci-worker ${meshSettings.nodeId}`,
				onStatus: (status) => log("hobo_ci_mesh_nats", { status }),
				onNodesCapped: (limit) => log("hobo_ci_mesh_nodes_capped", { limit }),
				...natsCredentials(),
			})
		: undefined;
	let meshDraining = false;
	// The worker's identity: an Ed25519 key made on first start and kept
	// beside its journal, readable by its owner only. The private half never
	// leaves this file; the public half travels with every advertisement.
	const meshIdentity = meshSettings
		? await loadMeshIdentity(
				process.env.HOBO_CI_MESH_KEY_FILE ??
					join(dirname(plan.store.path), "mesh-node.key"),
			)
		: undefined;
	// Which keys the mesh's operator vouches for, read from the mesh on every
	// beat. With none listed this worker trusts only its own key.
	const meshTrust = createMeshTrust({
		store: natsMesh?.trust,
		selfPublicKey: meshIdentity?.publicKey,
		log,
	});
	// Signs what this worker advertises, and says of every advertisement it
	// reads how far it is trusted. One whose signature fails is never ranked.
	const meshBoard = natsMesh
		? createTrustedMeshBoard({
				board: natsMesh.board,
				identity: meshIdentity,
				policy: meshTrust.policy,
			})
		: undefined;
	// The record of the jobs this worker took, kept in its journal so a
	// restart does not clear it. HOBO_CI_MESH_RELIABILITY_RESET=<token> starts
	// it again once per token, for an operator who has repaired the box.
	const meshReliability =
		meshSettings && meshJournal
			? meshReliabilityJournal(
					meshJournal,
					meshSettings.nodeId,
					(message) =>
						log("hobo_ci_mesh_reliability_journal_failed", { message }),
					meshReliabilityResetToken(process.env.HOBO_CI_MESH_RELIABILITY_RESET),
				)
			: undefined;
	const storedReliability = await meshReliability?.load();
	mesh =
		meshSettings && natsMesh && meshBoard
			? createWorkerMesh({
					settings: meshSettings,
					board: meshBoard,
					claims: natsMesh.claims,
					requireTrusted: meshTrust.requireTrusted,
					initialReliability: storedReliability?.record,
					persistReliability: (record) => void meshReliability?.save(record),
					freeSlots: () => Math.max(0, slots - liveLaunchSlotsInUse),
					totalSlots: slots,
					healthy: () => !meshDraining,
					servesTrunk: trunkSlots > 0,
					// Memory a new job could have: what the worker's budget has
					// left, and no more than the host can spare above its reserve.
					free: () => {
						const budgetLeftMb = memoryConfig.budgetMb - inUseWorkerMemoryMb;
						const availableMb = readAvailableMemoryMb();
						return {
							memoryMb: Math.max(
								0,
								Math.floor(
									availableMb === undefined
										? budgetLeftMb
										: Math.min(
												budgetLeftMb,
												availableMb -
													memoryConfig.reserveMb -
													capacityVolatilityMb,
											),
								),
							),
							// Measured on the filesystem jobs check out and build on.
							diskMb: freeDiskMb(workRoot),
						};
					},
					platform: { os: process.platform, arch: process.arch },
					// A job is sized by the same memory class the worker would
					// reserve for it at launch.
					needs: (job) => ({
						memoryMb: memoryRequestForJob(job.name, memoryConfig).memoryMb,
					}),
					log,
				})
			: undefined;
	meshOutcomes = mesh?.record;
	log("hobo_ci_mesh", {
		enabled: mesh !== undefined,
		configuration:
			localConfiguration !== undefined
				? "local"
				: sharedConfiguration
					? "mesh"
					: "none",
		nodeId: meshSettings?.nodeId ?? "",
		// The public half of the identity key, to list in the trusted set.
		publicKey: meshIdentity?.publicKey ?? "",
		reliabilityRestored: storedReliability?.record !== undefined,
		reliabilityReset: storedReliability?.reset ?? false,
		namespace: meshSettings?.namespace ?? "",
		servers: meshSettings?.servers.length ?? 0,
		stepMs: meshSettings?.stepMs ?? 0,
	});
	// The snapshot runner routing reads: per label, the nodes this worker
	// ranks and their free slots. Published with the route table's flag, to
	// each connected repository; see src/fleet-state.ts.
	const fleetState =
		publishFleetRoutes && mesh && meshBoard
			? createFleetStatePublisher({
					github,
					board: meshBoard,
					self: mesh.self,
					labels: trunkSlots > 0 ? ["hobo", "hobo-trunk"] : ["hobo"],
					requireTrusted: meshTrust.requireTrusted,
					log,
				})
			: undefined;
	// Every 10 s: read the trust settings, say what this worker can take,
	// read what the mesh can, and keep the routing snapshot fresh.
	const publishFleetState = async (timing: { now?: boolean } = {}) => {
		if (!fleetState) return;
		const state = await store.configuration().catch(() => undefined);
		await fleetState.publish(
			(state?.configuration?.connections ?? []).map((connection) => ({
				installationId: connection.installationId,
				repository: connection.repository,
			})),
			timing,
		);
	};
	const meshBeat = async () => {
		await meshTrust.refresh();
		await mesh?.advertise();
		await mesh?.observe();
		await publishFleetState();
	};
	const meshAdvertTimer = mesh
		? setInterval(() => void meshBeat(), 10_000)
		: undefined;
	meshAdvertTimer?.unref();
	// Keep the mesh's copy of the configuration in step with this worker's.
	// A worker with its own file never has it overwritten: a difference is
	// reported, and an operator decides which side is right.
	const syncMeshConfiguration = async () => {
		if (!natsMesh) return;
		const mine = toJsonString(ConfigurationSchema, configuration);
		const shared = await natsMesh.config.read();
		if (!shared) {
			const published = await natsMesh.config.publish(mine);
			log("hobo_ci_mesh_config_published", {
				revision: published === "conflict" ? 0 : published.revision,
				conflict: published === "conflict",
			});
		} else if (
			toJsonString(ConfigurationSchema, parseConfiguration(shared.value)) !==
			mine
		)
			log("hobo_ci_mesh_config_drift", {
				revision: shared.revision,
				source: localConfiguration === undefined ? "mesh" : "local",
			});
	};
	// The first connection is made in the background; advertise as soon as it is up.
	void natsMesh?.ready.then(
		async () => {
			await meshBeat();
			await syncMeshConfiguration().catch((error) =>
				log("hobo_ci_mesh_config_sync_failed", {
					message: error instanceof Error ? error.message : "unknown",
				}),
			);
		},
		(error) =>
			log("hobo_ci_mesh_nats", {
				status: "failed",
				message: error instanceof Error ? error.message : "unknown",
			}),
	);
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
		plan.admission === "pull"
			? createGithubJobPoller({
					github,
					durations: jobDurations,
					admissionOrder: runtime.admissionOrder,
					ingestCoalesce: pollIngestCoalesce,
					connections: async () =>
						(await store.configuration())?.configuration?.connections ?? [],
					ingest: (delivery) => runtime.ingestWebhook(delivery),
					claim: async (job) => (mesh ? mesh.claim(job) : true),
					onIngestError: (jobId, message) =>
						log("hobo_ci_isolated_worker_job_ingest_failed", {
							jobId,
							message,
						}),
					onGithubError: (failure) =>
						log("hobo_ci_isolated_worker_github_read_failed", { ...failure }),
					beforePoll: () => mergeQueueCache.refresh(),
					onMainFabricTrunkQueued: (repository) => {
						void worker.prewarm(repository).catch((error) =>
							log("hobo_ci_main_fabric_prewarm_failed", {
								repository,
								message: error instanceof Error ? error.message : "unknown",
							}),
						);
					},
				})
			: undefined;
	const pollWorthLogging = createPollLogFilter();

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
		await runtime.tick({ maxDeliveries: poller ? 0 : 10 });
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
				const pruned = (await heldJobPruner?.maybePrune()) ?? 0;
				if (summary.accepted > 0 || pruned > 0)
					void runTick().catch(() => undefined);
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
		publishFleetRoutes,
		workRoot,
		pnpmStoreMounted: pnpmStore !== "",
		pnpmStorePruneIntervalMs,
		gcIntervalMs,
		drainTimeoutMs,
		stopMode,
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
			// Tell the mesh at once: the others stop waiting for this node's turn.
			meshDraining = true;
			if (meshAdvertTimer) clearInterval(meshAdvertTimer);
			await mesh?.advertise();
			// And tell routing: this worker no longer counts towards its labels.
			await publishFleetState({ now: true }).catch(() => undefined);
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
			if (stopMode === "drain" && fleetRoutes) {
				// Leaving for good: nobody will keep the route table current, so
				// every class goes back to its hobo label. A handoff leaves it,
				// because the successor takes over within seconds.
				const state = await store.configuration().catch(() => undefined);
				for (const connection of state?.configuration?.connections ?? [])
					await fleetRoutes.reset({
						installationId: connection.installationId,
						repository: connection.repository,
					});
			}
			await closeStore();
			await Promise.race([
				natsMesh?.close().catch(() => undefined),
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
