import { basename } from "node:path";
import { z } from "zod";
import {
	buildHostCapacityRecord,
	type HostCapacityTracker,
	readHostCapacitySignals,
} from "./host-capacity.js";
import { selectWorkerImagesForDeletion, type WorkerImage } from "./image-gc.js";
import {
	DEPS_BUILD_ADMISSION_ID,
	storageReserveForClass,
	storageReserveForJob,
	type WorkerStorageReserve,
} from "./storage-job-classes.js";
import {
	createNodeWorkerStorageFileSystem,
	type WorkerFileSystemStats,
	type WorkerStorageFileSystem,
	type WorkerWorkDirectoryRemoval,
} from "./worker-storage-fs.js";

export {
	createNodeWorkerStorageFileSystem,
	type WorkerFileSystemStats,
	type WorkerStorageFileSystem,
	type WorkerWorkDirectoryRemoval,
};

const SOFT_LIMIT = 0.85;
const HARD_LIMIT = 0.95;
const INODE_GRANT_GRACE_MS = 60_000;
const BYTE_SAFETY_MARGIN_FLOOR = 2 * 1024 * 1024 * 1024;
const IMMINENT_INODE_BUFFER = 50_000;

export type WorkerStorageDockerDriver = Readonly<{
	dataRoot(): Promise<string>;
	pruneBuilder(keepStorage: string): Promise<void>;
	containerExists(name: string): Promise<boolean>;
	containersUsingVolume(source: string): Promise<number>;
	listImages(): Promise<readonly WorkerImage[]>;
	removeImage(tag: string): Promise<void>;
	pruneDanglingImages(): Promise<void>;
}>;

export type PnpmStorePruneResult =
	| "pruned"
	| "in-flight"
	| "locked"
	| "rate-limited"
	| "busy"
	| "failed";

export type PnpmStorePruneOutcome = Readonly<{
	result: PnpmStorePruneResult;
	ms: number;
}>;

export type WorkerStoragePnpmStore = Readonly<{
	prune(idle: () => Promise<boolean>): Promise<PnpmStorePruneOutcome>;
}>;

export type WorkerStorageLease = Readonly<{
	id: string;
	sandboxName: string;
	jobId: string;
}>;

