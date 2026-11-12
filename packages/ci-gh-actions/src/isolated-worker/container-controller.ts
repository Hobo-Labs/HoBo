import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	ACTIVE_STATES,
	effectiveCiAccount,
	type Job,
	JobSchema,
	type Lease,
	parseCiPolicy,
	route,
} from "@hobo/ci";
import { z } from "zod";
import { runnerDownloadFor } from "../bootstrap.js";
import {
	type GithubTransport,
	getJob,
	listRunWorkflowJobs,
} from "../github.js";
import { heldRoutingOptions } from "../held-routing.js";
import type { HostedRelayStore, IsolatedRunnerHost } from "../hosted-relay.js";
import { isIsolatedContainerOffer } from "../isolated-backend.js";
import {
	clearJitEmptyExit,
	type JitEmptyExitState,
	jitEmptyExitKey,
	jitEmptyExitLaunchBlocked,
	recordJitEmptyExit,
} from "../jit-empty-exit-backoff.js";
import {
	correlateRunnerOnRun,
	resolveRunnerAssignedJob,
	runnerHoldsActiveJob,
} from "../jit-runner-correlation.js";
import { deregisterGithubRunner } from "../jit-runner-deregister.js";
import {
	type JobPickupMetadataCache,
	jobPickupMetadataKey,
} from "../job-pickup.js";
import {
	leaseIdFromBoxRunnerName,
	runnerCustody,
} from "../job-runner-custody.js";
import {
	jitRunnerRegistrationLabels,
	RUNNER_LABEL,
	type RunnerLabel,
} from "../runner-labels.js";
import { adoptRunnerAssignment } from "../runner-lease-adoption.js";
import {
	capIsolatedContainerTimeoutMs,
	ISOLATED_JIT_FOREIGN_MESH_IDLE_MS,
	ISOLATED_JIT_UNASSIGNED_IDLE_MS,
} from "./container-timeout.js";
import {
	containerResourceWeightsForRank,
	type DockerDriver,
} from "./docker-driver.js";
import {
	type ContainerStallGuard,
	hostResourcePressureLogFields,
} from "./host-resource-pressure.js";
import {
	createWorkerLeaseReconciler,
	hasIsolatedStopIntent,
	isUnregisteredDispatchingCreate,
	isUnregisteredUncertainCreate,
	type WorkerLeaseReconciler,
	type WorkerLeaseReconciliationEvent,
} from "./lease-reconciler.js";
import type { WorkerMemoryAdmission } from "./memory-admission.js";
import {
	computeJobMemoryConfig,
	type WorkerMemoryClasses,
} from "./memory-classes.js";
import type { MemoryPeaks } from "./memory-peaks.js";
import {
	createOrphanJobTracker,
	type OrphanJobEvent,
	orphanJobCandidateForLease,
} from "./orphan-jobs.js";
import {
	createStallJobRecovery,
	type StallJobRecoveryEvent,
	stallRecoveryRecordForLease,
} from "./stall-job-recovery.js";
import type { WorkerStorageFileSystem } from "./storage-admission.js";
import type { StoragePeaks } from "./storage-peaks.js";

const JIT_PATH = "/tmp/hobo-ci-jit";
const WORK_TARGET = "/opt/actions-runner/_hobo_work";
/** Written when the one-job JIT runner exits; the container itself keeps running. */
// public-contract: in-container marker path the start script writes and reconcile probes.
export const RUNNER_EXITED_PATH = "/tmp/hobo-ci-runner-exited";
// public-contract: exit code file the JIT runner writes for lease reconciliation.
export const RUNNER_EXIT_CODE_PATH = "/tmp/hobo-ci-runner-exit-code";
// public-contract: human-readable exit summary the JIT runner writes for logs.
export const RUNNER_EXIT_SUMMARY_PATH = "/tmp/hobo-ci-runner-exit-summary";

/** Start the runner with its JIT config delivered over stdin to a 0600 file
 * and handed to the runner via env, so the credential never appears in argv. */
async function readRunnerExitEvidence(
	docker: DockerDriver,
	name: string,
	containerId: string,
): Promise<Readonly<{ runShExit?: number; summary?: string }>> {
	type RunnerExitEvidence = { runShExit?: number; summary?: string };
	const evidence: RunnerExitEvidence = {};
	if (docker.readContainerFile) {
		const codeText = await docker.readContainerFile(
			name,
			containerId,
			RUNNER_EXIT_CODE_PATH,
			16,
		);
		if (codeText !== undefined) {
			const parsed = Number.parseInt(codeText.trim(), 10);
			if (Number.isFinite(parsed)) evidence.runShExit = parsed;
		}
		const summary = await docker.readContainerFile(
			name,
			containerId,
			RUNNER_EXIT_SUMMARY_PATH,
			2048,
		);
		if (summary !== undefined && summary.trim() !== "")
			evidence.summary = summary.trim();
	}
	return evidence;
}

export async function startRunner(
	docker: DockerDriver,
	name: string,
	containerId: string,
	jitConfig: string,
	beforeRun?: () => void,
): Promise<void> {
	// The JIT config is a runner credential: deliver it over stdin into a
	// 0600 file and hand it to the runner via env, never via argv (ps).
	if (!docker.writeSecret)
		throw new Error("docker driver cannot deliver secrets");
	await docker.writeSecret(name, containerId, JIT_PATH, jitConfig);
	beforeRun?.();
	const runJob = docker.execDetached ?? docker.exec;
	const prep = await runJob(name, containerId, [
		"sh",
		"-ec",
		`set -eu
umask 022
if [ -x /opt/actions-runner/run.sh ]; then
  cd /opt/actions-runner
else
  mkdir -m 700 /tmp/hobo-ci && cd /tmp/hobo-ci
  curl -fsSL "$HOBO_CI_RUNNER_URL" -o runner.tar.gz
  printf '%s  runner.tar.gz\\n' "$HOBO_CI_RUNNER_SHA256" | sha256sum --check --status
  mkdir -m 700 runner && tar -xzf runner.tar.gz -C runner
  cd runner
fi
ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat ${JIT_PATH})"
rm -f ${JIT_PATH}
export ACTIONS_RUNNER_INPUT_JITCONFIG
RUNNER_EXIT=0
./run.sh || RUNNER_EXIT=$?
printf '%s\\n' "$RUNNER_EXIT" > ${RUNNER_EXIT_CODE_PATH}
{
  echo "run_sh_exit=$RUNNER_EXIT"
  for d in /opt/actions-runner/_diag ./_diag; do
    if [ -d "$d" ]; then
      echo "diag_dir=$d"
      tail -n 8 "$d"/Runner_*.log 2>/dev/null || true
      break
    fi
  done
} > ${RUNNER_EXIT_SUMMARY_PATH} 2>&1 || true
: > ${RUNNER_EXITED_PATH}`,
	]);
	if (prep.exitCode !== 0) throw new Error("runner start failed");
}

const jitResponse = z.object({
	encoded_jit_config: z.string().min(1),
	runner: z.object({ id: z.number().int().positive() }),
});

function requeueJob(
	lease: {
		jobId: number;
		originalRunId: number;
		runAttempt: number;
		repositoryId: number;
		installationId: number;
		repository: string;
		memoryClass: string;
		memoryMb: number;
	},
	jobLabels?: readonly string[],
) {
	const labels =
		jobLabels && jobLabels.length > 0 ? [...jobLabels] : [RUNNER_LABEL];
	return create(JobSchema, {
		id: lease.jobId,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		repositoryId: lease.repositoryId,
		installationId: lease.installationId,
		repository: lease.repository,
		memoryClass: lease.memoryClass,
		memoryMb: lease.memoryMb,
		labels,
		action: "queued",
		isolatedRequired: true,
	});
}

export type IsolatedContainerController = {
	host: IsolatedRunnerHost;
	reconcileLeases: WorkerLeaseReconciler["reconcile"];
	reconcileOrphanJobs: () => Promise<void>;
	reconcileStallRecoveries: () => Promise<void>;
	ready: () => Promise<boolean>;
	/** Create one idle container ahead of demand so the next launch skips `docker create`/`start`. */
	prewarm: (repository?: string) => Promise<void>;
	/** Remove the idle pre-warmed container (daemon shutdown). */
	discardWarm: () => Promise<void>;
};

const LIVE_CONTAINER_STATES = new Set([
	"dispatching",
	"dispatched",
	"claiming",
	"running",
	"uncertain",
]);

/** What the box worker needs from a lease store; `SqliteCiStore` qualifies. */
export interface IsolatedWorkerStore extends HostedRelayStore {
	settle(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
		completedAt?: string,
	): Promise<Lease | undefined>;
}

type JobImage = Readonly<{ image: string; depsKey?: string }>;
type LaunchStage =
	| "prepare"
	| "image"
	| "create"
	| "start"
	| "transition"
	| "jit"
	| "runner";

class QueueDeadlineExpired extends Error {
	constructor() {
		super("CI queue deadline expired before isolated runner effect");
	}
}

