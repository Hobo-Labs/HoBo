import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerStore } from "../src/owner-store.js";
import { ownerWriteGuard } from "../src/owner-write-guard.js";

function supportsOwnerGuard(): boolean {
	if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
		return false;
	const directory = mkdtempSync(join(tmpdir(), "hobo-owner-guard-probe-"));
	try {
		let current = realpathSync(directory);
		for (;;) {
			const handle = openSync(
				current,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				fsyncSync(handle);
			} finally {
				closeSync(handle);
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return true;
	} catch {
		return false;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

let home: string;
let project: string;
let state: string;
let config: string;

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "hobo-terminal-guard-")));
	project = join(home, "project");
	state = join(home, "state");
	config = join(home, "config");
	await mkdir(project);
	vi.stubEnv("XDG_STATE_HOME", state);
	vi.stubEnv("XDG_CONFIG_HOME", config);
	vi.stubEnv("HOME", home);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

async function openTerminalStore(cwd: string, port: SecretsPort) {
	const vault = createTrustedVault();
	vault.put("INFISICAL_TOKEN", `synthetic-${randomUUID()}`);
	const selected = await ownerStore("cd", vault, {
		cwd,
		env: {
			HOME: home,
			XDG_CONFIG_HOME: config,
			XDG_STATE_HOME: state,
			HOBO_SECRET_STORE: "infisical",
			INFISICAL_PROJECT_ID: "synthetic-project",
		},
		openStore: async (id) => ({
			ok: true,
			store: {
				id,
				port,
				reference: () => "synthetic-ref",
			},
		}),
	});
	if (!selected.opened) throw new Error("The terminal store did not open.");
	return selected.opened;
}

describe.runIf(supportsOwnerGuard())("terminal owner store guard", () => {
	it("writes through the default file locator and clears the guard", async () => {
		const memory = createMemorySecretsPort({ id: "memory" });
		const store = await openTerminalStore(project, memory);
		expect(store.withWriteLock).toEqual(expect.any(Function));
		await store.port.put("HOBO_CD_ONE", "synthetic-one");
		await store.port.put("HOBO_CD_TWO", "synthetic-two");
		expect(await memory.access("HOBO_CD_ONE")).toMatchObject({
			status: "ok",
			material: "synthetic-one",
		});
		expect(await memory.access("HOBO_CD_TWO")).toMatchObject({
			status: "ok",
			material: "synthetic-two",
		});
		expect(() =>
			ownerWriteGuard(`cd\u0000${project}`, project).assertClear(),
		).not.toThrow();
	});

	it("does not write when the shared scope is marked uncertain", async () => {
		const memory = createMemorySecretsPort({ id: "memory" });
		const store = await openTerminalStore(project, memory);
		ownerWriteGuard(`cd\u0000${project}`, project).markUncertain();
		await expect(
			store.port.put("HOBO_CD_EXAMPLE", "synthetic"),
		).rejects.toThrow(/uncertain outcome/u);
		expect(await memory.access("HOBO_CD_EXAMPLE")).toMatchObject({
			status: "denied",
			code: "secret-not-found",
		});
	});

	it("does not write while another owner holds the guard nonce", async () => {
		const memory = createMemorySecretsPort({ id: "memory" });
		const store = await openTerminalStore(project, memory);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: () => void = () => undefined;
		const inside = new Promise<void>((resolve) => {
			started = resolve;
		});
		const running = ownerWriteGuard(`cd\u0000${project}`, project).run(
			async () => {
				started();
				await held;
			},
			() => false,
		);
		try {
			await inside;
			await expect(
				store.port.put("HOBO_CD_EXAMPLE", "synthetic"),
			).rejects.toThrow(/uncertain outcome/u);
			expect(await memory.access("HOBO_CD_EXAMPLE")).toMatchObject({
				status: "denied",
				code: "secret-not-found",
			});
		} finally {
			release();
			await running;
		}
	});

	it("refuses a write when the guard is unavailable", async () => {
		const memory = createMemorySecretsPort({ id: "memory" });
		const store = await openTerminalStore(join(home, "missing"), memory);
		await expect(
			store.port.put("HOBO_CD_EXAMPLE", "synthetic"),
		).rejects.toThrow(/unavailable/u);
		expect(await memory.access("HOBO_CD_EXAMPLE")).toMatchObject({
			status: "denied",
			code: "secret-not-found",
		});
	});
});