export type WorkerStorageLog = (
	event:
		| "hobo_ci_inode_pressure"
		| "hobo_ci_inode_reserve_wait"
		| "hobo_ci_pnpm_store_prune"
		| "hobo_ci_storage_admission_wait"
		| "hobo_ci_storage_capacity"
		| "hobo_ci_host_capacity"
		| "hobo_ci_storage_prune_failed",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type StorageAdmissionRequest = Readonly<{
	jobId: string;
	jobName?: string;
	reserve?: WorkerStorageReserve;
}>;

export type StorageAdmissionTarget = string | StorageAdmissionRequest;

type ResolvedStorageAdmission = Readonly<{
	jobId: string;
	reserve: WorkerStorageReserve;
}>;

const StorageAdmissionRequestSchema = z.object({
	jobId: z.string(),
	jobName: z.string().optional(),
	reserve: z
		.object({
			workRoot: z.number().int().nonnegative(),
			dockerDataRoot: z.number().int().nonnegative(),
			workRootBytes: z.number().int().nonnegative(),
			dockerDataRootBytes: z.number().int().nonnegative(),
		})
		.optional(),
});

type Pressure = Readonly<{
	root: string;
	diskUsage: number;
	inodeUsage: number;
}>;

function pressure(root: string, stats: WorkerFileSystemStats): Pressure {
	if (
		!Number.isFinite(stats.blocks) ||
		!Number.isFinite(stats.bfree) ||
		!Number.isFinite(stats.files) ||
		!Number.isFinite(stats.ffree) ||
		stats.blocks <= 0 ||
		stats.files <= 0 ||
		stats.bfree < 0 ||
		stats.bfree > stats.blocks ||
		stats.ffree < 0 ||
		stats.ffree > stats.files
	)
		throw new Error(`invalid filesystem stats for ${root}`);
	return {
		root,
		diskUsage: (stats.blocks - stats.bfree) / stats.blocks,
		inodeUsage: (stats.files - stats.ffree) / stats.files,
	};
}

function percent(value: number): number {
	return Math.ceil(value * 1_000) / 10;
}

type StorageSample = Pressure &
	Readonly<{
		device: number;
		ffree: number;
		freeBytes: number;
		reserve: number;
		index: number;
	}>;

type InodeGrant = Readonly<{
	grantedAtMs: number;
	ffree: readonly number[];
	reserve: WorkerStorageReserve;
}>;

type InodeReserveWait = Readonly<{
	root: string;
	freeInodes: number;
	outstandingInodes: number;
	requiredInodes: number;
	activeGrants: number;
}>;

export function createWorkerStorageAdmission(options: {
	dockerDataRoot: string;
	workRoot: string;
	fs: WorkerStorageFileSystem;
	docker: WorkerStorageDockerDriver;
	activeLeases: () => Promise<readonly WorkerStorageLease[]>;
	pnpmStore?: WorkerStoragePnpmStore;
	pnpmStoreIdle?: () => Promise<boolean>;
	builderCacheCap?: string;
	softLimit?: number;
	hardLimit?: number;
	jobInodes?: Partial<
		Pick<WorkerStorageReserve, "workRoot" | "dockerDataRoot">
	>;
	safetyMarginInodes?: number;
	capacityTracker?: HostCapacityTracker;
	admitMaintainIntervalMs?: number;
	scheduleRetiredSweep?: () => void;
	now?: () => number;
	log?: WorkerStorageLog;
}) {
	const softLimit = options.softLimit ?? SOFT_LIMIT;
	const hardLimit = options.hardLimit ?? HARD_LIMIT;
	if (!(softLimit > 0) || !(hardLimit > softLimit) || !(hardLimit < 1))
		throw new Error("invalid worker storage thresholds");
	const classDefault = storageReserveForClass("standard");
	const inodeOverride = options.jobInodes;
	const defaultReserve: WorkerStorageReserve =
		inodeOverride?.workRoot !== undefined &&
		inodeOverride.dockerDataRoot !== undefined
			? {
					...classDefault,
					workRoot: inodeOverride.workRoot,
					dockerDataRoot: inodeOverride.dockerDataRoot,
				}
			: classDefault;
	for (const reserve of [
		defaultReserve.workRoot,
		defaultReserve.dockerDataRoot,
	])
		if (!Number.isSafeInteger(reserve) || reserve < 0)
			throw new Error("invalid worker job inode reservation");
	const safetyMarginFloor = options.safetyMarginInodes ?? 25_000;
	if (
		!Number.isSafeInteger(safetyMarginFloor) ||
		safetyMarginFloor < 0 ||
		safetyMarginFloor > 10_000_000
	)
		throw new Error("invalid worker storage inode safety margin");
	const capacityTracker = options.capacityTracker;
	function inodeSafetyMargin(): number {
		return Math.max(
			safetyMarginFloor,
			capacityTracker?.marginInodes() ?? safetyMarginFloor,
		);
	}
	const reservations = [
		{ root: options.dockerDataRoot, kind: "dockerDataRoot" as const },
		{ root: options.workRoot, kind: "workRoot" as const },
	];
	const now = options.now ?? Date.now;
	const admitMaintainIntervalMs = options.admitMaintainIntervalMs ?? 60_000;
	const grants = new Map<string, InodeGrant>();
	let lastAdmitMaintainMs: number | undefined;
	let hardEpisode = false;
	let reserveEpisode = false;
	let unavailable = false;
	let pnpmPruneInFlight = false;
	let pnpmPruneWaitLogged = false;

	async function sample(): Promise<StorageSample[]> {
		return Promise.all(
			reservations.map(async (reservation, index) => {
				const [stats, device] = await Promise.all([
					options.fs.statfs(reservation.root),
					options.fs.device(reservation.root),
				]);
				return {
					...pressure(reservation.root, stats),
					device,
					ffree: stats.ffree,
					freeBytes: stats.bfree * stats.bsize,
					reserve: 0,
					index,
				};
			}),
		);
	}

	function resolveTarget(
		target: StorageAdmissionTarget,
	): ResolvedStorageAdmission {
		const stringTarget = z.string().safeParse(target);
		if (stringTarget.success)
			return { jobId: stringTarget.data, reserve: defaultReserve };
		const request = StorageAdmissionRequestSchema.parse(target);
		if (request.reserve)
			return { jobId: request.jobId, reserve: request.reserve };
		if (request.jobName)
			return {
				jobId: request.jobId,
				reserve: storageReserveForJob(request.jobName),
			};
		return { jobId: request.jobId, reserve: defaultReserve };
	}

	function reconcile(activeLeases: readonly WorkerStorageLease[]) {
		const activeJobs = new Set(activeLeases.map((lease) => lease.jobId));
		const nowMs = now();
		for (const [jobId, grant] of grants) {
			if (jobId === DEPS_BUILD_ADMISSION_ID) continue;
			if (
				!activeJobs.has(jobId) &&
				nowMs - grant.grantedAtMs > INODE_GRANT_GRACE_MS
			)
				grants.delete(jobId);
		}
	}

	function reserveForSample(
		sample: StorageSample,
		reserve: WorkerStorageReserve,
	): number {
		return sample.index === 0 ? reserve.dockerDataRoot : reserve.workRoot;
	}

	function reserveBytesForSample(
		sample: StorageSample,
		reserve: WorkerStorageReserve,
	): number {
		return sample.index === 0
			? reserve.dockerDataRootBytes
			: reserve.workRootBytes;
	}

	function byteSafetyMargin(): number {
		return BYTE_SAFETY_MARGIN_FLOOR;
	}

	function reservedBytesOnDevice(
		samples: readonly StorageSample[],
		device: number,
	): number {
		let total = 0;
		for (const grant of grants.values()) {
			for (const sample of samples) {
				if (sample.device !== device) continue;
				total += reserveBytesForSample(sample, grant.reserve);
			}
		}
		return total;
	}

	function reservedInodesOnDevice(
		samples: readonly StorageSample[],
		device: number,
	): number {
		let total = 0;
		for (const grant of grants.values()) {
			for (const sample of samples) {
				if (sample.device !== device) continue;
				total += reserveForSample(sample, grant.reserve);
			}
		}
		return total;
	}

	function totalReservedInodes(samples: readonly StorageSample[]): number {
		const devices = new Set(samples.map((entry) => entry.device));
		let total = 0;
		for (const device of devices)
			total += reservedInodesOnDevice(samples, device);
		return total;
	}

	function observedFreeInodes(samples: readonly StorageSample[]): number {
		let min = Number.POSITIVE_INFINITY;
		for (const entry of samples) min = Math.min(min, entry.ffree);
		return Number.isFinite(min) ? min : 0;
	}

	function observedFreeBytes(samples: readonly StorageSample[]): number {
		let min = Number.POSITIVE_INFINITY;
		for (const entry of samples) min = Math.min(min, entry.freeBytes);
		return Number.isFinite(min) ? min : 0;
	}

	function logHostCapacity(samples: readonly StorageSample[]) {
		if (!capacityTracker) return;
		const reserved = totalReservedInodes(samples);
		const snap = capacityTracker.snapshot(reserved);
		options.log?.("hobo_ci_host_capacity", {
			observedFreeInodes: snap.observedFreeInodes,
			observedFreeBytes: snap.observedFreeBytes,
			ourReservedInodes: snap.ourReservedInodes,
			safetyMarginInodes: snap.safetyMarginInodes,
			externalInodeDrain: snap.externalInodeDrain ?? -1,
			memAvailableMb: snap.memAvailableMb ?? -1,
			admitNewWork: snap.admitNewWork,
			reason: snap.reason ?? "",
		});
	}

	async function probeHostCapacity(
		activeLeases: readonly WorkerStorageLease[],
	): Promise<void> {
		reconcile(activeLeases);
		let samples: StorageSample[];
		try {
			samples = await sample();
		} catch {
			return;
		}
		const signals = readHostCapacitySignals();
		capacityTracker?.record(
			buildHostCapacityRecord(
				observedFreeInodes(samples),
				observedFreeBytes(samples),
				signals,
			),
		);
		logHostCapacity(samples);
	}

	function reserveShortage(
		samples: readonly StorageSample[],
		incoming: WorkerStorageReserve,
	) {
		const groups = new Map<number, StorageSample[]>();
		for (const entry of samples) {
			const group = groups.get(entry.device) ?? [];
			group.push(entry);
			groups.set(entry.device, group);
		}
		let oldest: InodeGrant | undefined;
		for (const grant of grants.values())
			if (!oldest || grant.grantedAtMs < oldest.grantedAtMs) oldest = grant;
		for (const group of groups.values()) {
			const first = group[0];
			if (!first) continue;
			const incomingRequired = group.reduce(
				(total, entry) => total + reserveForSample(entry, incoming),
				0,
			);
			const outstandingReserved = reservedInodesOnDevice(samples, first.device);
			const baseline = oldest?.ffree[first.index] ?? first.ffree;
			const consumption = Math.max(0, baseline - first.ffree);
			const outstandingInodes = Math.max(0, outstandingReserved - consumption);
			const requiredInodes = incomingRequired + outstandingInodes;
			const incomingBytes = group.reduce(
				(total, entry) => total + reserveBytesForSample(entry, incoming),
				0,
			);
			const outstandingBytes = reservedBytesOnDevice(samples, first.device);
			const requiredBytes = incomingBytes + outstandingBytes;
			if (
				incomingRequired > 0 &&
				first.ffree - inodeSafetyMargin() < requiredInodes
			)
				return {
					root: first.root,
					freeInodes: first.ffree,
					outstandingInodes: requiredInodes - incomingRequired,
					requiredInodes,
					activeGrants: grants.size,
				} satisfies InodeReserveWait;
			if (
				incomingBytes > 0 &&
				first.freeBytes - byteSafetyMargin() < requiredBytes
			)
				return {
					root: first.root,
					freeInodes: first.ffree,
					outstandingInodes: requiredInodes - incomingRequired,
					requiredInodes,
					activeGrants: grants.size,
				} satisfies InodeReserveWait;
		}
		return undefined;
	}

	function imminentPressureFromSamples(samples: readonly StorageSample[]):
		| Readonly<{
				preempt: boolean;
				observedFreeInodes: number;
				floorInodes: number;
				observedFreeBytes: number;
				floorBytes: number;
		  }>
		| undefined {
		const freeInodes = observedFreeInodes(samples);
		const freeBytes = observedFreeBytes(samples);
		const reservedInodes = totalReservedInodes(samples);
		const margin = inodeSafetyMargin();
		const template = storageReserveForClass("light");
		const floorInodes =
			reservedInodes + margin + template.workRoot + template.dockerDataRoot;
		const reservedBytes = samples.reduce(
			(max, sample) =>
				Math.max(max, reservedBytesOnDevice(samples, sample.device)),
			0,
		);
		const floorBytes =
			reservedBytes +
			byteSafetyMargin() +
			template.workRootBytes +
			template.dockerDataRootBytes;
		const preempt =
			freeInodes < floorInodes + IMMINENT_INODE_BUFFER ||
			freeBytes < floorBytes + BYTE_SAFETY_MARGIN_FLOOR / 4;
		if (!preempt) return undefined;
		return {
			preempt: true,
			observedFreeInodes: freeInodes,
			floorInodes,
			observedFreeBytes: freeBytes,
			floorBytes,
		};
	}

	function grant(
		jobId: string,
		samples: readonly StorageSample[],
		reserve: WorkerStorageReserve,
	) {
		grants.set(jobId, {
			grantedAtMs: now(),
			ffree: samples.map((entry) => entry.ffree),
			reserve,
		});
		reserveEpisode = false;
		return true;
	}

	function binPackConcurrent(
		samples: readonly StorageSample[],
		template: WorkerStorageReserve,
	): number {
		const groups = new Map<number, StorageSample[]>();
		for (const entry of samples) {
			const group = groups.get(entry.device) ?? [];
			group.push(entry);
			groups.set(entry.device, group);
		}
		let limit = Number.POSITIVE_INFINITY;
		for (const group of groups.values()) {
			const perJob = group.reduce(
				(total, entry) => total + reserveForSample(entry, template),
				0,
			);
			const perJobBytes = group.reduce(
				(total, entry) => total + reserveBytesForSample(entry, template),
				0,
			);
			if (perJob <= 0 && perJobBytes <= 0) continue;
			const first = group[0];
			if (!first) continue;
			const reserved = reservedInodesOnDevice(samples, first.device);
			const reservedBytes = reservedBytesOnDevice(samples, first.device);
			const headroomInodes = first.ffree - inodeSafetyMargin() - reserved;
			const headroomBytes =
				first.freeBytes - byteSafetyMargin() - reservedBytes;
			const byInodes =
				perJob > 0
					? Math.floor(headroomInodes / perJob)
					: Number.POSITIVE_INFINITY;
			const byBytes =
				perJobBytes > 0
					? Math.floor(headroomBytes / perJobBytes)
					: Number.POSITIVE_INFINITY;
			limit = Math.min(limit, byInodes, byBytes);
		}
		return Number.isFinite(limit) ? Math.max(0, limit) : 0;
	}

	function logCapacity(
		samples: readonly StorageSample[],
		template: WorkerStorageReserve,
	) {
		const concurrent = binPackConcurrent(samples, template);
		const docker = samples.find((entry) => entry.index === 0);
		const work = samples.find((entry) => entry.index === 1);
		const margin = inodeSafetyMargin();
		const reserved = totalReservedInodes(samples);
		options.log?.("hobo_ci_storage_capacity", {
			freeInodesDocker: docker?.ffree ?? -1,
			freeInodesWork: work?.ffree ?? -1,
			observedFreeInodes: observedFreeInodes(samples),
			observedFreeBytes: observedFreeBytes(samples),
			safetyMarginInodes: margin,
			ourReservedInodes: reserved,
			activeGrants: grants.size,
			maxConcurrentStandard: concurrent,
			maxConcurrentHeavy: binPackConcurrent(
				samples,
				storageReserveForClass("heavy"),
			),
			maxConcurrentLight: binPackConcurrent(
				samples,
				storageReserveForClass("light"),
			),
			templateWork: template.workRoot,
			templateDocker: template.dockerDataRoot,
		});
	}

	async function attempt(operation: string, run: () => Promise<void>) {
		try {
			await run();
		} catch (error) {
			options.log?.("hobo_ci_storage_prune_failed", {
				operation,
				message: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	async function reap() {
		let directories: readonly string[];
		try {
			directories = await options.fs.jobDirectories(options.workRoot);
		} catch (error) {
			options.log?.("hobo_ci_storage_prune_failed", {
				operation: "list-work-dirs",
				message: error instanceof Error ? error.message : "unknown",
			});
			return;
		}
		let activeLeases: readonly WorkerStorageLease[];
		try {
			activeLeases = await options.activeLeases();
		} catch (error) {
			options.log?.("hobo_ci_storage_prune_failed", {
				operation: "read-leases",
				message: error instanceof Error ? error.message : "unknown",
			});
			return;
		}
		const liveNames = new Set(
			activeLeases.flatMap((lease) => [
				`hobo-${lease.id}`,
				...(lease.sandboxName ? [lease.sandboxName] : []),
			]),
		);
		for (const directory of directories) {
			const name = basename(directory);
			if (liveNames.has(name)) continue;
			try {
				if (await options.docker.containerExists(name)) continue;
				const retired = await options.fs.retireJobDirectory(directory);
				if (retired) options.scheduleRetiredSweep?.();
			} catch (error) {
				options.log?.("hobo_ci_storage_prune_failed", {
					operation: "remove-work-dir",
					message: error instanceof Error ? error.message : "unknown",
				});
			}
		}
	}

	async function maintain(
		activeLeases: readonly WorkerStorageLease[],
		maintenance: Readonly<{ pnpmStore?: boolean }> = {},
	) {
		await attempt("builder", () =>
			options.docker.pruneBuilder(options.builderCacheCap ?? "4GB"),
		);
		try {
			const images = await options.docker.listImages();
			for (const tag of selectWorkerImagesForDeletion(images))
				await attempt(`image:${tag}`, () => options.docker.removeImage(tag));
		} catch (error) {
			options.log?.("hobo_ci_storage_prune_failed", {
				operation: "list-images",
				message: error instanceof Error ? error.message : "unknown",
			});
		}
		await attempt("dangling-images", () =>
			options.docker.pruneDanglingImages(),
		);
		const pnpmStore = options.pnpmStore;
		if (
			pnpmStore &&
			maintenance.pnpmStore === true &&
			activeLeases.length === 0
		) {
			pnpmPruneInFlight = true;
			try {
				const { result, ms } = await pnpmStore.prune(
					options.pnpmStoreIdle ?? (async () => false),
				);
				if (result !== "rate-limited")
					options.log?.("hobo_ci_pnpm_store_prune", { result, ms });
			} catch (error) {
				options.log?.("hobo_ci_storage_prune_failed", {
					operation: "pnpm-store",
					message: error instanceof Error ? error.message : "unknown",
				});
			} finally {
				pnpmPruneInFlight = false;
				pnpmPruneWaitLogged = false;
			}
		}
		await reap();
	}

	return {
		reap,
		maintain,
		release(jobId: string) {
			grants.delete(jobId);
		},
		isAdmissionOpen(): boolean {
			return capacityTracker?.shouldBlockAdmission() !== true;
		},
		probeHostCapacity,
		async evaluateImminentPressure(
			activeLeases: readonly WorkerStorageLease[],
		) {
			reconcile(activeLeases);
			try {
				return imminentPressureFromSamples(await sample());
			} catch {
				return undefined;
			}
		},
		async admit(
			activeLeases: readonly WorkerStorageLease[],
			target: StorageAdmissionTarget,
		): Promise<boolean> {
			if (capacityTracker?.shouldBlockAdmission()) {
				const reason = capacityTracker.blockReason();
				if (reason)
					options.log?.("hobo_ci_storage_admission_wait", {
						message: `host-capacity:${reason}`,
					});
				return false;
			}
			if (pnpmPruneInFlight) {
				if (!pnpmPruneWaitLogged)
					options.log?.("hobo_ci_storage_admission_wait", {
						message: "pnpm store prune in progress",
					});
				pnpmPruneWaitLogged = true;
				return false;
			}
			const { jobId, reserve } = resolveTarget(target);
			reconcile(activeLeases);
			let before: StorageSample[];
			try {
				before = await sample();
				unavailable = false;
			} catch (error) {
				if (!unavailable) {
					unavailable = true;
					options.log?.("hobo_ci_storage_admission_wait", {
						message: error instanceof Error ? error.message : "unknown",
					});
				}
				return false;
			}
			const proactiveShortage = reserveShortage(before, reserve);
			const softPressure = before.some(
				(entry) => Math.max(entry.diskUsage, entry.inodeUsage) > softLimit,
			);
			if (!proactiveShortage && !softPressure) {
				hardEpisode = false;
				logCapacity(before, storageReserveForClass("standard"));
				return grant(jobId, before, reserve);
			}
			if (proactiveShortage) {
				if (!reserveEpisode)
					options.log?.("hobo_ci_inode_reserve_wait", proactiveShortage);
				reserveEpisode = true;
				return false;
			}
			const nowMs = now();
			if (
				lastAdmitMaintainMs === undefined ||
				nowMs - lastAdmitMaintainMs >= admitMaintainIntervalMs
			) {
				lastAdmitMaintainMs = nowMs;
				await maintain(activeLeases, { pnpmStore: true });
			}
			let after: StorageSample[];
			try {
				after = await sample();
			} catch (error) {
				options.log?.("hobo_ci_storage_admission_wait", {
					message: error instanceof Error ? error.message : "unknown",
				});
				return false;
			}
			const shortage = reserveShortage(after, reserve);
			if (shortage) {
				if (!reserveEpisode)
					options.log?.("hobo_ci_inode_reserve_wait", shortage);
				reserveEpisode = true;
				return false;
			}
			const inodeHard = after.some((entry) => entry.inodeUsage > hardLimit);
			const diskHard = after.some((entry) => entry.diskUsage > hardLimit);
			if (inodeHard || diskHard) {
				if (!hardEpisode) {
					hardEpisode = true;
					const worst = after.reduce((current, entry) =>
						Math.max(entry.diskUsage, entry.inodeUsage) >
						Math.max(current.diskUsage, current.inodeUsage)
							? entry
							: current,
					);
					options.log?.("hobo_ci_inode_pressure", {
						root: worst.root,
						pressureKind:
							inodeHard && diskHard ? "both" : inodeHard ? "inode" : "disk",
						diskUsagePercent: percent(worst.diskUsage),
						inodeUsagePercent: percent(worst.inodeUsage),
						softLimitPercent: percent(softLimit),
						hardLimitPercent: percent(hardLimit),
					});
				}
				return false;
			}
			if (
				after.every(
					(entry) => Math.max(entry.diskUsage, entry.inodeUsage) <= softLimit,
				)
			)
				hardEpisode = false;
			logCapacity(after, storageReserveForClass("standard"));
			return grant(jobId, after, reserve);
		},
		async binPackSlots(
			template: WorkerStorageReserve = storageReserveForClass("standard"),
		): Promise<number> {
			reconcile(await options.activeLeases());
			const samples = await sample();
			return binPackConcurrent(samples, template);
		},
		async canFit(reserve: WorkerStorageReserve): Promise<boolean> {
			reconcile(await options.activeLeases());
			const samples = await sample();
			return reserveShortage(samples, reserve) === undefined;
		},
	};
}

export type WorkerStorageAdmission = ReturnType<
	typeof createWorkerStorageAdmission
>;
