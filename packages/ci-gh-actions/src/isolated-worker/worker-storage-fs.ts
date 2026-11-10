/**
 * Host workdir filesystem helpers for isolated CI jobs.
 * Kept dependency-free (Node built-ins only) so deps-image mount verify can
 * import this module before the full {@link ./storage-admission.js} graph loads.
 */
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

const JOB_DIRECTORY = /^hobo-[0-9a-f-]{36}$/u;
const RETIRED_JOB_DIRECTORY = /^hobo-[0-9a-f-]{36}-[0-9a-z]+$/u;
const RETIRED_ROOT = ".retired";

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
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return [];
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
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return undefined;
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
