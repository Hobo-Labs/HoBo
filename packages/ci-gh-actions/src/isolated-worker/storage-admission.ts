import { readdir, rm, statfs } from "node:fs/promises";
import { basename, join } from "node:path";

const SOFT_LIMIT = 0.85;
const HARD_LIMIT = 0.95;
const JOB_DIRECTORY = /^hobo-[0-9a-f-]{36}$/u;

export type WorkerFileSystemStats = Readonly<{
	blocks: number;
	bfree: number;
	files: number;
	ffree: number;
}>;

export type WorkerStorageFileSystem = Readonly<{
	statfs(path: string): Promise<WorkerFileSystemStats>;
	jobDirectories(root: string): Promise<readonly string[]>;
	removeJobDirectory(path: string): Promise<void>;
}>;

export type WorkerStorageDockerDriver = Readonly<{
	dataRoot(): Promise<string>;
	pruneBuilder(until: string): Promise<void>;
	containerExists(name: string): Promise<boolean>;
}>;

export type WorkerStorageLease = Readonly<{
	id: string;
	sandboxName: string;
}>;

export type WorkerStorageLog = (
	event:
		| "hobo_ci_inode_pressure"
		| "hobo_ci_storage_admission_wait"
		| "hobo_ci_storage_prune_failed",
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export function createNodeWorkerStorageFileSystem(): WorkerStorageFileSystem {
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
		async jobDirectories(root) {
			const entries = await readdir(root, { withFileTypes: true });
			return entries
				.filter(
					(entry) => entry.isDirectory() && JOB_DIRECTORY.test(entry.name),
				)
				.map((entry) => join(root, entry.name));
		},
		async removeJobDirectory(path) {
			if (!JOB_DIRECTORY.test(basename(path)))
				throw new Error("invalid worker job directory");
			await rm(path, { recursive: true, force: false });
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

export function createWorkerStorageAdmission(options: {
	dockerDataRoot: string;
	workRoot: string;
	fs: WorkerStorageFileSystem;
	docker: WorkerStorageDockerDriver;
	softLimit?: number;
	hardLimit?: number;
	log?: WorkerStorageLog;
}) {
	const softLimit = options.softLimit ?? SOFT_LIMIT;
	const hardLimit = options.hardLimit ?? HARD_LIMIT;
	if (!(softLimit > 0) || !(hardLimit > softLimit) || !(hardLimit < 1))
		throw new Error("invalid worker storage thresholds");
	let hardEpisode = false;
	let unavailable = false;

	async function sample(): Promise<Pressure[]> {
		return Promise.all(
			[options.dockerDataRoot, options.workRoot].map(async (root) =>
				pressure(root, await options.fs.statfs(root)),
			),
		);
	}

	async function prune(activeLeases: readonly WorkerStorageLease[]) {
		try {
			await options.docker.pruneBuilder("24h");
		} catch (error) {
			options.log?.("hobo_ci_storage_prune_failed", {
				operation: "builder",
				message: error instanceof Error ? error.message : "unknown",
			});
		}
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

	return {
		async admit(activeLeases: readonly WorkerStorageLease[]): Promise<boolean> {
			let before: Pressure[];
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
			if (
				!before.some(
					(entry) => Math.max(entry.diskUsage, entry.inodeUsage) > softLimit,
				)
			) {
				hardEpisode = false;
				return true;
			}
			await prune(activeLeases);
			let after: Pressure[];
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
			if (!inodeHard && !diskHard) {
				if (
					after.every(
						(entry) => Math.max(entry.diskUsage, entry.inodeUsage) <= softLimit,
					)
				)
					hardEpisode = false;
				return true;
			}
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
		},
	};
}

export type WorkerStorageAdmission = ReturnType<
	typeof createWorkerStorageAdmission
>;