function assertQueueDeadline(lease: Lease, at: string): void {
	if (!lease.queueDeadlineAt) return;
	const deadline = Date.parse(lease.queueDeadlineAt);
	const now = Date.parse(at);
	if (!Number.isFinite(deadline) || !Number.isFinite(now) || deadline <= now)
		throw new QueueDeadlineExpired();
}
type DepsImageFallbackLog = {
	event: "hobo_ci_deps_image_fallback";
	image: string;
	reason: DepsImageFallbackReason;
	message?: string;
};
type DepsImageFallbackReason =
	| "inspect-failed"
	| "unwritable-workdir"
	| "missing-payload"
	| "probe-failed";
const DEPS_IMAGE_PROBE =
	"test -w /opt/actions-runner || exit 3; test -r /opt/hobo-deps/node_modules/.modules.yaml && test -r /opt/hobo-deps/.hobo-ci-deps-key || exit 4";
const probeFailure = (exitCode: number): DepsImageFallbackReason | undefined =>
	exitCode === 0
		? undefined
		: exitCode === 3
			? "unwritable-workdir"
			: exitCode === 4
				? "missing-payload"
				: "probe-failed";
type JobContainerEnvironment = {
	HOBO_CI_DEPS_LAYER?: string;
	HOBO_CI_HOST_JOB_DIRECTORY?: string;
	HOBO_CI_JOB_MEMORY_MB: string;
	NODE_OPTIONS: string;
	HOBO_CI_RELAY_ORIGIN: string;
	HOBO_CI_RUNNER_SHA256: string;
	HOBO_CI_RUNNER_URL: string;
};
type WarmContainer = Readonly<{
	name: string;
	containerId: string;
	memoryMb: number;
	selection: JobImage;
	mirrorPath: string;
}>;
type JitEmptyExitLogFields = {
	jobId: number;
	runId: number;
	runAttempt: number;
	repository: string;
	runnerName: string;
	emptyExitCount: number;
	nextLaunchMs: number;
	githubStatus: string;
	githubRunnerName: string;
	jobLabels: string;
	runShExit?: number;
	runnerDiagTail?: string;
};

type JobPickupLogFields = {
	jobId: number;
	runId: number;
	runEvent?: string;
	label?: string;
	jitLabels?: string;
	jobLabels?: string;
	jobCreatedAt?: string;
	admittedAt?: string;
	containerStartedAt?: string;
	runnerRegisteredAt?: string;
	jobCreatedToAdmittedMs?: number;
	admittedToContainerStartedMs?: number;
	containerStartedToRunnerRegisteredMs?: number;
	pickupMs?: number;
};

