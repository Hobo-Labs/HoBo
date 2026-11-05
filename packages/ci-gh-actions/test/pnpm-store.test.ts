import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPnpmStoreMaintenance } from "../src/isolated-worker/pnpm-store.js";

const idle = async () => true;
const NOW = 1_800_000_000_000;
type Options = Parameters<typeof createPnpmStoreMaintenance>[0];
type Spawn = NonNullable<Options["spawn"]>;

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hobo-pnpm-store-prune-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function setup(overrides: Partial<Options> = {}) {
	const child = Object.assign(new EventEmitter(), { pid: 4242 });
	const spawn = vi.fn<Spawn>(() => {
		queueMicrotask(() => child.emit("close", 0, null));
		return child;
	});
	const store = createPnpmStoreMaintenance({
		path: join(directory, "store"),
		env: {},
		now: () => NOW,
		spawn,
		...overrides,
	});
	return { child, spawn, store };
}

describe("pnpm store maintenance", () => {
	it("runs only one prune for concurrent calls", async () => {
		const child = Object.assign(new EventEmitter(), { pid: 4242 });
		const spawn = vi.fn<Spawn>(() => child);
		const { store } = setup({ spawn });

		const first = store.prune(idle);
		const second = store.prune(idle);
		await expect(second).resolves.toMatchObject({ result: "in-flight" });
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		child.emit("close", 0, null);

		await expect(first).resolves.toMatchObject({ result: "pruned" });
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("skips a lock held by a live process", async () => {
		const lockPath = join(directory, "pnpm-store-prune.lock");
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 123, startedAt: new Date(NOW).toISOString() }),
		);
		const { spawn, store } = setup({
			isProcessAlive: () => true,
		});

		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "locked",
		});
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(lockPath)).toBe(true);
	});

	it("replaces a stale lock whose process is dead", async () => {
		const lockPath = join(directory, "pnpm-store-prune.lock");
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 123, startedAt: new Date(NOW).toISOString() }),
		);
		const { spawn, store } = setup({
			isProcessAlive: () => false,
		});

		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "pruned",
		});
		expect(spawn).toHaveBeenCalledOnce();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("replaces an unparseable lock", async () => {
		const lockPath = join(directory, "pnpm-store-prune.lock");
		writeFileSync(lockPath, "not json");
		const { spawn, store } = setup();

		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "pruned",
		});
		expect(spawn).toHaveBeenCalledOnce();
		expect(existsSync(lockPath)).toBe(false);
	});

	it("rate-limits a second prune within the interval", async () => {
		const { spawn, store } = setup();

		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "pruned",
		});
		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "rate-limited",
		});
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("rate-limits after a failed prune", async () => {
		const child = Object.assign(new EventEmitter(), { pid: 4242 });
		const spawn = vi.fn<Spawn>(() => {
			queueMicrotask(() => child.emit("close", 1, null));
			return child;
		});
		const { store } = setup({ spawn });

		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "failed",
		});
		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "rate-limited",
		});
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("reads the rate-limit stamp from a previous maintenance instance", async () => {
		const first = setup();
		await expect(first.store.prune(idle)).resolves.toMatchObject({
			result: "pruned",
		});
		const second = setup();

		await expect(second.store.prune(idle)).resolves.toMatchObject({
			result: "rate-limited",
		});
		expect(second.spawn).not.toHaveBeenCalled();
	});

	it("rechecks the rate limit after acquiring the lock", async () => {
		const { open, readFile, unlink, writeFile } = await import(
			"node:fs/promises"
		);
		const stampPath = join(directory, "pnpm-store-prune.stamp");
		const fs: NonNullable<Options["fs"]> = {
			open: async (path, flags, mode) => {
				await writeFile(stampPath, new Date(NOW).toISOString(), "utf8");
				return open(path, flags, mode);
			},
			readFile,
			unlink,
			writeFile,
		};
		const { spawn, store } = setup({ fs });

		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "rate-limited",
		});
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(directory, "pnpm-store-prune.lock"))).toBe(false);
	});

	it("does not spawn or stamp while the store is busy", async () => {
		const { spawn, store } = setup();

		await expect(store.prune(async () => false)).resolves.toMatchObject({
			result: "busy",
		});
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(directory, "pnpm-store-prune.stamp"))).toBe(false);
	});

	it("kills the detached process group on timeout", async () => {
		const child = Object.assign(new EventEmitter(), { pid: 4242 });
		const spawn = vi.fn<Spawn>(() => child);
		const kill = vi.fn<(pid: number, signal: NodeJS.Signals | 0) => void>();
		const { store } = setup({ spawn, kill, timeoutMs: 10 });

		await expect(store.prune(idle)).resolves.toMatchObject({
			result: "failed",
		});
		expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
		expect(spawn).toHaveBeenCalledWith(
			"pnpm",
			["store", "prune", "--store-dir", join(directory, "store")],
			{ env: {}, detached: true, stdio: "ignore" },
		);
	});
});
