import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
/** Box worker: launch isolated-container leases from a local SQLite journal (default) or a shared Postgres relay partition. */
import { toJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema, type Lease, parseConfiguration } from "@hobo/ci";
import {
	attachPostgresPoolErrorHandler,
	boxGitMirrorPath,
	ciEventSinkFromEnv,
	createBoxGitMirror,
	createCiEventEmitter,
	createCliDockerDriver,
	createCompositeIsolatedHost,
	createDepsImageEnsurer,
	createGithubAppTransport,
	createGithubJobPoller,
	createGithubOidcVerifier,
	createHostedRelayRuntime,
	createIsolatedContainerController,
	createJobDurations,
	createMemoryPeaks,
	createNodeWorkerStorageFileSystem,
	createPnpmStoreMaintenance,
	createPollIngestCoalesce,
	createPollLogFilter,
	createRelayTrace,
	createRetiredWorkDirectorySweeper,
	createWorkerMemoryAdmission,
	createWorkerMesh,
	createWorkerStorageAdmission,
	type DepsImageProcessRequest,
	defaultDepsRoot,
	describeWaitingJobs,
	generalLeaseIdsFor,
	type HostedInboxStore,
	type IsolatedWorkerStore,
	isIsolatedContainerOffer,
	memoryRequestForJob,
	meshSettingsFromEnv,
	parseWorkerStopMode,
	readAvailableMemoryMb,
	readHostMemory,
	relayTraceSinkFromEnv,
	resolveWorkerMemoryConfig,
	resolveWorkerSlotConfig,
	resolveWorkerStorePlan,
	singleFlight,
	stopIsolatedWorker,
	traceGithubTransport,
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
const memoryAdmission = createWorkerMemoryAdmission(memoryConfig, {
	log,
	prCapWithTrunk,
	availableMemoryMb: readAvailableMemoryMb,
});
const trunkLend = process.env.HOBO_CI_WORKER_TRUNK_LEND ?? "0";
if (trunkLend !== "0" && trunkLend !== "1")
	throw new Error("invalid HOBO_CI_WORKER_TRUNK_LEND");
const lendTrunkSlots = trunkLend === "1";
const intervalMs = Number(process.env.HOBO_CI_WORKER_POLL_MS ?? "2000");
if (!Number.isFinite(intervalMs) || intervalMs < 1000)
	throw new Error("invalid HOBO_CI_WORKER_POLL_MS");
const drainTimeoutMs = Number(
	process.env.HOBO_CI_WORKER_DRAIN_TIMEOUT_MS ?? "1800000",
);
if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 1_000)
	throw new Error("invalid HOBO_CI_WORKER_DRAIN_TIMEOUT_MS");
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
const budgetAdapter = await loadWorkerBudgetAdapter(
	process.env.HOBO_CI_TRUSTED_BUDGET_ADAPTER,
	plan.store.kind,
);
try {
	if (plan.store.kind === "sqlite") {
		const { SqliteCiStore } = await import("@hobo/ci/sqlite");
		mkdirSync(dirname(plan.store.path), { recursive: true, mode: 0o700 });
		const sqlite = new SqliteCiStore(
			plan.store.path,
			budgetAdapter?.kind === "sqlite"
				? { sharedBudget: budgetAdapter.hooks }
				: {},
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
		closeStore = () => pool.end();
		store = new PostgresCiStore(
			pool,
			"default",
			budgetAdapter?.kind === "postgres"
				? { sharedBudget: budgetAdapter.hooks }
				: {},
		);
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
		createGithubAppTransport({ appId, privateKey }),
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
	const storageAdmission = createWorkerStorageAdmission({
		dockerDataRoot: await docker.dataRoot(),
		workRoot,
		fs: workFs,
		docker,
		activeLeases: async () => storageLeases(await store.activeLeases()),
		scheduleRetiredSweep: retiredSweep.trigger,
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
	await storageAdmission.reap();
	const jobPickupMetadata = new Map<
		string,
		{ event?: string; jobCreatedAt?: string }
	>();
	const gitMirrorRoot =
		process.env.HOBO_CI_GIT_MIRROR_ROOT ?? "/var/lib/hobo-ci/git";
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
	const worker = createIsolatedContainerController({
		store,
		github,
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
		volumes: pnpmStore
			? [{ source: pnpmStore, target: PNPM_STORE_TARGET }]
			: [],
		containerEnv: pnpmStore
			? {
					npm_config_store_dir: PNPM_STORE_TARGET,
					npm_config_package_import_method: "hardlink",
					HOBO_CI_PNPM_STORE_MOUNTED: "1",
				}
			: {},
		workRoot,
		workFs,
		scheduleRetiredSweep: retiredSweep.trigger,
	});
	const firstReconciliation = await worker.reconcileLeases();
	let liveWorkerLeaseIds = firstReconciliation.liveLeaseIds;
	let inUseWorkerMemoryMb = firstReconciliation.inUseMemoryMb;
	await worker.reconcileOrphanJobs();
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
		memoryAdmission,
		storageAdmission,
		control: async () => undefined,
		onTickTiming: (timing) =>
			log("hobo_ci_isolated_worker_tick_slow", {
				...timing,
				workerReconcileMs,
			}),
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
				...natsCredentials(),
			})
		: undefined;
	let meshDraining = false;
	const mesh =
		meshSettings && natsMesh
			? createWorkerMesh({
					settings: meshSettings,
					board: natsMesh.board,
					claims: natsMesh.claims,
					freeSlots: () => slots - liveWorkerLeaseIds.size,
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
												availableMb - memoryConfig.reserveMb,
											),
								),
							),
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
		namespace: meshSettings?.namespace ?? "",
		servers: meshSettings?.servers.length ?? 0,
		stepMs: meshSettings?.stepMs ?? 0,
	});
	// Every 10 s: say what this worker can take, then read what the mesh can.
	const meshBeat = async () => {
		await mesh?.advertise();
		await mesh?.observe();
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
				})
			: undefined;
	const pollWorthLogging = createPollLogFilter();

	let draining = false;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let jobPollTimer: ReturnType<typeof setInterval> | undefined;
	let gcTimer: ReturnType<typeof setInterval> | undefined;
	let tickInFlight: Promise<void> | undefined;
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
		const workerReconcileStartedAt = Date.now();
		const reconciliation = await worker.reconcileLeases();
		workerReconcileMs = Date.now() - workerReconcileStartedAt;
		liveWorkerLeaseIds = reconciliation.liveLeaseIds;
		inUseWorkerMemoryMb = reconciliation.inUseMemoryMb;
		runOrphanJobReconcile();
		if (!reconciliation.inventoryKnown) return;
		// In push mode the hosted relay drains the shared inbox; in pull mode
		// this worker is the only consumer of its own.
		await runtime.tick({ maxDeliveries: poller ? 10 : 0 });
	});

	function runTick(): Promise<void> {
		if (tickInFlight) return tickInFlight;
		if (draining || gcInFlight) return Promise.resolve();
		const current = reconcileAndLaunch();
		const tracked = current.finally(() => {
			if (tickInFlight === tracked) tickInFlight = undefined;
		});
		tickInFlight = tracked;
		return tracked;
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

	gcTimer = setInterval(runGc, gcIntervalMs);
	pollTimer = setInterval(() => {
		void runTick().catch((error) => {
			log("hobo_ci_isolated_worker_tick_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
		});
	}, intervalMs);
	if (poller) {
		runJobPoll();
		jobPollTimer = setInterval(() => {
			runJobPoll();
			runOrphanJobReconcile();
		}, plan.jobPollMs);
	}
	runDepsImageEnsure();

	let shutdownOnce: Promise<void> | undefined;

	async function shutdown(signal: string) {
		if (shutdownOnce) return shutdownOnce;
		shutdownOnce = (async () => {
			draining = true;
			if (pollTimer) clearInterval(pollTimer);
			if (jobPollTimer) clearInterval(jobPollTimer);
			if (depsEnsureTimer) clearTimeout(depsEnsureTimer);
			if (gcTimer) clearInterval(gcTimer);
			await worker.discardWarm().catch(() => undefined);
			log("hobo_ci_isolated_worker_draining", { signal });
			// Tell the mesh at once: the others stop waiting for this node's turn.
			meshDraining = true;
			if (meshAdvertTimer) clearInterval(meshAdvertTimer);
			await mesh?.advertise();
			await jobPollInFlight;
			await orphanReconcileInFlight;
			await gcInFlight;
			if (tickInFlight) {
				await tickInFlight.catch(() => undefined);
			}
			const reconcileDrain = async () => {
				const workerReconcileStartedAt = Date.now();
				const reconciliation = await worker.reconcileLeases({ draining: true });
				workerReconcileMs = Date.now() - workerReconcileStartedAt;
				liveWorkerLeaseIds = reconciliation.liveLeaseIds;
				inUseWorkerMemoryMb = reconciliation.inUseMemoryMb;
				await worker.reconcileOrphanJobs();
				if (reconciliation.inventoryKnown) await runtime.tick({ admit: false });
			};
			const inFlight = async () => liveWorkerLeaseIds.size;
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
			void shutdown(signal);
		});
} catch (error) {
	await closeStore().catch(() => undefined);
	throw error;
}
