import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerStoragePnpmStore } from "./storage-admission.js";

const exec = promisify(execFile);

export function createPnpmStoreMaintenance(options: {
	path: string;
	binary?: string;
	env?: NodeJS.ProcessEnv;
}): WorkerStoragePnpmStore {
	if (!/^\/[^:\r\n]+$/u.test(options.path))
		throw new Error("invalid pnpm store path");
	return {
		async prune() {
			await exec(
				options.binary ?? "pnpm",
				["store", "prune", "--store-dir", options.path],
				{
					env: options.env ?? process.env,
					timeout: 300_000,
					maxBuffer: 1024 * 1024,
				},
			);
		},
	};
}
