import { chown, lstat, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { basename, join } from "node:path";
import { selectWorkerImagesForDeletion, type WorkerImage } from "./image-gc.js";

const SOFT_LIMIT = 0.85;
const HARD_LIMIT = 0.95;
const INODE_GRANT_GRACE_MS = 60_000;
const JOB_DIRECTORY = /^hobo-[0-9a-f-]{36}$/u;

export type WorkerFileSystemStats = Readonly<{
	blocks: number;
	bfree: number;
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
	prepareJobDirectory(path: string): Promise<void>;
	removeJobDirectory(path: string): Promise<WorkerWorkDirectoryRemoval>;
}>;

export type WorkerStorageDockerDriver = Readonly<{
	dataRoot(): Promise<string>;
	pruneBuilder(keepStorage: string): Promise<void>;
	containerExists(name: string): Promise<boolean>;
	listImages(): Promise<readonly WorkerImage[]>;
	removeImage(tag: string): Promise<void>;
	pruneDanglingImages(): Promise<void>;
}>;

export type WorkerStoragePnpmStore = Readonly<{
	prune(): Promise<void>;
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
		| "hobo_ci_storage_admission_wait"
		| "hobo_ci_storage_prune_failed",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export function createNodeWorkerStorageFileSystem(
	operations: Readonly<{
		chown: typeof chown;
		mkdir: typeof mkdir;
	}> = { chown, mkdir },
): WorkerStorageFileSystem {
	return {
		async statfs(path) {
			const stats = await statfs(path);
			return {
				blocks: stats.blocks,
				bfree: stats.bfree,
				files: stats.files,
				ffree: stats.ffree,
			};
		},
		async device(path) {
			return (await stat(path)).dev;
		},
		async jobDirectories(root) {
			const entries = await readdir(root, { withFileTypes: true });
			return entries
				.filter(
					(entry) => entry.isDirectory() && JOB_DIRECTORY.test(entry.name),
				)
				.map((entry) => join(root, entry.name));
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
		},
		async removeJobDirectory(path) {
			if (!JOB_DIRECTORY.test(basename(path)))
				throw new Error("invalid worker job directory");
			const measure = async (
				entryPath: string,
			): Promise<WorkerWorkDirectoryRemoval> => {
				const metadata = await lstat(entryPath);
				if (!metadata.isDirectory())
					return { bytes: metadata.size, entries: 1 };
				let bytes = 0;
				let entries = 1;
				for (const entry of await readdir(entryPath)) {
					const child = await measure(join(entryPath, entry));
					bytes += child.bytes;
					entries += child.entries;
				}
				return { bytes, entries };
			};
			const removed = await measure(path);
			await rm(path, { recursive: true, force: false });
			return removed;
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
	Readonly<{ device: number; ffree: number; reserve: number; index: number }>;

type InodeGrant = Readonly<{
	grantedAtMs: number;
	ffree: readonly number[];
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
	pnpmStore?: WorkerStoragePnpmStore;
	builderCacheCap?: string;
	softLimit?: number;
	hardLimit?: number;
	jobInodes?: Readonly<{ workRoot: number; dockerDataRoot: number }>;
	now?: () => number;
	log?: WorkerStorageLog;
}) {
	const softLimit = options.softLimit ?? SOFT_LIMIT;
	const hardLimit = options.hardLimit ?? HARD_LIMIT;
	if (!(softLimit > 0) || !(hardLimit > softLimit) || !(hardLimit < 1))
		throw new Error("invalid worker storage thresholds");
	const jobInodes = options.jobInodes ?? {
		workRoot: 200_000,
		dockerDataRoot: 170_000,
	};
	for (const reserve of [jobInodes.workRoot, jobInodes.dockerDataRoot])
		if (!Number.isSafeInteger(reserve) || reserve < 0)
			throw new Error("invalid worker job inode reservation");
	const reservations = [
		{ root: options.dockerDataRoot, reserve: jobInodes.dockerDataRoot },
		{ root: options.workRoot, reserve: jobInodes.workRoot },
	];
	const now = options.now ?? Date.now;
	const grants = new Map<string, InodeGrant>();
	let hardEpisode = false;
	let reserveEpisode = false;
	let unavailable = false;

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
					reserve: reservation.reserve,
					index,
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
		let oldest: InodeGrant | undefined;
		for (const grant of grants.values())
			if (!oldest || grant.grantedAtMs < oldest.grantedAtMs) oldest = grant;
		for (const group of groups.values()) {
			const first = group[0];
			if (!first) continue;
			const requiredInodes = group.reduce(
				(total, entry) => total + entry.reserve,
				0,
			);
			const baseline = oldest?.ffree[first.index] ?? first.ffree;
			// Consumption since the oldest grant belongs to all grants; freed inodes only increase conservatism.
			const outstandingInodes = Math.max(
				0,
				requiredInodes * grants.size - (baseline - first.ffree),
			);
			if (
				requiredInodes > 0 &&
				first.ffree - outstandingInodes < requiredInodes
			)
				return {
					root: first.root,
					freeInodes: first.ffree,
					outstandingInodes,
					requiredInodes,
					activeGrants: grants.size,
				} satisfies InodeReserveWait;
		}
		return undefined;
	}

	function grant(jobId: string, samples: readonly StorageSample[]) {
		grants.set(jobId, {
			grantedAtMs: now(),
			ffree: samples.map((entry) => entry.ffree),
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

	async function reap(activeLeases: readonly WorkerStorageLease[]) {
		const liveNames = new Set(
			activeLeases.flatMap((lease) => [
				`hobo-${lease.id}`,
				...(lease.sandboxName ? [lease.sandboxName] : []),
			]),
		);
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
		for (const directory of directories) {
			const name = basename(directory);
			if (liveNames.has(name)) continue;
			try {
				if (await options.docker.containerExists(name)) continue;
				await options.fs.removeJobDirectory(directory);
			} catch (error) {
				options.log?.("hobo_ci_storage_prune_failed", {
					operation: "remove-work-dir",
					message: error instanceof Error ? error.message : "unknown",
				});
			}
		}
	}

	async function maintain(activeLeases: readonly WorkerStorageLease[]) {
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
		if (pnpmStore && activeLeases.length === 0)
			await attempt("pnpm-store", () => pnpmStore.prune());
		await reap(activeLeases);
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
		): Promise<boolean> {
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
			const softPressure = before.some(
				(entry) => Math.max(entry.diskUsage, entry.inodeUsage) > softLimit,
			);
			if (!softPressure && !reserveShortage(before)) {
				hardEpisode = false;
				return grant(jobId, before);
			}
			await maintain(activeLeases);
			let after: StorageSample[];
			try {
				after = await sample();
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
				if (!reserveEpisode)
					options.log?.("hobo_ci_inode_reserve_wait", shortage);
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