export function createIsolatedContainerController(options: {
	store: IsolatedWorkerStore;
	github: GithubTransport;
	publicOrigin: string;
	docker: DockerDriver;
	workerAccountId: string;
	workerImage: string;
	workerMemoryMb?: number;
	prewarmMemoryMb?: number;
	memoryClasses?: WorkerMemoryClasses;
	memoryPeaks?: MemoryPeaks;
	storagePeaks?: StoragePeaks;
	memoryAdmission?: WorkerMemoryAdmission;
	generalLeaseIds?: (
		activeLeases: readonly Lease[],
	) => Promise<ReadonlySet<string>>;
	jobPickupMetadata?: Readonly<JobPickupMetadataCache>;
	/** @internal Test-only shared empty-exit backoff state. */
	jitEmptyExitLoops?: Map<string, JitEmptyExitState>;
	/** Host bare mirror mounted read-only at the same path the job-side probe uses. */
	gitMirror?: {
		pathFor(repository: string): string | undefined;
		ensure?(
			repository: string,
			sha: string,
		): Promise<{ status: "hit" | "miss"; reason?: string; mirror?: string }>;
	};
	headShaFor?(lease: Lease): Promise<string | undefined>;
	log?: (
		event:
			| WorkerLeaseReconciliationEvent
			| OrphanJobEvent
			| "hobo_ci_container_oom"
			| "hobo_ci_container_memory_peak"
			| "hobo_ci_job_pickup"
			| "hobo_ci_launch_failed"
			| "hobo_ci_launch_parked"
			| "hobo_ci_launch_yielded_foreign_runner"
			| "hobo_ci_jit_empty_exit"
			| "hobo_ci_jit_empty_exit_backoff"
			| "hobo_ci_jit_runner_served_other_job"
			| "hobo_ci_jit_runner_custody_transferred"
			| "hobo_ci_jit_idle_listener_release"
			| "hobo_ci_jit_runner_deregistered"
			| "hobo_ci_jit_runner_ghost_released"
			| "hobo_ci_work_dir_retired"
			| "hobo_ci_work_dir_removed"
			| "hobo_ci_work_dir_remove_failed"
			| "hobo_ci_work_dir_inode_breakdown"
			| "hobo_ci_git_mirror"
			| "hobo_ci_deps_toolchain_drift"
			| "hobo_ci_container_stall_requeue"
			| StallJobRecoveryEvent,
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
	now?: () => string;
	/** Grace for a reservation between its journal write and `docker create`. */
	orphanGraceMs?: number;
	/** Drain cap for leases that never reach a live container (default 60s). */
	noContainerDrainMaxMs?: number;
	/** Requeue uncertain leases that never got a container session. */
	uncertainWithoutContainerRecoveryMs?: number;
	/** Max job containers alive at once on this host (default 1: the old serial behaviour). */
	slots?: number;
	/** Shared volumes mounted into every job container (pnpm store). */
	volumes?: readonly Readonly<{ source: string; target: string }>[];
	/** Extra non-secret env for job containers (e.g. npm_config_store_dir). */
	containerEnv?: Readonly<Record<string, string>>;
	workRoot?: string;
	workFs?: WorkerStorageFileSystem;
	scheduleRetiredSweep?: () => void;
	/** Only this repository may use the HoBo deps layer; empty depsImage disables it. */
	depsRepository?: string;
	depsImage?: string;
	/** Release inode/disk admission grant when an isolated lease finishes. */
	onStorageGrantRelease?: (jobId: number) => void;
	/** Cooperative stall recovery while a job container is running. */
	containerStallGuard?: ContainerStallGuard;
}): IsolatedContainerController {
	const now = options.now ?? (() => new Date().toISOString());
	const runnerRegisteredAtMs = new Map<string, number>();
	const orphanJobs = createOrphanJobTracker({
		github: options.github,
		now: () => Date.parse(now()),
		log: (event, fields) => options.log?.(event, fields),
	});
	const stallRecovery = createStallJobRecovery({
		github: options.github,
		now: () => Date.parse(now()),
		log: (event, fields) => options.log?.(event, fields),
	});
	const stallRecoveryLeaseIds = new Set<string>();
	const deregisterLeaseRunner = async (
		lease: Lease,
		reason: string,
	): Promise<void> => {
		if (lease.runnerId <= 0) return;
		const outcome = await deregisterGithubRunner(
			options.github,
			lease.installationId,
			lease.repository,
			lease.runnerId,
		);
		options.log?.("hobo_ci_jit_runner_deregistered", {
			leaseId: lease.id,
			jobId: lease.jobId,
			runnerId: lease.runnerId,
			runnerName: lease.runnerName,
			reason,
			outcome,
		});
	};

	const detectOrphanJob = (lease: Lease) => {
		const candidate = orphanJobCandidateForLease(lease, Date.parse(now()));
		if (candidate) orphanJobs.enqueue(candidate);
	};
	const uncertainWithoutContainerRecoveryMs =
		options.uncertainWithoutContainerRecoveryMs ?? 5 * 60_000;
	const workerMemoryMb = options.workerMemoryMb ?? 8192;
	const classMemoryMb = (
		lease: Readonly<{ memoryClass: string; memoryMb: number }>,
	): number => {
		if (
			options.memoryClasses &&
			(lease.memoryClass === "light" ||
				lease.memoryClass === "standard" ||
				lease.memoryClass === "heavy")
		)
			return options.memoryClasses[lease.memoryClass];
		if (options.memoryClasses) return options.memoryClasses.heavy;
		return lease.memoryMb >= 512 ? lease.memoryMb : workerMemoryMb;
	};
	const slots = options.slots ?? 1;
	if (!Number.isInteger(slots) || slots < 1 || slots > 8)
		throw new Error("invalid worker slots");
	if (
		(options.workRoot === undefined) !== (options.workFs === undefined) ||
		(options.workRoot !== undefined &&
			options.scheduleRetiredSweep === undefined)
	)
		throw new Error("worker work directory configuration incomplete");
	const runner = runnerDownloadFor(process.arch);
	const prewarmMemoryMb = options.prewarmMemoryMb ?? workerMemoryMb;
	const depsRepository = options.depsRepository ?? "Hobo-Labs/HoBo";
	const depsImage = options.depsImage ?? "hobo-ci-deps:local";
	const workerSelection: JobImage = { image: options.workerImage };
	const selectionCache = new Map<string, JobImage>();
	const probeCache = new Map<
		string,
		Promise<DepsImageFallbackReason | undefined>
	>();
	const loggedFailures = new Set<string>();
	const logDepsImageFallback = (
		key: string,
		reason: DepsImageFallbackReason,
		message?: string,
	) => {
		if (loggedFailures.has(key)) return;
		loggedFailures.add(key);
		const fields: DepsImageFallbackLog = {
			event: "hobo_ci_deps_image_fallback",
			image: depsImage,
			reason,
		};
		if (message) fields.message = message;
		console.error(JSON.stringify(fields));
	};
	const probeDepsImage = (
		imageId: string,
	): Promise<DepsImageFallbackReason | undefined> => {
		const cached = probeCache.get(imageId);
		if (cached) return cached;
		const probe = options.docker.probeImage;
		const result = probe
			? probe(depsImage, ["sh", "-c", DEPS_IMAGE_PROBE], "1000:1000").then(
					({ exitCode }) => probeFailure(exitCode),
					(): DepsImageFallbackReason => "probe-failed",
				)
			: Promise.resolve<DepsImageFallbackReason>("probe-failed");
		probeCache.set(imageId, result);
		return result;
	};
	const selectImage = async (repository: string): Promise<JobImage> => {
		const inspect = options.docker.inspectImage;
		if (
			!depsImage ||
			repository.toLowerCase() !== depsRepository.toLowerCase() ||
			!inspect
		)
			return workerSelection;
		try {
			const worker = await inspect(options.workerImage);
			const deps = await inspect(depsImage);
			const cacheKey = `${worker.id}\0${deps.id}`;
			const cached = selectionCache.get(cacheKey);
			if (cached) return cached;
			const toolchain = worker.repoTags
				.map((tag) => tag.match(/^hobo-ci-worker:(v[0-9a-f]{12})$/)?.[1])
				.find((tag) => tag !== undefined);
			const depsKey = deps.labels["hobo.ci.deps-key"];
			const depsToolchain = deps.labels["hobo.ci.toolchain"];
			const candidate = depsKey ? { image: depsImage, depsKey } : undefined;
			let selection = workerSelection;
			if (candidate) {
				if (toolchain && depsToolchain && depsToolchain !== toolchain) {
					options.log?.("hobo_ci_deps_toolchain_drift", {
						workerToolchain: toolchain,
						depsToolchain: depsToolchain ?? "none",
						depsKey: depsKey ?? "none",
					});
				}
				const failure = await probeDepsImage(deps.id);
				if (failure) logDepsImageFallback(deps.id, failure);
				else selection = candidate;
			}
			selectionCache.set(cacheKey, selection);
			loggedFailures.delete(depsImage);
			return selection;
		} catch (error) {
			logDepsImageFallback(
				depsImage,
				"inspect-failed",
				error instanceof Error ? error.message : "unknown",
			);
			return workerSelection;
		}
	};
	type GitMirrorMount = {
		volumes: readonly Readonly<{
			source: string;
			target: string;
			readonly?: boolean;
		}>[];
		env: Record<string, string>;
	};
	type GitMirrorLogFields = {
		status: "hit" | "miss";
		repository: string;
		mirror?: string;
		reason?: string;
	};
	const gitMirrorMount = (repository: string | undefined): GitMirrorMount => {
		const path =
			repository && options.gitMirror
				? options.gitMirror.pathFor(repository)
				: undefined;
		if (!path || !existsSync(path))
			return {
				volumes: [],
				env: {},
			};
		return {
			volumes: [{ source: path, target: path, readonly: true }],
			env: { HOBO_CI_GIT_MIRROR: path },
		};
	};
	const containerSpec = (
		name: string,
		timeoutMs: number,
		memoryMb: number,
		selection: JobImage,
		rank: number,
		jobDirectory?: string,
		repository?: string,
	) => {
		const memory = computeJobMemoryConfig({
			limitMb: memoryMb,
			cpuCount: availableParallelism(),
		});
		const mirror = gitMirrorMount(repository);
		const env: JobContainerEnvironment = {
			...options.containerEnv,
			...mirror.env,
			HOBO_CI_JOB_MEMORY_MB: String(memoryMb),
			NODE_OPTIONS: `--max-old-space-size=${memory.heapMb}`,
			HOBO_CI_RELAY_ORIGIN: options.publicOrigin,
			HOBO_CI_RUNNER_SHA256: runner.sha256,
			HOBO_CI_RUNNER_URL: runner.url,
		};
		if (selection.depsKey) env.HOBO_CI_DEPS_LAYER = selection.depsKey;
		if (jobDirectory) env.HOBO_CI_HOST_JOB_DIRECTORY = jobDirectory;
		return {
			name,
			image: selection.image,
			timeoutMs: capIsolatedContainerTimeoutMs(timeoutMs),
			runAsUser: "1000:1000",
			memoryMb,
			...containerResourceWeightsForRank(rank),
			volumes: [
				...(options.volumes ?? []),
				...mirror.volumes,
				...(jobDirectory
					? [{ source: jobDirectory, target: WORK_TARGET }]
					: []),
			],
			env,
			command: ["sleep", "infinity"],
		};
	};
	const workDirectory = (leaseId: string) =>
		options.workRoot ? join(options.workRoot, `hobo-${leaseId}`) : undefined;
	const cleanupWorkDirectory = async (lease: Lease) => {
		const directory = workDirectory(lease.id);
		if (!directory || !options.workFs || !options.scheduleRetiredSweep) return;
		const containerName = lease.sandboxName || `hobo-${lease.id}`;
		if (
			options.docker.containerExists &&
			(await options.docker.containerExists(containerName))
		)
			return;
		if (lease.runnerName) {
			try {
				const assignment = await resolveRunnerAssignedJob(
					options.github,
					lease.installationId,
					lease.repository,
					lease.runnerName,
					lease.runnerId,
					{
						reservedJobId: lease.jobId,
						preferRunIds: [lease.originalRunId],
					},
				);
				if (runnerHoldsActiveJob(assignment)) return;
			} catch {
				// Fall through when assignment cannot be resolved.
			}
		}
		try {
			if (options.workFs.measureJobDirectory && lease.jobName) {
				const measured = await options.workFs.measureJobDirectory(directory);
				if (measured.inodeBreakdown) {
					options.log?.("hobo_ci_work_dir_inode_breakdown", {
						jobId: lease.jobId,
						leaseId: lease.id,
						jobName: lease.jobName,
						...measured.inodeBreakdown,
					});
				}
				const workRootInodes = measured.localInodes ?? measured.entries;
				options.storagePeaks?.record(lease.jobName, {
					workRootBytes: measured.bytes,
					workRootInodes,
				});
			}
		} catch {
			// Peak measurement must not block teardown.
		}
		const startedAt = Date.now();
		try {
			const retired = await options.workFs.retireJobDirectory(directory);
			if (retired)
				options.log?.("hobo_ci_work_dir_retired", {
					jobId: lease.jobId,
					leaseId: lease.id,
					ms: Date.now() - startedAt,
				});
		} catch (error) {
			options.log?.("hobo_ci_work_dir_remove_failed", {
				jobId: lease.jobId,
				leaseId: lease.id,
				message: error instanceof Error ? error.message : "unknown",
			});
		} finally {
			options.scheduleRetiredSweep();
		}
	};
	let warm: WarmContainer | undefined;
	let warming: Promise<void> | undefined;
	const protectedWarmNames = new Set<string>();
	const inFlightLaunchIds = new Set<string>();
	const liveContainers = async (except: string) =>
		(await options.store.activeLeases()).filter(
			(lease) =>
				lease.id !== except &&
				(lease.provider === "kubernetes" ||
					lease.provider === "hobo-box-worker") &&
				LIVE_CONTAINER_STATES.has(lease.state),
		).length;
	const prewarm = async (repository?: string) => {
		if (
			warm ||
			warming ||
			!options.docker.rename ||
			!options.docker.updateResources ||
			options.workRoot
		)
			return;
		warming = (async () => {
			let reserved = false;
			const activeLeases =
				options.memoryAdmission || !repository
					? await options.store.activeLeases()
					: [];
			if (options.memoryAdmission) {
				const generalLeaseIds = options.generalLeaseIds
					? await options.generalLeaseIds(activeLeases)
					: new Set<string>();
				reserved = options.memoryAdmission.reserveWarm(
					activeLeases,
					prewarmMemoryMb,
					generalLeaseIds,
				);
				if (!reserved) return;
			}
			const name = `hobo-warm-${Date.now().toString(36)}`;
			protectedWarmNames.add(name);
			try {
				const next = repository
					? undefined
					: activeLeases.find((lease) => lease.state === "reserved");
				const selectedRepository =
					repository ?? next?.repository ?? depsRepository;
				const selection = await selectImage(selectedRepository);
				const mirrorPath =
					gitMirrorMount(selectedRepository).env.HOBO_CI_GIT_MIRROR ?? "";
				const handle = await options.docker.create(
					containerSpec(
						name,
						6 * 60 * 60_000,
						prewarmMemoryMb,
						selection,
						1,
						undefined,
						selectedRepository,
					),
				);
				try {
					await options.docker.start(name, handle.containerId);
					warm = {
						...handle,
						memoryMb: prewarmMemoryMb,
						selection,
						mirrorPath,
					};
				} catch {
					await options.docker
						.remove(name, handle.containerId)
						.catch(() => undefined);
				}
			} catch (error) {
				if (reserved) options.memoryAdmission?.releaseWarm(prewarmMemoryMb);
				throw error;
			} finally {
				if (!warm || warm.name !== name) protectedWarmNames.delete(name);
			}
			if (reserved && !warm)
				options.memoryAdmission?.releaseWarm(prewarmMemoryMb);
		})().finally(() => {
			warming = undefined;
		});
		await warming;
	};
	const authorize = async (leaseId: string) => {
		const lease = await options.store.get(leaseId);
		if (!lease?.state || lease.state === "completed")
			throw new Error("lease missing");
		const snapshot = await options.store.policySnapshot();
		const configuration = snapshot.state?.configuration;
		if (!configuration || !snapshot.state)
			throw new Error("configuration unavailable");
		const connection = configuration.connections.find(
			(entry) =>
				entry.accountId === lease.accountId &&
				entry.repositoryId === lease.repositoryId &&
				entry.installationId === lease.installationId &&
				entry.repository.toLowerCase() === lease.repository.toLowerCase(),
		);
		const original = configuration.accounts.find(
			(entry) => entry.id === lease.accountId,
		);
		if (
			!connection?.isolatedOnly ||
			!connection.acceptAllMatchingRepositoryJobs ||
			!connection.publicRepositoryAcknowledged ||
			connection.allowAllPullRequests ||
			connection.allowedEvents.length !== 0 ||
			connection.allowedRefs.length !== 0 ||
			!original
		)
			throw new Error("worker binding unavailable");
		const desired = snapshot.policies.find(
			(entry) => entry.accountId === lease.accountId,
		);
		const account = desired
			? effectiveCiAccount(original, parseCiPolicy(desired.bodyJson))
			: original;
		const offer = account.offers.find((entry) => entry.id === lease.offerId);
		if (
			!offer ||
			!isIsolatedContainerOffer(offer) ||
			offer.providerAccountId !== options.workerAccountId ||
			offer.priceMicrosPerMinute !== 0 ||
			offer.freeMinutes !== 0 ||
			account.maxRuntimeMinutes + account.startupMinutes !==
				lease.reservedMinutes
		)
			throw new Error("worker offer changed");
		const at = now();
		const decision = route(
			{
				...account,
				offers: account.offers.map((entry) => ({
					...entry,
					enabled: entry.enabled && isIsolatedContainerOffer(entry),
				})),
			},
			(await options.store.accountLeases(lease.accountId)).filter(
				(entry) => entry.id !== lease.id,
			),
			at,
			heldRoutingOptions(account, lease, at),
		);
		if (
			!decision ||
			decision.offer.id !== offer.id ||
			decision.paidMicros > lease.reservedPaidMicros
		)
			throw new Error("worker quote unavailable or changed");
		return { revision: snapshot.state.revision, connection, lease };
	};

	const launchFailureWindowMs = 30 * 60_000;
	const launchParkMs = 10 * 60_000;
	type LaunchFailure = Readonly<{
		atMs: number;
		stage: LaunchStage;
		message: string;
	}>;
	type LaunchLoopState = {
		failures: LaunchFailure[];
		parkedAtMs?: number;
	};
	const launchLoops = new Map<string, LaunchLoopState>();
	const emptyExitLoops =
		options.jitEmptyExitLoops ?? new Map<string, JitEmptyExitState>();
	const pendingExitEvidence = new Map<
		string,
		Awaited<ReturnType<typeof readRunnerExitEvidence>>
	>();
	/** Backoff recorded at exit-marker so settle/stop cannot release a slot first. */
	const eagerEmptyExitBackoff = new Set<string>();
	const launchKey = (repositoryId: number, jobId: number, runAttempt: number) =>
		`${repositoryId}:${jobId}:${runAttempt}`;
	const logLaunch = (
		event: "hobo_ci_launch_failed" | "hobo_ci_launch_parked",
		fields: Readonly<Record<string, string | number | boolean>>,
	) => {
		if (options.log) options.log(event, fields);
		else console.error(JSON.stringify({ event, ...fields }));
	};
	const failLaunch = async (lease: Lease, stage: LaunchStage, error: Error) => {
		const at = now();
		const atMs = Date.parse(at);
		const key = launchKey(lease.repositoryId, lease.jobId, lease.runAttempt);
		const previous = launchLoops.get(key);
		const failures = (previous?.failures ?? []).filter(
			(failure) => atMs - failure.atMs <= launchFailureWindowMs,
		);
		const message = error.message;
		failures.push({ atMs, stage, message });
		const state: LaunchLoopState = { failures };
		if (previous?.parkedAtMs !== undefined)
			state.parkedAtMs = previous.parkedAtMs;
		const attempt = failures.length;
		const newlyParked = attempt >= 3 && state.parkedAtMs === undefined;
		if (newlyParked) state.parkedAtMs = atMs;
		launchLoops.set(key, state);
		logLaunch("hobo_ci_launch_failed", {
			stage,
			message,
			leaseId: lease.id,
			jobId: lease.jobId,
			actualJobId: lease.actualJobId,
			attempt,
		});
		if (newlyParked)
			logLaunch("hobo_ci_launch_parked", {
				stage,
				message,
				leaseId: lease.id,
				jobId: lease.jobId,
				actualJobId: lease.actualJobId,
				attempt,
				failureCount: attempt,
				parkMs: launchParkMs,
				windowMs: launchFailureWindowMs,
			});
		try {
			if (state.parkedAtMs === undefined) {
				await options.store.abortIsolatedAndRequeue(
					lease.id,
					requeueJob(lease),
					at,
				);
			} else {
				const cancelled = await options.store.transition(
					lease.id,
					[
						"reserved",
						"dispatching",
						"dispatched",
						"claiming",
						"running",
						"uncertain",
					],
					(entry) => {
						entry.state = "cancelled";
					},
					"ci.LeaseCancelled",
					at,
				);
				if (!cancelled)
					await options.store.abortIsolatedAndRequeue(
						lease.id,
						requeueJob(lease),
						at,
					);
			}
		} finally {
			await cleanupWorkDirectory(lease);
		}
	};

	const measureMemoryPeak = async (lease: Lease): Promise<void> => {
		try {
			const peakMb = await options.docker.memoryPeak?.(
				lease.sandboxName,
				lease.sandboxSessionId,
			);
			if (peakMb === undefined) return;
			options.log?.("hobo_ci_container_memory_peak", {
				jobId: lease.jobId,
				jobName: lease.jobName,
				memoryClass: lease.memoryClass || "heavy",
				limitMb: classMemoryMb(lease),
				reservedMb:
					lease.memoryMb >= 512 ? lease.memoryMb : classMemoryMb(lease),
				peakMb,
			});
			if (peakMb > 0) options.memoryPeaks?.record(lease.jobName, peakMb);
		} catch {
			return;
		}
	};

	// A durable stop intent precedes the effect because Docker's --rm may remove
	// the container before the caller receives the stop acknowledgement.
	const markStopRequested = async (lease: Lease) => {
		if (hasIsolatedStopIntent(lease)) return lease;
		const at = now();
		const updated = await options.store.transition(
			lease.id,
			[lease.state],
			(entry) => {
				if (
					!LIVE_CONTAINER_STATES.has(entry.state) ||
					entry.sandboxName !== lease.sandboxName ||
					entry.sandboxSessionId !== lease.sandboxSessionId ||
					!entry.sandboxSessionId ||
					entry.usageCompletedAt
				)
					throw new Error("isolated session changed before stop");
				entry.sandboxStage = "stopping";
			},
			"ci.SandboxStopRequested",
			at,
		);
		if (!updated) throw new Error("lease changed before stop");
		return updated;
	};

	const isolatedSessionPresent = async (lease: Lease): Promise<boolean> => {
		if (!options.docker.list) throw new Error("isolated inventory unavailable");
		const matches = (await options.docker.list("hobo.ci/isolated=1")).filter(
			(container) =>
				container.name === lease.sandboxName ||
				container.containerId === lease.sandboxSessionId,
		);
		if (
			matches.length > 1 ||
			(matches.length === 1 &&
				(matches[0]?.name !== lease.sandboxName ||
					matches[0]?.containerId !== lease.sandboxSessionId))
		)
			throw new Error("isolated session identity changed");
		return matches.length === 1;
	};

	// A durable stop marker keeps the financial hold if final GitHub observation
	// fails after the container has been removed. Removal time is recorded only
	// after removal is confirmed; a later recovery time is conservative.
	const markStopped = async (lease: Lease, removalConfirmed: boolean) => {
		if (
			lease.sandboxStage === "stopped" &&
			(!removalConfirmed || lease.usageCompletedAt)
		)
			return lease;
		const at = now();
		const updated = await options.store.transition(
			lease.id,
			[lease.state],
			(entry) => {
				if (
					!LIVE_CONTAINER_STATES.has(entry.state) ||
					entry.sandboxName !== lease.sandboxName ||
					entry.sandboxSessionId !== lease.sandboxSessionId ||
					!entry.sandboxSessionId
				)
					throw new Error("isolated session changed during stop");
				if (entry.sandboxStage !== "stopped") {
					if (removalConfirmed) throw new Error("stop was not recorded");
					if (entry.usageCompletedAt)
						throw new Error("existing usage completion cannot be replaced");
					entry.sandboxStage = "stopped";
				}
				if (removalConfirmed && !entry.usageCompletedAt)
					entry.usageCompletedAt = at;
			},
			removalConfirmed ? "ci.SandboxRemoved" : "ci.SandboxStopped",
			at,
		);
		if (!updated) throw new Error("lease changed during stop");
		return updated;
	};

	const settleStopped = async (lease: Lease): Promise<void> => {
		// Shared-budget settlement without final provider evidence deliberately
		// leaves an estimated liability uncertain. Do not repeatedly settle and
		// requeue it while waiting for the separate evidence reconciliation.
		if (
			lease.state === "uncertain" &&
			lease.usageProvenance === "estimated" &&
			lease.settledAt &&
			lease.usageCompletedAt
		)
			return;
		const completedAt =
			lease.usageCompletedAt || (lease.pipelineId ? now() : "");
		const completedMs = Date.parse(completedAt);
		const createdMs = Date.parse(lease.createdAt);
		const observedAt = now();
		const observedMs = Date.parse(observedAt);
		if (
			!Number.isFinite(completedMs) ||
			!Number.isFinite(createdMs) ||
			!Number.isFinite(observedMs) ||
			completedMs < createdMs ||
			completedMs > observedMs + 5_000
		)
			throw new Error("invalid isolated stop time");
		if (lease.runnerName) {
			try {
				let assignment = await resolveRunnerAssignedJob(
					options.github,
					lease.installationId,
					lease.repository,
					lease.runnerName,
					lease.runnerId,
					{
						reservedJobId: lease.jobId,
						preferRunIds: [lease.originalRunId],
					},
				);
				if (runnerHoldsActiveJob(assignment)) {
					await deregisterLeaseRunner(lease, "dead-container-active-binding");
					assignment = await resolveRunnerAssignedJob(
						options.github,
						lease.installationId,
						lease.repository,
						lease.runnerName,
						lease.runnerId,
						{
							reservedJobId: lease.jobId,
							preferRunIds: [lease.originalRunId],
						},
					);
					if (runnerHoldsActiveJob(assignment)) return;
				}
			} catch {
				// Fall through to getJob when assignment cannot be resolved.
			}
		}
		const servedJobId = lease.actualJobId > 0 ? lease.actualJobId : lease.jobId;
		const original = await getJob(
			options.github,
			lease.installationId,
			lease.repository,
			servedJobId,
		);
		const custody = runnerCustody(original.runner_name);
		const emptyKey = jitEmptyExitKey(
			lease.repositoryId,
			lease.jobId,
			lease.runAttempt,
		);
		if (original.status !== "queued")
			clearJitEmptyExit(emptyExitLoops, emptyKey);
		// Fleet mesh: another `hobo` runner may hold the job; withdraw instead of re-admitting.
		// Empty JIT exit: job still queued on GitHub — withdraw local demand; poll re-ingest later.
		const emptyJitExit = original.status === "queued" && custody !== "foreign";
		const unmet: ReturnType<typeof requeueJob> | undefined = undefined;
		if (original.status === "queued" && custody === "foreign") {
			await options.store.withdrawQueuedJob?.(
				requeueJob(lease, original.labels),
				observedAt,
			);
			clearJitEmptyExit(emptyExitLoops, emptyKey);
		} else if (emptyJitExit) {
			await options.store.withdrawQueuedJob?.(
				requeueJob(lease, original.labels),
				observedAt,
				undefined,
				lease.id,
			);
			let penalizeBackoff = true;
			if (lease.runnerId > 0 || lease.runnerName) {
				try {
					const runJobs = await listRunWorkflowJobs(
						options.github,
						lease.installationId,
						lease.repository,
						lease.originalRunId,
					);
					const correlation = correlateRunnerOnRun(
						runJobs,
						lease.jobId,
						lease.runnerName,
						lease.runnerId,
					);
					if (correlation.kind === "served-other") {
						penalizeBackoff = false;
						clearJitEmptyExit(emptyExitLoops, emptyKey);
						options.log?.("hobo_ci_jit_runner_served_other_job", {
							reservedJobId: lease.jobId,
							servedJobId: correlation.jobId,
							servedStatus: correlation.status,
							runId: lease.originalRunId,
							runAttempt: lease.runAttempt,
							runnerName: lease.runnerName,
							runnerId: lease.runnerId,
						});
					}
				} catch {
					/* correlation is best-effort; empty-exit backoff stays conservative */
				}
			}
			const evidence = pendingExitEvidence.get(lease.id) ?? {};
			pendingExitEvidence.delete(lease.id);
			eagerEmptyExitBackoff.delete(lease.id);
			if (penalizeBackoff) {
				const empty =
					emptyExitLoops.get(emptyKey) ??
					recordJitEmptyExit(emptyExitLoops, emptyKey, observedMs);
				const emptyExitLog: JitEmptyExitLogFields = {
					jobId: lease.jobId,
					runId: lease.originalRunId,
					runAttempt: lease.runAttempt,
					repository: lease.repository,
					runnerName: lease.runnerName,
					emptyExitCount: empty.count,
					nextLaunchMs: empty.nextLaunchMs,
					githubStatus: original.status,
					githubRunnerName: original.runner_name ?? "",
					jobLabels: original.labels.join(","),
				};
				if (evidence.runShExit !== undefined)
					emptyExitLog.runShExit = evidence.runShExit;
				if (evidence.summary !== undefined)
					emptyExitLog.runnerDiagTail = evidence.summary;
				options.log?.("hobo_ci_jit_empty_exit", emptyExitLog);
			}
		}
		await deregisterLeaseRunner(lease, "lease-settle");
		await options.store.settle(
			lease.id,
			0,
			Math.max(1, Math.ceil((completedMs - createdMs) / 60_000)),
			observedAt,
			unmet,
			completedAt,
		);
		options.onStorageGrantRelease?.(lease.jobId);
	};

	const host: IsolatedRunnerHost = {
		async isLaunchParked(job: Job) {
			const key = launchKey(job.repositoryId, job.id, job.runAttempt);
			const emptyKey = jitEmptyExitKey(
				job.repositoryId,
				job.id,
				job.runAttempt,
			);
			const emptyBlocked = jitEmptyExitLaunchBlocked(
				emptyExitLoops,
				emptyKey,
				Date.parse(now()),
			);
			if (emptyBlocked) {
				options.log?.("hobo_ci_jit_empty_exit_backoff", {
					jobId: job.id,
					runId: job.runId,
					runAttempt: job.runAttempt,
					emptyExitCount: emptyBlocked.count,
					nextLaunchMs: emptyBlocked.nextLaunchMs,
					waitMs: emptyBlocked.nextLaunchMs - Date.parse(now()),
				});
				return true;
			}
			const state = launchLoops.get(key);
			if (state?.parkedAtMs === undefined) return false;
			if (Date.parse(now()) - state.parkedAtMs >= launchParkMs) {
				launchLoops.delete(key);
				return false;
			}
			try {
				const current = await getJob(
					options.github,
					job.installationId,
					job.repository,
					job.id,
				);
				if (
					current.status !== "queued" ||
					current.run_id !== job.runId ||
					current.run_attempt !== job.runAttempt
				) {
					launchLoops.delete(key);
					return false;
				}
			} catch {
				return true;
			}
			return true;
		},
		async launch(id: string, label: RunnerLabel = RUNNER_LABEL, rank = 1) {
			inFlightLaunchIds.add(id);
			try {
				const weights = containerResourceWeightsForRank(rank);
				const initial = await options.store.get(id);
				if (initial?.state !== "reserved") return;
				const emptyBlocked = jitEmptyExitLaunchBlocked(
					emptyExitLoops,
					jitEmptyExitKey(
						initial.repositoryId,
						initial.jobId,
						initial.runAttempt,
					),
					Date.parse(now()),
				);
				if (emptyBlocked) {
					options.log?.("hobo_ci_jit_empty_exit_backoff", {
						jobId: initial.jobId,
						runId: initial.originalRunId,
						runAttempt: initial.runAttempt,
						emptyExitCount: emptyBlocked.count,
						nextLaunchMs: emptyBlocked.nextLaunchMs,
						waitMs: emptyBlocked.nextLaunchMs - Date.parse(now()),
						stage: "launch",
					});
					return;
				}
				// Slot full: leave the lease reserved; the next relay tick retries it.
				if ((await liveContainers(id)) >= slots) return;
				let auth: Awaited<ReturnType<typeof authorize>>;
				try {
					auth = await authorize(id);
				} catch (error) {
					await failLaunch(
						initial,
						"prepare",
						error instanceof Error ? error : new Error("unknown"),
					);
					return;
				}
				const name = `hobo-${id}`;
				let planned: Lease;
				try {
					const transitioned = await options.store.transition(
						id,
						["reserved"],
						(lease) => {
							if (lease.sandboxName || lease.runnerId || lease.hostRunId)
								throw new Error("lease already launched");
							lease.sandboxName = name;
							lease.sandboxStage = "creating";
							lease.state = "dispatching";
						},
						"ci.DispatchRequested",
						now(),
						auth.revision,
					);
					if (!transitioned) return;
					planned = transitioned;
				} catch (error) {
					await failLaunch(
						initial,
						"transition",
						error instanceof Error ? error : new Error("unknown"),
					);
					return;
				}
				let containerId = "";
				let containerStartedAt = "";
				let createInFlight = false;
				let registrationAttempted = false;
				const memoryMb = classMemoryMb(planned);
				let stage: LaunchStage = "image";
				try {
					const selection = await selectImage(planned.repository);
					stage = "prepare";
					const directory = workDirectory(id);
					if (directory && options.workFs)
						await options.workFs.prepareJobDirectory(directory);
					const sha = await options.headShaFor?.(planned);
					if (sha && options.gitMirror?.ensure) {
						try {
							const resolved = await options.gitMirror.ensure(
								planned.repository,
								sha,
							);
							const fields: GitMirrorLogFields = {
								status: resolved.status,
								repository: planned.repository,
							};
							if (resolved.mirror) fields.mirror = resolved.mirror;
							if (resolved.reason) fields.reason = resolved.reason;
							options.log?.("hobo_ci_git_mirror", fields);
						} catch (error) {
							options.log?.("hobo_ci_git_mirror", {
								status: "miss",
								repository: planned.repository,
								reason: error instanceof Error ? error.message : "unknown",
							});
						}
					}
					assertQueueDeadline(planned, now());
					stage = "create";
					const spare = warm?.memoryMb === memoryMb ? warm : undefined;
					const mirrorPath =
						gitMirrorMount(planned.repository).env.HOBO_CI_GIT_MIRROR ?? "";
					const spareMatches =
						spare?.selection.image === selection.image &&
						spare.selection.depsKey === selection.depsKey &&
						spare.mirrorPath === mirrorPath;
					if (
						spare &&
						spareMatches &&
						options.docker.rename &&
						options.docker.updateResources
					) {
						warm = undefined;
						protectedWarmNames.delete(spare.name);
						options.memoryAdmission?.consumeWarm(spare.memoryMb);
						containerId = spare.containerId;
						await options.docker.updateResources(spare.containerId, weights);
						assertQueueDeadline(planned, now());
						await options.docker.rename(spare.containerId, name);
					} else {
						createInFlight = true;
						const handle = await options.docker.create(
							containerSpec(
								name,
								planned.reservedMinutes * 60_000,
								memoryMb,
								selection,
								rank,
								directory,
								planned.repository,
							),
						);
						if (handle.name !== name)
							throw new Error("container identity mismatch");
						createInFlight = false;
						containerId = handle.containerId;
						stage = "start";
						assertQueueDeadline(planned, now());
						await options.docker.start(name, containerId);
					}
					containerStartedAt = now();
					stage = "transition";
					const created = await options.store.transition(
						id,
						["dispatching"],
						(lease) => {
							if (lease.sandboxName !== name || lease.sandboxSessionId)
								throw new Error("container state mismatch");
							lease.sandboxSessionId = containerId;
							lease.sandboxStage = "created";
							lease.state = "dispatched";
						},
						"ci.SandboxCreated",
						containerStartedAt,
					);
					if (!created) throw new Error("reservation changed");
					const claiming = await options.store.transition(
						id,
						["dispatched"],
						(lease) => {
							if (lease.sandboxSessionId !== containerId || lease.runnerId)
								throw new Error("container state mismatch");
							lease.sandboxStage = "registering";
							lease.state = "claiming";
						},
						"ci.RunnerClaimed",
						now(),
						auth.revision,
					);
					if (!claiming)
						throw new Error("reservation changed before runner registration");
					let githubJob: Awaited<ReturnType<typeof getJob>> | undefined;
					try {
						githubJob = await getJob(
							options.github,
							claiming.installationId,
							claiming.repository,
							claiming.actualJobId > 0 ? claiming.actualJobId : claiming.jobId,
						);
					} catch {
						/* registration may still fail closed into uncertain */
					}
					const custody = runnerCustody(githubJob?.runner_name);
					if (
						githubJob &&
						(custody === "foreign" ||
							(githubJob.status === "in_progress" &&
								githubJob.runner_name &&
								githubJob.runner_name !== claiming.runnerName))
					) {
						options.log?.("hobo_ci_launch_yielded_foreign_runner", {
							jobId: claiming.jobId,
							runId: claiming.originalRunId,
							runnerName: githubJob.runner_name ?? "",
							status: githubJob.status,
						});
						try {
							await options.docker.stop(name, containerId);
							await options.docker.remove(name, containerId);
						} catch {
							/* recovery tick retries */
						}
						await options.store.withdrawQueuedJob?.(
							requeueJob(claiming),
							now(),
							auth.revision,
						);
						await options.store.transition(
							id,
							["claiming"],
							(entry) => {
								entry.state = "cancelled";
							},
							"ci.LeaseCancelled",
							now(),
							auth.revision,
						);
						launchLoops.delete(
							launchKey(
								claiming.repositoryId,
								claiming.jobId,
								claiming.runAttempt,
							),
						);
						return;
					}
					stage = "jit";
					assertQueueDeadline(planned, now());
					registrationAttempted = true;
					let jobLabels = githubJob?.labels;
					if (!jobLabels?.length) {
						try {
							jobLabels = (
								await getJob(
									options.github,
									claiming.installationId,
									claiming.repository,
									claiming.actualJobId > 0
										? claiming.actualJobId
										: claiming.jobId,
								)
							).labels;
						} catch {
							/* best effort */
						}
					}
					const jitLabels = jitRunnerRegistrationLabels(jobLabels, label);
					const response = await options.github.request(
						created.installationId,
						`/repos/${created.repository}/actions/runners/generate-jitconfig`,
						"POST",
						JSON.stringify({
							name: created.runnerName,
							runner_group_id: auth.connection.runnerGroupId,
							labels: jitLabels,
							work_folder: "_hobo_work",
						}),
					);
					if (response.status !== 201)
						throw new Error("runner registration failed");
					const jit = jitResponse.parse(await response.json());
					try {
						assertQueueDeadline(planned, now());
					} catch (error) {
						if (error instanceof QueueDeadlineExpired)
							await options.store.transition(
								id,
								["claiming"],
								(lease) => {
									lease.runnerId = jit.runner.id;
									lease.state = "uncertain";
								},
								"ci.LeaseUncertain",
								now(),
							);
						throw error;
					}
					stage = "transition";
					const runnerRegisteredAt = now();
					const registered = await options.store.transition(
						id,
						["claiming"],
						(lease) => {
							if (lease.sandboxSessionId !== containerId)
								throw new Error("container changed");
							lease.runnerId = jit.runner.id;
							lease.sandboxStage = "running";
							lease.state = "running";
						},
						"ci.RunnerRegistered",
						runnerRegisteredAt,
					);
					if (!registered) throw new Error("registration revoked");
					runnerRegisteredAtMs.set(id, Date.parse(runnerRegisteredAt));
					assertQueueDeadline(planned, now());
					const fields: JobPickupLogFields = {
						jobId: registered.jobId,
						runId: registered.originalRunId,
					};
					const metadata = options.jobPickupMetadata?.get(
						jobPickupMetadataKey({
							repositoryId: registered.repositoryId,
							id: registered.jobId,
							runAttempt: registered.runAttempt,
						}),
					);
					if (metadata?.event !== undefined) fields.runEvent = metadata.event;
					fields.label = label;
					fields.jitLabels = jitLabels.join(",");
					fields.jobLabels = (jobLabels ?? []).join(",");
					if (metadata?.jobCreatedAt !== undefined)
						fields.jobCreatedAt = metadata.jobCreatedAt;
					fields.admittedAt = registered.createdAt;
					fields.containerStartedAt = containerStartedAt;
					fields.runnerRegisteredAt = runnerRegisteredAt;
					const jobCreatedMs = Date.parse(metadata?.jobCreatedAt ?? "");
					const admittedMs = Date.parse(registered.createdAt);
					const containerStartedMs = Date.parse(containerStartedAt);
					const runnerRegisteredMs = Date.parse(runnerRegisteredAt);
					if (Number.isFinite(jobCreatedMs))
						fields.jobCreatedToAdmittedMs = admittedMs - jobCreatedMs;
					fields.admittedToContainerStartedMs = containerStartedMs - admittedMs;
					fields.containerStartedToRunnerRegisteredMs =
						runnerRegisteredMs - containerStartedMs;
					if (Number.isFinite(jobCreatedMs))
						fields.pickupMs = runnerRegisteredMs - jobCreatedMs;
					options.log?.("hobo_ci_job_pickup", fields);
					stage = "runner";
					await startRunner(
						options.docker,
						name,
						containerId,
						jit.encoded_jit_config,
						() => assertQueueDeadline(planned, now()),
					);
					launchLoops.delete(
						launchKey(planned.repositoryId, planned.jobId, planned.runAttempt),
					);
					// Get the next container ready while this job runs.
					if ((await liveContainers("")) < slots)
						void prewarm().catch(() => undefined);
				} catch (error) {
					let cleanupConfirmed = !containerId;
					if (containerId) {
						try {
							await options.docker.stop(name, containerId);
							await options.docker.remove(name, containerId);
							cleanupConfirmed = true;
						} catch {
							/* recovery will retry stop */
						}
					}
					if (
						error instanceof QueueDeadlineExpired ||
						createInFlight ||
						registrationAttempted ||
						!cleanupConfirmed
					) {
						logLaunch("hobo_ci_launch_failed", {
							stage,
							message: error instanceof Error ? error.message : "unknown",
							leaseId: planned.id,
							jobId: planned.jobId,
							actualJobId: planned.actualJobId,
							attempt:
								(launchLoops.get(
									launchKey(
										planned.repositoryId,
										planned.jobId,
										planned.runAttempt,
									),
								)?.failures.length ?? 0) + 1,
						});
						await options.store.transition(
							id,
							["dispatching", "dispatched", "claiming", "running"],
							(entry) => {
								entry.state = "uncertain";
							},
							"ci.LeaseUncertain",
							now(),
						);
						if (cleanupConfirmed && !createInFlight)
							await cleanupWorkDirectory(planned);
						// Keep the claimed financial hold until verified settlement.
						return;
					}
					await failLaunch(
						planned,
						stage,
						error instanceof Error ? error : new Error("unknown"),
					);
				}
			} finally {
				inFlightLaunchIds.delete(id);
			}
		},
		async reconcile(id: string, forceStop?: boolean) {
			let lease = await options.store.get(id);
			if (!lease || !LIVE_CONTAINER_STATES.has(lease.state)) return;
			let runnerCustodyHoldsActive = false;
			let runnerAssignment:
				| Awaited<ReturnType<typeof resolveRunnerAssignedJob>>
				| undefined;
			if (lease.runnerName) {
				const custody = await adoptRunnerAssignment(
					options.store,
					options.github,
					lease,
					now(),
					options.log,
				);
				lease = custody.lease;
				runnerAssignment = custody.assignment;
				runnerCustodyHoldsActive = custody.holdsActive;
				if (custody.holdsActive && forceStop) return;
			}
			if (forceStop && isUnregisteredDispatchingCreate(lease)) {
				// The durable state change fences a late create reply: its normal
				// continuation can no longer register a runner for this lease.
				if (inFlightLaunchIds.has(id)) return;
				const interrupted = await options.store.transition(
					id,
					["dispatching"],
					(entry) => {
						if (!isUnregisteredDispatchingCreate(entry))
							throw new Error("interrupted create changed during recovery");
						entry.state = "uncertain";
					},
					"ci.SandboxCreateInterrupted",
					now(),
				);
				if (!interrupted) return;
				lease = interrupted;
			}
			if (
				forceStop &&
				!lease.sandboxSessionId &&
				isUnregisteredUncertainCreate(lease) &&
				options.docker.list
			) {
				const matches = (
					await options.docker.list("hobo.ci/isolated=1")
				).filter((container) => container.name === lease?.sandboxName);
				const match = matches[0];
				if (matches.length !== 1 || !match?.containerId) return;
				const attached = await options.store.transition(
					id,
					["uncertain"],
					(entry) => {
						if (
							!isUnregisteredUncertainCreate(entry) ||
							entry.sandboxSessionId ||
							entry.sandboxName !== match.name
						)
							throw new Error("uncertain create changed during recovery");
						entry.sandboxSessionId = match.containerId;
						entry.sandboxStage = "created";
					},
					"ci.SandboxCreated",
					now(),
				);
				if (!attached) return;
				lease = attached;
			}
			if (hasIsolatedStopIntent(lease)) {
				if (lease.runnerName) {
					try {
						const assignment = await resolveRunnerAssignedJob(
							options.github,
							lease.installationId,
							lease.repository,
							lease.runnerName,
							lease.runnerId,
							{
								reservedJobId: lease.jobId,
								preferRunIds: [lease.originalRunId],
							},
						);
						if (runnerHoldsActiveJob(assignment)) return;
					} catch {
						if (!forceStop) return;
					}
				}
				if (!(await isolatedSessionPresent(lease))) {
					lease = await markStopped(lease, false);
					lease = await markStopped(lease, true);
					await settleStopped(lease);
					await cleanupWorkDirectory(lease);
					return;
				}
			}
			if (!lease.sandboxSessionId || !lease.sandboxName) {
				if (lease.state === "uncertain") {
					// A named create may still complete after a lost reply. Time alone
					// cannot prove absence or fence a second container with that identity.
					if (lease.sandboxName) return;
					const ageMs = Date.parse(now()) - Date.parse(lease.createdAt);
					if (ageMs >= uncertainWithoutContainerRecoveryMs) {
						await options.store.abortIsolatedAndRequeue(
							id,
							requeueJob(lease),
							now(),
						);
						detectOrphanJob(lease);
					}
				}
				return;
			}
			let running = false;
			try {
				running = await options.docker.isRunning(
					lease.sandboxName,
					lease.sandboxSessionId,
				);
			} catch {
				// An inspect error (timeout under load, daemon hiccup) is not proof the
				// job died: stopping here kills a live runner. Retry on the next tick.
				if (!forceStop) return;
				throw new Error("container status uncertain");
			}
			if (running && lease.sandboxStage === "stopped")
				throw new Error("stopped isolated session resumed unexpectedly");
			let containerFailed = false;
			if (!running && options.docker.exitState) {
				try {
					const state = await options.docker.exitState(
						lease.sandboxName,
						lease.sandboxSessionId,
					);
					containerFailed = state.exitCode !== 0 || state.oomKilled;
					if (state.exitCode === 137 && state.oomKilled) {
						options.memoryPeaks?.recordOom(lease.jobName);
						options.log?.("hobo_ci_container_oom", {
							jobId: lease.jobId,
							jobName: lease.jobName,
							memoryClass: lease.memoryClass || "heavy",
							memoryMb: lease.memoryMb || workerMemoryMb,
							exitCode: state.exitCode,
						});
					}
				} catch {
					// OOM evidence is best-effort; reconcile still settles the dead container.
				}
			}
			let stop = forceStop === true || hasIsolatedStopIntent(lease);
			if (!stop && lease.state === "running") {
				// The runner takes one job and exits, so its marker frees the slot on this
				// tick instead of after GitHub reports the job (a poll interval later). A
				// runner that died without a job lands here too; settle requeues its job.
				let exited = false;
				try {
					exited =
						(await options.docker.exists?.(
							lease.sandboxName,
							lease.sandboxSessionId,
							RUNNER_EXITED_PATH,
						)) === true;
				} catch {
					if (running) return;
				}
				if (exited) {
					if (lease.runnerName) {
						try {
							const assignment = await resolveRunnerAssignedJob(
								options.github,
								lease.installationId,
								lease.repository,
								lease.runnerName,
								lease.runnerId,
								{
									reservedJobId: lease.jobId,
									preferRunIds: [lease.originalRunId],
								},
							);
							if (runnerHoldsActiveJob(assignment)) return;
						} catch {
							// Local exit marker is sufficient to retire the session; continue.
						}
					}
					const emptyKey = jitEmptyExitKey(
						lease.repositoryId,
						lease.jobId,
						lease.runAttempt,
					);
					if (!eagerEmptyExitBackoff.has(lease.id)) {
						recordJitEmptyExit(emptyExitLoops, emptyKey, Date.parse(now()));
						eagerEmptyExitBackoff.add(lease.id);
					}
					try {
						lease = await markStopRequested(lease);
					} catch {
						if (running) return;
					}
					pendingExitEvidence.set(
						lease.id,
						await readRunnerExitEvidence(
							options.docker,
							lease.sandboxName,
							lease.sandboxSessionId,
						),
					);
					stop = true;
				} else if (running) {
					if (
						!runnerCustodyHoldsActive &&
						lease.runnerId > 0 &&
						lease.state === "running"
					) {
						const registeredMs =
							runnerRegisteredAtMs.get(lease.id) ?? Date.parse(lease.createdAt);
						const idleMs = Number.isFinite(registeredMs)
							? Date.parse(now()) - registeredMs
							: 0;
						try {
							const reserved = await getJob(
								options.github,
								lease.installationId,
								lease.repository,
								lease.jobId,
							);
							const foreignMesh =
								reserved.status === "queued" &&
								runnerCustody(reserved.runner_name) === "foreign";
							const unassignedIdle =
								reserved.status === "queued" &&
								!reserved.runner_name?.trim() &&
								!runnerAssignment;
							const releaseForeign =
								foreignMesh && idleMs >= ISOLATED_JIT_FOREIGN_MESH_IDLE_MS;
							const releaseUnassigned =
								unassignedIdle && idleMs >= ISOLATED_JIT_UNASSIGNED_IDLE_MS;
							if (releaseForeign || releaseUnassigned) {
								options.log?.("hobo_ci_jit_idle_listener_release", {
									leaseId: lease.id,
									jobId: lease.jobId,
									runnerName: lease.runnerName,
									idleMs,
									foreignMesh,
									unassignedIdle,
								});
								stop = true;
							}
						} catch {
							/* ambiguous GitHub read — keep listener until next tick */
						}
					}
					if (!stop && options.containerStallGuard) {
						const signal = options.containerStallGuard.evaluate(lease.id);
						if (signal) {
							options.log?.("hobo_ci_container_stall_requeue", {
								leaseId: lease.id,
								jobId: lease.jobId,
								jobName: lease.jobName,
								reason: signal.reason,
								consecutive: signal.consecutive,
								...hostResourcePressureLogFields(signal.sample),
							});
							stallRecovery.register(
								stallRecoveryRecordForLease(lease, signal, Date.parse(now())),
							);
							stallRecoveryLeaseIds.add(lease.id);
							options.containerStallGuard.clear(lease.id);
							stop = true;
						}
					}
					if (!stop) return;
				}
			}
			if (running && stop) await measureMemoryPeak(lease);
			const deadWhileRunning = !stop && lease.state === "running" && !running;
			if (!stop && !running && runnerCustodyHoldsActive && lease.runnerId > 0) {
				await deregisterLeaseRunner(lease, "ghost-runner-active-binding");
				options.log?.("hobo_ci_jit_runner_ghost_released", {
					leaseId: lease.id,
					jobId: lease.jobId,
					servedJobId: runnerAssignment?.jobId ?? lease.jobId,
					runnerName: lease.runnerName,
					runnerId: lease.runnerId,
				});
				stop = true;
			}
			if (deadWhileRunning) {
				stop = true;
				if (!stallRecoveryLeaseIds.has(lease.id)) detectOrphanJob(lease);
			}
			// Dispatch may still be registering or starting this session. A normal
			// reconciliation cannot retire it until there is a reason to stop.
			if (!stop) return;
			if (lease.runnerName) {
				try {
					const assignment = await resolveRunnerAssignedJob(
						options.github,
						lease.installationId,
						lease.repository,
						lease.runnerName,
						lease.runnerId,
						{
							reservedJobId: lease.jobId,
							preferRunIds: [lease.originalRunId],
						},
					);
					if (runnerHoldsActiveJob(assignment)) return;
				} catch {
					if (!stop) return;
				}
			}
			let removed = false;
			try {
				try {
					if (stop && !lease.pipelineId) lease = await markStopRequested(lease);
					if (running) {
						await options.docker.stop(
							lease.sandboxName,
							lease.sandboxSessionId,
						);
					}
					if (stop && !lease.pipelineId)
						lease = await markStopped(lease, false);
					try {
						await options.docker.remove(
							lease.sandboxName,
							lease.sandboxSessionId,
						);
					} catch (error) {
						if (
							!stop ||
							lease.pipelineId ||
							(await isolatedSessionPresent(lease))
						)
							throw error;
					}
					removed = true;
					if (stop && !lease.pipelineId) lease = await markStopped(lease, true);
				} catch {
					throw new Error("container stop uncertain");
				}
				await settleStopped(lease);
				if (
					containerFailed &&
					!deadWhileRunning &&
					!stallRecoveryLeaseIds.has(lease.id)
				)
					detectOrphanJob(lease);
			} finally {
				stallRecoveryLeaseIds.delete(lease.id);
				if (removed) await cleanupWorkDirectory(lease);
			}
		},
	};
	const containerCustody: Parameters<
		typeof createWorkerLeaseReconciler
	>[0]["containerCustody"] = async ({ container, leaseId }) => {
		if (container.state === "removing") return true;
		const resolvedLeaseId =
			leaseId ?? leaseIdFromBoxRunnerName(container.name) ?? undefined;
		const leases = await options.store.activeLeases();
		if (resolvedLeaseId) {
			const byId = await options.store.get(resolvedLeaseId);
			if (byId && ACTIVE_STATES.has(byId.state)) return true;
			if (
				byId?.runnerName &&
				(byId.runnerName === container.name ||
					byId.sandboxName === container.name)
			) {
				try {
					const assignment = await resolveRunnerAssignedJob(
						options.github,
						byId.installationId,
						byId.repository,
						byId.runnerName,
						byId.runnerId,
						{
							reservedJobId: byId.jobId,
							preferRunIds: [byId.originalRunId],
						},
					);
					if (runnerHoldsActiveJob(assignment)) return true;
				} catch {
					return true;
				}
			}
		}
		for (const lease of leases) {
			if (!ACTIVE_STATES.has(lease.state)) continue;
			if (
				lease.sandboxName === container.name ||
				lease.runnerName === container.name
			)
				return true;
		}
		const runnerLease = leases.find(
			(lease) =>
				ACTIVE_STATES.has(lease.state) &&
				lease.runnerName === container.name &&
				lease.runnerId > 0,
		);
		const custodyLease =
			runnerLease ??
			(resolvedLeaseId ? await options.store.get(resolvedLeaseId) : undefined);
		if (!custodyLease?.runnerName || custodyLease.runnerName !== container.name)
			return false;
		try {
			const assignment = await resolveRunnerAssignedJob(
				options.github,
				custodyLease.installationId,
				custodyLease.repository,
				container.name,
				custodyLease.runnerId,
				{
					reservedJobId: custodyLease.jobId,
					preferRunIds: [custodyLease.originalRunId],
				},
			);
			return runnerHoldsActiveJob(assignment);
		} catch {
			return true;
		}
	};
	const cancelStaleGithubLease = async (
		lease: Lease,
		_reason: string,
	): Promise<boolean> => {
		const at = now();
		const auth = await options.store.configuration();
		const updated = await options.store.transition(
			lease.id,
			[...ACTIVE_STATES],
			(entry) => {
				entry.state = "cancelled";
			},
			"ci.LeaseCancelled",
			at,
			auth?.revision ?? 0,
		);
		if (!updated) return false;
		await cleanupWorkDirectory(lease);
		const orphan = orphanJobCandidateForLease(lease, Date.parse(at));
		if (orphan) orphanJobs.enqueue(orphan);
		return true;
	};
	const reconcilerOptions: Parameters<typeof createWorkerLeaseReconciler>[0] = {
		store: options.store,
		docker: options.docker,
		workerAccountId: options.workerAccountId,
		workerMemoryMb,
		now: () => Date.parse(now()),
		github: options.github,
		cancelStaleGithubLease,
		settleExited: async (lease) => host.reconcile(lease.id, true),
		afterRelease: cleanupWorkDirectory,
		onOrphanJob: orphanJobs.enqueue,
		protectedContainerNames: () => protectedWarmNames,
		protectedLeaseIds: () => inFlightLaunchIds,
		containerCustody,
	};
	if (options.noContainerDrainMaxMs !== undefined)
		reconcilerOptions.noContainerDrainMaxMs = options.noContainerDrainMaxMs;
	if (options.orphanGraceMs !== undefined)
		reconcilerOptions.orphanGraceMs = options.orphanGraceMs;
	if (options.log) reconcilerOptions.log = options.log;
	const reconciler = createWorkerLeaseReconciler(reconcilerOptions);

	return {
		host,
		reconcileLeases: reconciler.reconcile,
		reconcileOrphanJobs: orphanJobs.reconcile,
		reconcileStallRecoveries: stallRecovery.reconcile,
		ready: async () => !!options.workerImage && !!options.workerAccountId,
		prewarm,
		discardWarm: async () => {
			await warming?.catch(() => undefined);
			const spare = warm;
			warm = undefined;
			if (spare) {
				protectedWarmNames.delete(spare.name);
				try {
					await options.docker.remove(spare.name, spare.containerId);
				} finally {
					options.memoryAdmission?.releaseWarm(spare.memoryMb);
				}
			}
		},
	};
}
