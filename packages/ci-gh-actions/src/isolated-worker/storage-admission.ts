import {
	chown,
	lstat,
	mkdir,
	readdir,
	rename,
	rm,
	rmdir,
	stat,
	statfs,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { selectWorkerImagesForDeletion, type WorkerImage } from "./image-gc.js";
import {
	buildHostCapacityRecord,
	type HostCapacityTracker,
	readHostCapacitySignals,
} from "./host-capacity.js";
import {
	DEPS_BUILD_ADMISSION_ID,
	storageReserveForClass,
	storageReserveForJob,
	type WorkerStorageReserve,
} from "./storage-job-classes.js";

const SOFT_LIMIT = 0.85;
const HARD_LIMIT = 0.95;
const INODE_GRANT_GRACE_MS = 60_000;
const JOB_DIRECTORY = /^hobo-[0-9a-f-]{36}$/u;
const RETIRED_JOB_DIRECTORY = /^hobo-[0-9a-f-]{36}-[0-9a-z]+$/u;
const RETIRED_ROOT = ".retired";
const ErrnoCode = z.object({ code: z.string() });

export type WorkerFileSystemStats = Readonly<{
	blocks: number;
	bfree: number;
	bsize: number;
	files: number;
	ffree: number;
}>;

export type WorkerWorkDirectoryRemoval = Readonly<{
	bytes: number;
	entries: number;
}>;

export type WorkerStorageFileSystem = Readonly<{
	statfs(path: string): Promise<WorkerFileSystemStats>;
	device(path: string): Promise<number>;
	jobDirectories(root: string): Promise<readonly string[]>;
	retiredDirectories(root: string): Promise<readonly string[]>;
	prepareJobDirectory(path: string): Promise<void>;
	retireJobDirectory(path: string): Promise<string | undefined>;
	removeJobDirectory(path: string): Promise<WorkerWorkDirectoryRemoval>;
}>;

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
		})
		.optional(),
});

export function createNodeWorkerStorageFileSystem(
	operations: Readonly<{
		chown: typeof chown;
		mkdir: typeof mkdir;
		lstat?: typeof lstat;
		readdir?: typeof readdir;
		rename?: typeof rename;
		rm?: typeof rm;
		rmdir?: typeof rmdir;
	}> = { chown, mkdir },
): WorkerStorageFileSystem {
	const io = {
		lstat: operations.lstat ?? lstat,
		readdir: operations.readdir ?? readdir,
		rename: operations.rename ?? rename,
		rm: operations.rm ?? rm,
		rmdir: operations.rmdir ?? rmdir,
	};
	return {
		async statfs(path) {
			const stats = await statfs(path);
			return {
				blocks: stats.blocks,
				bfree: stats.bfree,
				bsize: stats.bsize,
				files: stats.files,
				ffree: stats.ffree,
			};
		},
		async device(path) {
			return (await stat(path)).dev;
		},
		async jobDirectories(root) {
			const entries = await io.readdir(root, { withFileTypes: true });
			return entries
				.filter(
					(entry) => entry.isDirectory() && JOB_DIRECTORY.test(entry.name),
				)
				.map((entry) => join(root, entry.name));
		},
		async retiredDirectories(root) {
			try {
				const entries = await io.readdir(join(root, RETIRED_ROOT), {
					withFileTypes: true,
				});
				return entries
					.filter(
						(entry) =>
							entry.isDirectory() && RETIRED_JOB_DIRECTORY.test(entry.name),
					)
					.map((entry) => join(root, RETIRED_ROOT, entry.name));
			} catch (error) {
				const parsed = ErrnoCode.safeParse(error);
				if (parsed.success && parsed.data.code === "ENOENT") return [];
				throw error;
			}
		},
		async prepareJobDirectory(path) {
			if (!JOB_DIRECTORY.test(basename(path)))
				throw new Error("invalid worker job directory");
			await operations.mkdir(path, { recursive: true, mode: 0o755 });
			const repository = join(path, "HoBo");
			const checkout = join(repository, "HoBo");
			await operations.mkdir(checkout, { recursive: true, mode: 0o755 });
			await operations.chown(repository, 1000, 1000);
			await operations.chown(checkout, 1000, 1000);
			await operations.chown(path, 1000, 1000);
		},
		async retireJobDirectory(path) {
			const name = basename(path);
			if (!JOB_DIRECTORY.test(name))
				throw new Error("invalid worker job directory");
			const retiredRoot = join(dirname(path), RETIRED_ROOT);
			await operations.mkdir(retiredRoot, { recursive: true, mode: 0o700 });
			const retired = join(retiredRoot, `${name}-${Date.now().toString(36)}`);
			try {
				await io.rename(path, retired);
				return retired;
			} catch (error) {
				const parsed = ErrnoCode.safeParse(error);
				if (parsed.success && parsed.data.code === "ENOENT") return undefined;
				throw error;
			}
		},
		async removeJobDirectory(path) {
			const name = basename(path);
			const valid =
				basename(dirname(path)) === RETIRED_ROOT
					? RETIRED_JOB_DIRECTORY.test(name)
					: JOB_DIRECTORY.test(name);
			if (!valid) throw new Error("invalid worker job directory");
			const remove = async (
				entryPath: string,
			): Promise<WorkerWorkDirectoryRemoval> => {
				const metadata = await io.lstat(entryPath);
				if (!metadata.isDirectory()) {
					await io.rm(entryPath, { force: false });
					return { bytes: metadata.size, entries: 1 };
				}
				let bytes = 0;
				let entries = 1;
				for (const entry of await io.readdir(entryPath)) {
					const child = await remove(join(entryPath, entry));
					bytes += child.bytes;
					entries += child.entries;
				}
				await io.rmdir(entryPath);
				return { bytes, entries };
			};
			return remove(path);
		},
	};
}

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
	jobInodes?: Readonly<{ workRoot: number; dockerDataRoot: number }>;
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
	const defaultReserve: WorkerStorageReserve = options.jobInodes ?? {
		workRoot: 200_000,
		dockerDataRoot: 170_000,
	};
	for (const reserve of [defaultReserve.workRoot, defaultReserve.dockerDataRoot])
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

	function resolveTarget(target: StorageAdmissionTarget): ResolvedStorageAdmission {
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
		}
		return undefined;
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
			if (perJob <= 0) continue;
			const first = group[0];
			if (!first) continue;
			const reserved = reservedInodesOnDevice(samples, first.device);
			const headroom = first.ffree - inodeSafetyMargin() - reserved;
			limit = Math.min(limit, Math.floor(headroom / perJob));
		}
		return Number.isFinite(limit) ? Math.max(0, limit) : 0;
	}

	function logCapacity(samples: readonly StorageSample[], template: WorkerStorageReserve) {
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
