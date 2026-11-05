import { join } from "node:path";
import type { WorkerStorageFileSystem } from "./storage-admission.js";

export function createRetiredWorkDirectorySweeper(options: {
	fs: WorkerStorageFileSystem;
	workRoot: string;
	log?: (
		event: "hobo_ci_work_dir_removed" | "hobo_ci_work_dir_remove_failed",
		fields: Readonly<Record<string, string | number | boolean>>,
	) => void;
}) {
	let running: Promise<void> | undefined;
	let rerun = false;
	const retiredRoot = join(options.workRoot, ".retired");

	async function sweep() {
		do {
			rerun = false;
			let directories: readonly string[];
			try {
				directories = await options.fs.retiredDirectories(options.workRoot);
			} catch (error) {
				options.log?.("hobo_ci_work_dir_remove_failed", {
					path: retiredRoot,
					message: error instanceof Error ? error.message : "unknown",
				});
				continue;
			}
			for (const path of directories) {
				const startedAt = Date.now();
				try {
					const removed = await options.fs.removeJobDirectory(path);
					options.log?.("hobo_ci_work_dir_removed", {
						path,
						bytes: removed.bytes,
						entries: removed.entries,
						ms: Date.now() - startedAt,
					});
				} catch (error) {
					options.log?.("hobo_ci_work_dir_remove_failed", {
						path,
						message: error instanceof Error ? error.message : "unknown",
					});
				}
			}
		} while (rerun);
	}

	return {
		trigger() {
			if (running) {
				rerun = true;
				return;
			}
			running = sweep().finally(() => {
				running = undefined;
			});
		},
		async drain() {
			await running;
		},
	};
}
