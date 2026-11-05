import { spawn } from "node:child_process";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
	PnpmStorePruneOutcome,
	PnpmStorePruneResult,
	WorkerStoragePnpmStore,
} from "./storage-admission.js";

export type {
	PnpmStorePruneOutcome,
	PnpmStorePruneResult,
} from "./storage-admission.js";

const ErrnoCode = z.object({ code: z.string() });
const lockSchema = z.object({
	pid: z.number().int().positive(),
	startedAt: z.string().datetime(),
});
const stampSchema = z.string().datetime();
const nodeFs = { open, readFile, unlink, writeFile };

export type PnpmStorePruneChild = {
	pid?: number;
	once(event: "error", listener: (error: Error) => void): void;
	once(
		event: "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
};

export type PnpmStorePruneSpawn = (
	binary: string,
	args: readonly string[],
	options: Readonly<{
		env: NodeJS.ProcessEnv;
		detached: true;
		stdio: "ignore";
	}>,
) => PnpmStorePruneChild;

export type PnpmStoreMaintenanceOptions = Readonly<{
	path: string;
	binary?: string;
	env?: NodeJS.ProcessEnv;
	lockPath?: string;
	stampPath?: string;
	minIntervalMs?: number;
	timeoutMs?: number;
	spawn?: PnpmStorePruneSpawn;
	fs?: Readonly<{
		open: typeof open;
		readFile: typeof readFile;
		unlink: typeof unlink;
		writeFile: typeof writeFile;
	}>;
	now?: () => number;
	kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
	isProcessAlive?: (pid: number) => boolean;
}>;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const parsed = ErrnoCode.safeParse(error);
		return parsed.success && parsed.data.code === "EPERM";
	}
}

export function createPnpmStoreMaintenance(
	options: PnpmStoreMaintenanceOptions,
): WorkerStoragePnpmStore {
	if (!/^\/[^:\r\n]+$/u.test(options.path))
		throw new Error("invalid pnpm store path");
	const fs = options.fs ?? nodeFs;
	const lockPath =
		options.lockPath ?? join(dirname(options.path), "pnpm-store-prune.lock");
	const stampPath =
		options.stampPath ?? join(dirname(options.path), "pnpm-store-prune.stamp");
	const minIntervalMs = options.minIntervalMs ?? 21_600_000;
	const timeoutMs = options.timeoutMs ?? 300_000;
	const spawnProcess = options.spawn ?? spawn;
	const kill = options.kill ?? process.kill;
	const now = options.now ?? Date.now;
	const isProcessAlive = options.isProcessAlive ?? processAlive;
	let inFlight: Promise<PnpmStorePruneOutcome> | undefined;

	function outcome(
		result: PnpmStorePruneResult,
		startedAt: number,
	): PnpmStorePruneOutcome {
		return { result, ms: now() - startedAt };
	}

	async function rateLimited(): Promise<boolean> {
		try {
			const stamp = stampSchema.parse(
				(await fs.readFile(stampPath, "utf8")).trim(),
			);
			return now() - Date.parse(stamp) < minIntervalMs;
		} catch {
			return false;
		}
	}

	async function createLock(startedAt: number): Promise<void> {
		const handle = await fs.open(lockPath, "wx");
		try {
			await handle.writeFile(
				JSON.stringify({
					pid: process.pid,
					startedAt: new Date(startedAt).toISOString(),
				}),
			);
		} finally {
			await handle.close();
		}
	}

	async function acquireLock(startedAt: number): Promise<boolean> {
		try {
			await createLock(startedAt);
			return true;
		} catch (error) {
			const parsed = ErrnoCode.safeParse(error);
			if (!parsed.success || parsed.data.code !== "EEXIST") throw error;
		}
		try {
			const lock = lockSchema.parse(
				JSON.parse(await fs.readFile(lockPath, "utf8")),
			);
			if (isProcessAlive(lock.pid)) return false;
		} catch {
			// An unreadable or malformed lock is stale.
		}
		await fs.unlink(lockPath);
		try {
			await createLock(startedAt);
			return true;
		} catch {
			return false;
		}
	}

	async function spawnPrune(): Promise<PnpmStorePruneResult> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (result: PnpmStorePruneResult) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve(result);
			};
			const child = spawnProcess(
				options.binary ?? "pnpm",
				["store", "prune", "--store-dir", options.path],
				{
					env: options.env ?? process.env,
					detached: true,
					stdio: "ignore",
				},
			);
			child.once("error", () => finish("failed"));
			child.once("close", (code) => finish(code === 0 ? "pruned" : "failed"));
			timer = setTimeout(() => {
				if (child.pid !== undefined) {
					try {
						kill(-child.pid, "SIGKILL");
					} catch (error) {
						const parsed = ErrnoCode.safeParse(error);
						if (!parsed.success || parsed.data.code !== "ESRCH") {
							finish("failed");
							return;
						}
					}
				}
				finish("failed");
			}, timeoutMs);
		});
	}

	async function run(
		idle: () => Promise<boolean>,
		startedAt: number,
	): Promise<PnpmStorePruneOutcome> {
		let locked = false;
		try {
			if (await rateLimited()) return outcome("rate-limited", startedAt);
			locked = await acquireLock(startedAt);
			if (!locked) return outcome("locked", startedAt);
			if (await rateLimited()) return outcome("rate-limited", startedAt);
			if (!(await idle())) return outcome("busy", startedAt);
			await fs.writeFile(stampPath, new Date(startedAt).toISOString(), "utf8");
			return outcome(await spawnPrune(), startedAt);
		} catch {
			return outcome("failed", startedAt);
		} finally {
			if (locked) await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return {
		async prune(idle) {
			const startedAt = now();
			if (inFlight) return outcome("in-flight", startedAt);
			const current = run(idle, startedAt);
			inFlight = current;
			try {
				return await current;
			} finally {
				if (inFlight === current) inFlight = undefined;
			}
		},
	};
}
