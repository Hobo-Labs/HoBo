import { basename } from "node:path";
import { selectWorkerImagesForDeletion, type WorkerImage } from "./image-gc.js";
import type { WorkerStorageReserve } from "./storage-job-classes.js";
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
		| "hobo_ci_disk_reserve_wait"
		| "hobo_ci_pnpm_store_prune"
		| "hobo_ci_storage_admission_wait"
		| "hobo_ci_storage_prune_failed",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

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
		bfree: number;
		bsize: number;
		reserveInodes: number;
		reserveBytes: number;
		index: number;
	}>;

type StorageGrant = Readonly<{
	grantedAtMs: number;
	ffree: readonly number[];
	bfree: readonly number[];
}>;

type StorageReserveWait = Readonly<{
	kind: "inode" | "disk";
	root: string;
	free: number;
	outstanding: number;
	required: number;
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
	defaultJobReserve?: WorkerStorageReserve;
	admitMaintainIntervalMs?: number;
	scheduleRetiredSweep?: () => void;
	now?: () => number;
	log?: WorkerStorageLog;
}) {
	const softLimit = options.softLimit ?? SOFT_LIMIT;
	const hardLimit = options.hardLimit ?? HARD_LIMIT;
	if (!(softLimit > 0) || !(hardLimit > softLimit) || !(hardLimit < 1))
		throw new Error("invalid worker storage thresholds");
	const defaultJobReserve = options.defaultJobReserve ?? {
		workRoot: options.jobInodes?.workRoot ?? 200_000,
		dockerDataRoot: options.jobInodes?.dockerDataRoot ?? 170_000,
		workRootBytes: 8 * 1024 * 1024 * 1024,
		dockerDataRootBytes: 6 * 1024 * 1024 * 1024,
	};
	for (const reserve of [
		defaultJobReserve.workRoot,
		defaultJobReserve.dockerDataRoot,
		defaultJobReserve.workRootBytes,
		defaultJobReserve.dockerDataRootBytes,
	])
		if (!Number.isSafeInteger(reserve) || reserve < 0)
			throw new Error("invalid worker job storage reservation");
	const now = options.now ?? Date.now;
	const admitMaintainIntervalMs = options.admitMaintainIntervalMs ?? 60_000;
	const grants = new Map<string, StorageGrant>();
	let lastAdmitMaintainMs: number | undefined;
	let hardEpisode = false;
	let reserveEpisode = false;
	let unavailable = false;
	let pnpmPruneInFlight = false;
	let pnpmPruneWaitLogged = false;

	function reservationsFor(jobReserve: WorkerStorageReserve): readonly {
		root: string;
		reserveInodes: number;
		reserveBytes: number;
		index: number;
	}[] {
		return [
			{
				root: options.dockerDataRoot,
				reserveInodes: jobReserve.dockerDataRoot,
				reserveBytes: jobReserve.dockerDataRootBytes,
				index: 0,
			},
			{
				root: options.workRoot,
				reserveInodes: jobReserve.workRoot,
				reserveBytes: jobReserve.workRootBytes,
				index: 1,
			},
		];
	}

	async function sample(
		jobReserve: WorkerStorageReserve,
	): Promise<StorageSample[]> {
		return Promise.all(
			reservationsFor(jobReserve).map(async (reservation) => {
				const [stats, device] = await Promise.all([
					options.fs.statfs(reservation.root),
					options.fs.device(reservation.root),
				]);
				const bsize = stats.bsize > 0 ? stats.bsize : 4096;
				return {
					...pressure(reservation.root, stats),
					device,
					ffree: stats.ffree,
					bfree: stats.bfree,
					bsize,
					reserveInodes: reservation.reserveInodes,
					reserveBytes: reservation.reserveBytes,
					index: reservation.index,
				};
			}),
		);
	}

	function reconcile(activeLeases: readonly WorkerStorageLease[]) {
		const activeJobs = new Set(activeLeases.map((lease) => lease.jobId));
		const nowMs = now();
		for (const [jobId, grant] of grants)
			if (
				!activeJobs.has(jobId) &&
				nowMs - grant.grantedAtMs > INODE_GRANT_GRACE_MS
			)
				grants.delete(jobId);
	}

	function reserveShortage(samples: readonly StorageSample[]) {
		const groups = new Map<number, StorageSample[]>();
		for (const entry of samples) {
			const group = groups.get(entry.device) ?? [];
			group.push(entry);
			groups.set(entry.device, group);
		}
		let oldest: StorageGrant | undefined;
		for (const grant of grants.values())
			if (!oldest || grant.grantedAtMs < oldest.grantedAtMs) oldest = grant;
		for (const group of groups.values()) {
			const first = group[0];
			if (!first) continue;
			const requiredInodes = group.reduce(
				(total, entry) => total + entry.reserveInodes,
				0,
			);
			const baselineInodes = oldest?.ffree[first.index] ?? first.ffree;
			const outstandingInodes = Math.max(
				0,
				requiredInodes * grants.size - (baselineInodes - first.ffree),
			);
			if (
				requiredInodes > 0 &&
				first.ffree - outstandingInodes < requiredInodes
			)
				return {
					kind: "inode",
					root: first.root,
					free: first.ffree,
					outstanding: outstandingInodes,
					required: requiredInodes,
					activeGrants: grants.size,
				} satisfies StorageReserveWait;
			const requiredBytes = group.reduce(
				(total, entry) => total + entry.reserveBytes,
				0,
			);
			const freeBytes = first.bfree * first.bsize;
			const baselineBlocks = oldest?.bfree[first.index] ?? first.bfree;
			const outstandingBytes = Math.max(
				0,
				requiredBytes * grants.size -
					(baselineBlocks - first.bfree) * first.bsize,
			);
			if (requiredBytes > 0 && freeBytes - outstandingBytes < requiredBytes)
				return {
					kind: "disk",
					root: first.root,
					free: freeBytes,
					outstanding: outstandingBytes,
					required: requiredBytes,
					activeGrants: grants.size,
				} satisfies StorageReserveWait;
		}
		return undefined;
	}

	function grant(jobId: string, samples: readonly StorageSample[]) {
		grants.set(jobId, {
			grantedAtMs: now(),
			ffree: samples.map((entry) => entry.ffree),
			bfree: samples.map((entry) => entry.bfree),
		});
		reserveEpisode = false;
		return true;
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
		async admit(
			activeLeases: readonly WorkerStorageLease[],
			jobId: string,
			jobReserve: WorkerStorageReserve = defaultJobReserve,
		): Promise<boolean> {
			if (pnpmPruneInFlight) {
				if (!pnpmPruneWaitLogged)
					options.log?.("hobo_ci_storage_admission_wait", {
						message: "pnpm store prune in progress",
					});
				pnpmPruneWaitLogged = true;
				return false;
			}
			reconcile(activeLeases);
			let before: StorageSample[];
			try {
				before = await sample(jobReserve);
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
			const softPressure = before.some(
				(entry) => Math.max(entry.diskUsage, entry.inodeUsage) > softLimit,
			);
			if (!softPressure && !reserveShortage(before)) {
				hardEpisode = false;
				return grant(jobId, before);
			}
			const nowMs = now();
			if (
				lastAdmitMaintainMs === undefined ||
				nowMs - lastAdmitMaintainMs >= admitMaintainIntervalMs
			) {
				lastAdmitMaintainMs = nowMs;
				await maintain(activeLeases);
			}
			let after: StorageSample[];
			try {
				after = await sample(jobReserve);
			} catch (error) {
				options.log?.("hobo_ci_storage_admission_wait", {
					message: error instanceof Error ? error.message : "unknown",
				});
				return false;
			}
			const inodeHard = after.some((entry) => entry.inodeUsage > hardLimit);
			const diskHard = after.some((entry) => entry.diskUsage > hardLimit);
			if ((inodeHard || diskHard) && !hardEpisode) {
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
			const shortage = reserveShortage(after);
			if (shortage) {
				if (!reserveEpisode) {
					if (shortage.kind === "inode")
						options.log?.("hobo_ci_inode_reserve_wait", {
							root: shortage.root,
							freeInodes: shortage.free,
							outstandingInodes: shortage.outstanding,
							requiredInodes: shortage.required,
							activeGrants: shortage.activeGrants,
						});
					else
						options.log?.("hobo_ci_disk_reserve_wait", {
							root: shortage.root,
							freeBytes: shortage.free,
							outstandingBytes: shortage.outstanding,
							requiredBytes: shortage.required,
							activeGrants: shortage.activeGrants,
						});
				}
				reserveEpisode = true;
				return false;
			}
			if (!inodeHard && !diskHard) {
				if (
					after.every(
						(entry) => Math.max(entry.diskUsage, entry.inodeUsage) <= softLimit,
					)
				)
					hardEpisode = false;
				return grant(jobId, after);
			}
			return false;
		},
	};
}

export type WorkerStorageAdmission = ReturnType<
	typeof createWorkerStorageAdmission
>;
