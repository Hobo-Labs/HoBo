import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { fileSettingsStore } from "@hobo/connect-ui";
import { createTrustedVault } from "@hobo/core";
import {
	captureAll,
	OwnerStoreOperationUncertainError,
	ownerStore,
	ownerStoreSessionEnvironment,
	secretStoreLocatorPath,
	withStoreWriteLock,
} from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { CapturedSecret } from "@hobo/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ownerForFamily } from "../src/cli.js";
import {
	INFISICAL_CLI_SESSION,
	OWNER_HANDOFF_SPECS,
} from "../src/mcp-owner-channel.js";
import { composeHoboMcp } from "../src/mcp-serve.js";
import { loadOwnerDeployCredentials } from "../src/owner-deploy-credentials.js";
import { ownerWriteGuard } from "../src/owner-write-guard.js";
import { supportsOwnerGuard } from "./support/owner-guard-support.js";

const test = supportsOwnerGuard() ? it : it.skip;
let guardState: string;
beforeEach(async () => {
	guardState = await mkdtemp(join(tmpdir(), "hobo-owner-guard-state-"));
	vi.stubEnv("XDG_STATE_HOME", guardState);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(guardState, { recursive: true, force: true });
});

describe("MCP owner store session", () => {
	test("invalidates another server's stale selection and vault", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-generation-"));
		vi.stubEnv("XDG_CONFIG_HOME", home);
		await fileSettingsStore(secretStoreLocatorPath(home)).write({
			HOBO_SECRET_STORE: "1password",
			OP_VAULT_ID: "abcdefghijklmnopqrstuvwxyz",
			OTHER_SETTING: "preserved",
		});
		const first = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		const second = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const older = first.owner.storeSettingsFor?.("cd", home);
			const newer = second.owner.storeSettingsFor?.("cd", home);
			const vault = first.owner.vaultFor?.("cd", home);
			if (!older || !newer || !vault)
				throw new Error("No scoped owner session.");
			await older.write({ HOBO_SECRET_STORE: "bitwarden" });
			vault.put("SYNTHETIC_TOKEN", "fixture");
			newer.onOwnerChoice?.();
			await expect(older.read()).rejects.toThrow(/owner session changed/u);
			expect(vault.has("SYNTHETIC_TOKEN")).toBe(false);
			const fresh = first.owner.storeSettingsFor?.("cd", home);
			if (!fresh?.runStoreWrite) throw new Error("No refreshed owner session.");
			expect(await fresh.read()).toEqual({ OTHER_SETTING: "preserved" });
			expect(fresh.requiresOwnerChoice?.()).toBe(true);
			expect(
				await ownerStoreSessionEnvironment(
					{ locator: fresh },
					{
						HOBO_SECRET_STORE: "bitwarden",
						BW_CLIENTID: "synthetic-id",
						KEEP: "yes",
					},
				),
			).toEqual({ KEEP: "yes" });
			let dispatched = false;
			await expect(
				fresh.runStoreWrite(async () => {
					dispatched = true;
				}),
			).rejects.toThrow(/owner form/u);
			expect(dispatched).toBe(false);
			const restarted = composeHoboMcp({
				output: new PassThrough(),
				projectDir: home,
				remote: true,
			});
			try {
				const afterRestart = restarted.owner.storeSettingsFor?.("cd", home);
				if (!afterRestart?.runStoreWrite)
					throw new Error("No restarted owner session.");
				expect(afterRestart.requiresOwnerChoice?.()).toBe(true);
				expect(await afterRestart.read()).toEqual({
					OTHER_SETTING: "preserved",
				});
				await expect(
					afterRestart.runStoreWrite(async () => undefined),
				).rejects.toThrow(/owner form/u);
			} finally {
				await restarted.close();
			}
			fresh.onOwnerChoice?.();
			const reselected = first.owner.storeSettingsFor?.("cd", home);
			if (!reselected?.runStoreWrite)
				throw new Error("No reselected owner session.");
			await reselected.write({ HOBO_SECRET_STORE: "infisical" });
			await expect(reselected.runStoreWrite(async () => "done")).resolves.toBe(
				"done",
			);
		} finally {
			await first.close();
			await second.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("shares the local guard across canonical project paths", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-canonical-"));
		const project = join(home, "project");
		const alias = join(home, "alias");
		await mkdir(project);
		await symlink(project, alias);
		const first = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		const second = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		let release: () => void = () => undefined;
		try {
			const left = first.owner.storeSettingsFor?.("cd", project);
			const right = second.owner.storeSettingsFor?.("cd", alias);
			if (!left?.runStoreWrite || !right?.runStoreWrite)
				throw new Error("No write transaction.");
			let started: () => void = () => undefined;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const write = left.runStoreWrite(async () => {
				started();
				await pending;
			});
			await entered;
			await expect(right.runStoreWrite(async () => undefined)).rejects.toThrow(
				/uncertain outcome/u,
			);
			release();
			await write;
			await expect(
				right.runStoreWrite(async () => undefined),
			).resolves.toBeUndefined();
		} finally {
			release();
			await first.close();
			await second.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("advances the shared store revision across a change and exact revert", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-revision-"));
		const first = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		const second = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const settings = first.owner.storeSettingsFor?.("cd", home);
			const other = second.owner.storeSettingsFor?.("cd", home);
			const ci = second.owner.storeSettingsFor?.("ci", home);
			if (
				!settings?.selectionRevision ||
				!settings.locatorRevision ||
				!settings.runStoreWrite ||
				!other?.selectionRevision ||
				!other.locatorRevision ||
				!ci?.selectionRevision
			)
				throw new Error("No scoped settings revision.");
			const initial = settings.selectionRevision();
			const initialLocator = settings.locatorRevision();
			const ciInitial = ci.selectionRevision();
			const base = {
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-first",
				UNRELATED: "one",
			};
			await settings.write(base);
			const captured = settings.selectionRevision();
			const capturedLocator = settings.locatorRevision();
			expect(captured).toBe(initial + 1);
			expect(capturedLocator).toBe(initialLocator + 1);
			expect(other.selectionRevision()).toBe(captured);
			expect(other.locatorRevision()).toBe(capturedLocator);
			const readFromProcess = async (kind = "revision") => {
				const child = spawn(
					process.execPath,
					[
						"--import",
						"tsx",
						fileURLToPath(
							new URL("./support/owner-write-guard-child.ts", import.meta.url),
						),
						kind,
						await realpath(home),
					],
					{ env: process.env, stdio: ["ignore", "pipe", "pipe"] },
				);
				const closed = once(child, "close");
				try {
					const output = await Promise.race([
						once(child.stdout, "data").then(([value]) => String(value)),
						closed.then(() => {
							throw new Error("The synthetic revision reader exited early.");
						}),
					]);
					const [code] = await closed;
					expect(code).toBe(0);
					return output.trim();
				} finally {
					child.kill("SIGKILL");
					await closed;
				}
			};
			expect(await readFromProcess()).toBe(String(captured));
			await settings.write({ ...base, UNRELATED: "two" });
			expect(settings.selectionRevision()).toBe(captured);
			expect(settings.locatorRevision()).toBe(capturedLocator);
			await settings.write({
				...base,
				INFISICAL_PROJECT_ID: "synthetic-second",
			});
			await settings.write(base);
			expect(settings.selectionRevision()).toBe(captured + 2);
			expect(other.selectionRevision()).toBe(captured + 2);
			expect(settings.locatorRevision()).toBe(capturedLocator + 2);
			expect(other.locatorRevision()).toBe(capturedLocator + 2);
			expect(await readFromProcess()).toBe(String(captured + 2));
			expect(ci.selectionRevision()).toBe(ciInitial);
			await settings.runStoreWrite(async () => {
				expect(settings.selectionRevision?.()).toBe(captured + 2);
				await settings.write({
					...base,
					INFISICAL_PROJECT_ID: "synthetic-third",
				});
				expect(settings.selectionRevision?.()).toBe(captured + 3);
			});
			expect(settings.selectionRevision()).toBe(captured + 3);
			expect(other.selectionRevision()).toBe(captured + 3);
			expect(settings.locatorRevision()).toBe(capturedLocator + 3);
		} finally {
			await first.close();
			await second.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("advances the shared revision for credential writes and exact reverts", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-secret-revision-"));
		const first = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		const second = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const settings = first.owner.storeSettingsFor?.("cd", home);
			const other = second.owner.storeSettingsFor?.("cd", home);
			const vault = first.owner.vaultFor?.("cd", home);
			if (
				!settings?.selectionRevision ||
				!settings.locatorRevision ||
				!other?.selectionRevision ||
				!other.locatorRevision ||
				!vault
			)
				throw new Error("No scoped settings revision.");
			await settings.write({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-project",
			});
			vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
			const memory = createMemorySecretsPort({ id: "memory" });
			const selected = await ownerStore("cd", vault, {
				locator: settings,
				env: {},
				openStore: async (id) => ({
					ok: true,
					store: { id, reference: () => "private", port: memory },
				}),
			});
			if (!selected.opened?.port.createOnly) throw new Error("No owner store.");
			const captured = settings.selectionRevision();
			const locatorBefore = settings.locatorRevision();
			expect(settings.canReuseOwnerProof?.()).toBe(false);
			expect(settings.hasExclusiveMutationAuthority?.()).toBe(false);
			await selected.opened.port.put("SYNTHETIC_CREDENTIAL", "first");
			await selected.opened.port.put("SYNTHETIC_CREDENTIAL", "second");
			await selected.opened.port.put("SYNTHETIC_CREDENTIAL", "first");
			await selected.opened.port.createOnly("SYNTHETIC_SETTING", "fixture");
			expect(settings.selectionRevision()).toBe(captured + 4);
			expect(other.selectionRevision()).toBe(captured + 4);
			expect(settings.locatorRevision()).toBe(locatorBefore);
			expect(other.locatorRevision()).toBe(locatorBefore + 4);
			const older = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					fileURLToPath(
						new URL("./support/owner-write-guard-child.ts", import.meta.url),
					),
					"legacy-aba",
					await realpath(home),
				],
				{ env: process.env, stdio: ["ignore", "pipe", "pipe"] },
			);
			const closed = once(older, "close");
			try {
				const output = await Promise.race([
					once(older.stdout, "data").then(([value]) => String(value)),
					closed.then(() => {
						throw new Error("The synthetic older writer exited early.");
					}),
				]);
				expect(output).toBe("changed\n");
				await closed;
			} finally {
				older.kill("SIGKILL");
				await closed;
			}
			expect(settings.locatorRevision()).toBe(locatorBefore + 2);
			await selected.opened.port.put("SYNTHETIC_CREDENTIAL", "fourth");
			expect(settings.locatorRevision()).toBe(locatorBefore + 2);
			expect(other.locatorRevision()).toBe(locatorBefore + 7);
		} finally {
			await first.close();
			await second.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("rejects another settings change while a guarded write is in flight", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-revision-write-"));
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		let release: () => void = () => undefined;
		try {
			const settings = mcp.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite || !settings.selectionRevision)
				throw new Error("No scoped settings revision.");
			await settings.write({ HOBO_SECRET_STORE: "infisical" });
			const initial = settings.selectionRevision();
			let started: () => void = () => undefined;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const writing = settings.runStoreWrite(async () => {
				started();
				await pending;
			});
			await entered;
			await expect(
				settings.write({ HOBO_SECRET_STORE: "bitwarden" }),
			).rejects.toThrow(/saving a change/u);
			expect(() => settings.selectionRevision?.()).toThrow(/saving a change/u);
			release();
			await writing;
			expect(settings.selectionRevision()).toBe(initial);
		} finally {
			release();
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("invalidates a session when its project symlink is retargeted", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-retarget-"));
		const first = join(home, "first");
		const second = join(home, "second");
		const alias = join(home, "alias");
		await Promise.all([mkdir(first), mkdir(second)]);
		await symlink(first, alias);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const settings = mcp.owner.storeSettingsFor?.("cd", alias);
			const vault = mcp.owner.vaultFor?.("cd", alias);
			const scoped = mcp.owner.forScope?.("cd", alias);
			if (!settings?.runStoreWrite || !vault || !scoped)
				throw new Error("No scoped owner session.");
			await settings.write({ HOBO_SECRET_STORE: "infisical" });
			vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
			scoped.reserveCaptures?.([INFISICAL_CLI_SESSION]);
			mcp.owner.deposit(INFISICAL_CLI_SESSION, "A".repeat(24));
			const handoff = mcp.owner.handoffFor(INFISICAL_CLI_SESSION);
			if (!handoff) throw new Error("No pending handoff.");
			await rm(alias);
			await symlink(second, alias);
			await expect(settings.read()).rejects.toThrow(/session changed/u);
			expect(vault.names()).toEqual([]);
			expect(handoff.held()).toBe(false);
			let dispatched = false;
			await expect(
				settings.runStoreWrite(async () => {
					dispatched = true;
				}),
			).rejects.toThrow(/session changed/u);
			expect(dispatched).toBe(false);
			await rm(alias);
			await symlink(first, alias);
			await expect(settings.read()).rejects.toThrow(/session changed/u);
			const refreshed = mcp.owner.storeSettingsFor?.("cd", first);
			expect(refreshed?.requiresOwnerChoice?.()).toBe(true);
		} finally {
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("rejects a retarget while binding the channel, vault, and settings", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-binding-"));
		const first = join(home, "first");
		const second = join(home, "second");
		const alias = join(home, "alias");
		await Promise.all([mkdir(first), mkdir(second)]);
		await symlink(first, alias);
		let checks = 0;
		const guardFor: typeof ownerWriteGuard = (scope, cwd, platform) => {
			const guard = ownerWriteGuard(scope, cwd, platform);
			return {
				...guard,
				currentSelection: () => {
					checks++;
					if (checks === 2) {
						rmSync(alias);
						symlinkSync(second, alias);
					}
					return guard.currentSelection();
				},
			};
		};
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
			ownerWriteGuardFor: guardFor,
		});
		try {
			expect(() => ownerForFamily(mcp.owner, "cd", alias)).toThrow(
				/session changed/u,
			);
			expect(checks).toBe(2);
			expect(mcp.owner.vaultFor?.("cd", first).names()).toEqual([]);
		} finally {
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("does not let an old retargeted locator clear a newer session", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-old-alias-"));
		const first = join(home, "first");
		const second = join(home, "second");
		const alias = join(home, "alias");
		await Promise.all([mkdir(first), mkdir(second)]);
		await symlink(first, alias);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const old = mcp.owner.storeSettingsFor?.("cd", alias);
			if (!old?.onOwnerChoice) throw new Error("No owner choice.");
			old.onOwnerChoice();
			const fresh = mcp.owner.storeSettingsFor?.("cd", first);
			const vault = mcp.owner.vaultFor?.("cd", first);
			if (!fresh?.runStoreWrite || !vault)
				throw new Error("No scoped owner session.");
			vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
			await rm(alias);
			await symlink(second, alias);
			await expect(old.read()).rejects.toThrow(/session changed/u);
			expect(vault.reveal("INFISICAL_TOKEN")).toBe("synthetic-sign-in");
			expect(fresh.requiresOwnerChoice?.()).toBe(false);
			await expect(fresh.runStoreWrite(async () => "completed")).resolves.toBe(
				"completed",
			);
		} finally {
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("retains an in-flight marker when its project symlink is retargeted", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-retarget-write-"));
		const first = join(home, "first");
		const second = join(home, "second");
		const alias = join(home, "alias");
		await Promise.all([mkdir(first), mkdir(second)]);
		await symlink(first, alias);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		const other = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		let release: () => void = () => undefined;
		try {
			const settings = mcp.owner.storeSettingsFor?.("cd", alias);
			if (!settings?.runStoreWrite) throw new Error("No write transaction.");
			let started: () => void = () => undefined;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const writing = settings.runStoreWrite(async () => {
				started();
				await pending;
			});
			await entered;
			await rm(alias);
			await symlink(second, alias);
			release();
			await expect(writing).rejects.toThrow(/session changed/u);
			const firstAgain = other.owner.storeSettingsFor?.("cd", first);
			expect(() => firstAgain?.assertCurrent?.()).toThrow(/uncertain outcome/u);
		} finally {
			release();
			await mcp.close();
			await other.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("rejects writes inherited from a completed asynchronous context", async () => {
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: tmpdir(),
			remote: true,
		});
		try {
			const store = mcp.owner.storeSettingsFor?.("cd", tmpdir());
			if (!store?.runStoreWrite) throw new Error("No write transaction.");
			const run = store.runStoreWrite;
			const order: string[] = [];
			let trigger: () => void = () => undefined;
			let release: () => void = () => undefined;
			let started: () => void = () => undefined;
			let late: Promise<void> = Promise.resolve();
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			await run(async () => {
				late = new Promise<void>((resolve) => {
					trigger = resolve;
				}).then(() =>
					run(async () => {
						order.push("late");
					}),
				);
				order.push("first");
			});
			const second = run(async () => {
				order.push("second");
				started();
				await wait;
			});
			await entered;
			const refused = expect(late).rejects.toThrow(/write scope has closed/u);
			trigger();
			await refused;
			expect(order).toEqual(["first", "second"]);
			release();
			await second;
			expect(order).toEqual(["first", "second"]);
		} finally {
			await mcp.close();
		}
	});

	test("serializes simultaneous scoped writes while allowing nested transactions", async () => {
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: tmpdir(),
			remote: true,
		});
		try {
			const store = mcp.owner.storeSettingsFor?.("cd", tmpdir());
			if (!store?.runStoreWrite) throw new Error("No write transaction.");
			const order: string[] = [];
			let release: () => void = () => undefined;
			let started: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const first = store.runStoreWrite(async () => {
				order.push("first");
				await store.runStoreWrite?.(async () => {
					order.push("nested");
				});
				started();
				await gate;
				order.push("first-done");
			});
			await entered;
			const second = store.runStoreWrite(async () => {
				order.push("second");
			});
			await Promise.resolve();
			expect(order).toEqual(["first", "nested"]);
			release();
			await Promise.all([first, second]);
			expect(order).toEqual(["first", "nested", "first-done", "second"]);
		} finally {
			await mcp.close();
		}
	});

	test("keeps the queue behind its predecessor when a cross-handle waiter is canceled", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-queue-"));
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		let release: () => void = () => undefined;
		try {
			const first = mcp.owner.storeSettingsFor?.("cd", home);
			const second = mcp.owner.storeSettingsFor?.("cd", home);
			const third = mcp.owner.storeSettingsFor?.("cd", home);
			if (
				!first?.runStoreWrite ||
				!second?.runStoreWrite ||
				!second.selectionSignal ||
				!third?.runStoreWrite
			)
				throw new Error("No scoped write queue.");
			const order: string[] = [];
			let started: () => void = () => undefined;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const writer = first.runStoreWrite(async () => {
				order.push("first");
				await second.runStoreWrite?.(async () => {
					order.push("nested");
				});
				started();
				await held;
			});
			await entered;
			const canceled = second.runStoreWrite(async () => {
				order.push("canceled");
			});
			const canceledResult =
				expect(canceled).rejects.toThrow(/session changed/u);
			second.selectionSignal.dispatchEvent(new Event("abort"));
			await canceledResult;
			const later = third.runStoreWrite(async () => {
				order.push("later");
			});
			const laterResult = later.then(
				() => "completed",
				() => "refused",
			);
			await Promise.resolve();
			expect(order).toEqual(["first", "nested"]);
			release();
			await writer;
			expect(await laterResult).toBe("completed");
			expect(order).toEqual(["first", "nested", "later"]);
		} finally {
			release();
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("releases a guard when its synchronous dispatch validation refuses", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-validation-"));
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const settings = mcp.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite) throw new Error("No owner write guard.");
			let checks = 0;
			let dispatched = false;
			await expect(
				settings.runStoreWrite(
					async () => {
						dispatched = true;
					},
					() => {
						checks++;
						if (checks === 2) throw new Error("synthetic authority refusal");
						return true;
					},
				),
			).rejects.toThrow(/authority refusal/u);
			expect(checks).toBe(2);
			expect(dispatched).toBe(false);
			expect(() => settings.assertCurrent?.()).not.toThrow();
			await expect(
				settings.runStoreWrite(
					async () => "retried",
					() => true,
				),
			).resolves.toBe("retried");
			await settings.runStoreWrite(async () => {
				const nested = settings.runStoreWrite;
				if (!nested) throw new Error("No nested owner write guard.");
				await expect(
					nested(
						async () => {
							dispatched = true;
						},
						() => {
							throw new Error("synthetic nested authority refusal");
						},
					),
				).rejects.toThrow(/nested authority refusal/u);
			});
			expect(dispatched).toBe(false);
			await settings.runStoreWrite(async () => {
				const nested = settings.runStoreWrite;
				if (!nested) throw new Error("No nested owner write guard.");
				let allowed = true;
				let validations = 0;
				await expect(
					nested(
						async () => {
							dispatched = true;
						},
						() => {
							validations++;
							if (!allowed)
								throw new Error("synthetic other authority revoked");
							queueMicrotask(() => {
								allowed = false;
							});
							return true;
						},
					),
				).rejects.toThrow(/other authority revoked/u);
				expect(validations).toBe(2);
			});
			expect(dispatched).toBe(false);
		} finally {
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("retains independent uncertainty when dispatch validation refuses", async () => {
		const home = await mkdtemp(
			join(tmpdir(), "hobo-owner-validation-uncertain-"),
		);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const settings = mcp.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite) throw new Error("No owner write guard.");
			let checks = 0;
			let dispatched = false;
			await expect(
				settings.runStoreWrite(
					async () => {
						dispatched = true;
					},
					() => {
						checks++;
						if (checks === 2) {
							settings.markUncertainWrite?.();
							throw new Error("synthetic authority refusal");
						}
						return true;
					},
				),
			).rejects.toBeInstanceOf(OwnerStoreOperationUncertainError);
			expect(dispatched).toBe(false);
			expect(() => settings.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
		} finally {
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("releases a canceled waiter before a held predecessor finishes", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-canceled-wait-"));
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		let release: () => void = () => undefined;
		try {
			const first = mcp.owner.storeSettingsFor?.("cd", home);
			const second = mcp.owner.storeSettingsFor?.("cd", home);
			if (!first?.runStoreWrite || !second?.runStoreWrite)
				throw new Error("No scoped write queue.");
			let started: () => void = () => undefined;
			const entered = new Promise<void>((resolve) => {
				started = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const writer = first.runStoreWrite(async () => {
				started();
				await held;
			});
			const writerResult = expect(writer).rejects.toThrow(/session changed/u);
			await entered;
			let dispatched = false;
			const waiter = second.runStoreWrite(async () => {
				dispatched = true;
			});
			const waiterResult = expect(waiter).rejects.toThrow(/session changed/u);
			await mcp.close();
			await waiterResult;
			expect(dispatched).toBe(false);
			release();
			await writerResult;
			const restarted = composeHoboMcp({
				output: new PassThrough(),
				projectDir: home,
				remote: true,
			});
			try {
				const fresh = restarted.owner.storeSettingsFor?.("cd", home);
				expect(() => fresh?.assertCurrent?.()).toThrow(/uncertain outcome/u);
			} finally {
				await restarted.close();
			}
		} finally {
			release();
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("blocks the session when a store write may have applied before failing", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-uncertain-"));
		vi.stubEnv("XDG_CONFIG_HOME", home);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const settings = mcp.owner.storeSettingsFor?.("cd", home);
			const vault = mcp.owner.vaultFor?.("cd", home);
			if (!settings || !vault) throw new Error("No scoped owner session.");
			await settings.write({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-project",
			});
			vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
			const memory = createMemorySecretsPort({ id: "memory" });
			const selected = await ownerStore("cd", vault, {
				locator: settings,
				env: {},
				openStore: async (id) => ({
					ok: true,
					store: {
						id,
						reference: () => "private",
						port: {
							...memory,
							put: async (name, value) => {
								await memory.put(name, value);
								throw new Error("connection lost");
							},
						},
					},
				}),
			});
			if (!selected.opened) throw new Error("Store did not open.");
			await expect(
				selected.opened.port.put("SYNTHETIC_SETTING", "fixture"),
			).rejects.toThrow("connection lost");
			expect(await memory.access("SYNTHETIC_SETTING")).toMatchObject({
				status: "ok",
				material: "fixture",
			});
			expect(() => settings.onOwnerChoice?.()).toThrow(/uncertain outcome/u);
			const restarted = composeHoboMcp({
				output: new PassThrough(),
				projectDir: home,
				remote: true,
			});
			try {
				const afterRestart = restarted.owner.storeSettingsFor?.("cd", home);
				if (!afterRestart) throw new Error("No restarted owner session.");
				await expect(afterRestart.read()).rejects.toThrow(/uncertain outcome/u);
				expect(() => afterRestart.onOwnerChoice?.()).toThrow(
					/uncertain outcome/u,
				);
			} finally {
				await restarted.close();
			}
		} finally {
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("does not report success when a completed callback marked its write uncertain", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-marked-result-"));
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		const restarted = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const store = mcp.owner.storeSettingsFor?.("cd", home);
			if (!store?.runStoreWrite || !store.markUncertainWrite)
				throw new Error("No write transaction.");
			const result = store.runStoreWrite(async () => {
				store.markUncertainWrite?.();
				return "synthetic-success";
			});
			await expect(result).rejects.toBeInstanceOf(
				OwnerStoreOperationUncertainError,
			);
			await expect(result).rejects.toThrow(/uncertain outcome/u);
			const afterRestart = restarted.owner.storeSettingsFor?.("cd", home);
			expect(() => afterRestart?.assertCurrent?.()).toThrow(
				/uncertain outcome/u,
			);
		} finally {
			await mcp.close();
			await restarted.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("keeps an uncertain provider mutation from switching the owner store", async () => {
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: tmpdir(),
			remote: true,
		});
		try {
			const store = mcp.owner.storeSettingsFor?.("cd", tmpdir());
			if (!store) throw new Error("No scoped owner settings.");
			store.markUncertainWrite?.();
			expect(() => store.onOwnerChoice?.()).toThrow(/uncertain outcome/u);
			await expect(store.read()).rejects.toThrow(/uncertain outcome/u);
		} finally {
			await mcp.close();
		}
	});

	it("accepts only a choice offered through the private owner form", async () => {
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: tmpdir(),
			remote: true,
		});
		try {
			mcp.session.support = {
				apps: false,
				formElicitation: true,
				urlElicitation: false,
			};
			mcp.session.request = vi.fn(async () => ({
				action: "accept",
				content: { choice: "private-choice" },
			}));
			const choice = await mcp.owner.choose?.({
				message: "Choose one.",
				choices: [{ value: "private-choice", label: "Synthetic organization" }],
			});
			expect(choice).toBe("private-choice");
			const invalid = await mcp.owner.choose?.({
				message: "Choose one.",
				choices: [{ value: "other-choice", label: "Other" }],
			});
			expect(invalid).toBeUndefined();
		} finally {
			await mcp.close();
		}
	});

	it("collects a multi-field owner handoff privately and starts a fresh request after a decline", async () => {
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: tmpdir(),
			remote: true,
		});
		const fields = [
			{
				name: "HOBO_CI_GITHUB_OWNER",
				title: "GitHub owner",
				instructions: "Owner",
			},
			{ name: "HOBO_CI_PUBLIC_URL", title: "Relay URL", instructions: "Relay" },
		];
		try {
			mcp.session.support = {
				apps: true,
				formElicitation: true,
				urlElicitation: false,
			};
			const answers = [
				{ action: "accept", content: { value: "synthetic-owner" } },
				{ action: "decline" },
				{ action: "accept", content: { value: "synthetic-owner" } },
				{ action: "accept", content: { value: "https://synthetic.example" } },
			];
			mcp.session.request = vi.fn(async () => answers.shift());
			const first = mcp.owner.forScope?.("ci", tmpdir());
			if (!first) throw new Error("No scoped owner channel.");
			expect(await captureAll(first, fields)).toBeUndefined();
			expect(mcp.session.request).toHaveBeenCalledTimes(2);
			const retry = mcp.owner.forScope?.("ci", tmpdir());
			if (!retry) throw new Error("No scoped owner channel.");
			expect(await captureAll(retry, fields)).toEqual([
				"synthetic-owner",
				"https://synthetic.example",
			]);
			expect(mcp.session.request).toHaveBeenCalledTimes(4);
		} finally {
			await mcp.close();
		}
	});

	test("keeps project and CI/CD selections and sign-ins separate and private", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-session-"));
		const first = join(home, "first");
		const second = join(home, "second");
		await Promise.all([mkdir(first), mkdir(second)]);
		vi.stubEnv("XDG_CONFIG_HOME", home);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const initialSettings = mcp.owner.storeSettingsFor?.("cd", first);
			const initialVault = mcp.owner.vaultFor?.("cd", first);
			if (!initialSettings || !initialVault)
				throw new Error("No scoped owner session.");
			await initialSettings.write({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "previous-project",
				INFISICAL_IDENTITY_ID: "previous-identity",
				OTHER_SETTING: "preserved",
			});
			initialVault.put("INFISICAL_TOKEN", "previous-sign-in");
			expect(initialSettings.hasSessionChoice?.()).toBe(false);
			expect(
				(
					await ownerStoreSessionEnvironment(
						{ locator: initialSettings },
						{ HOBO_SECRET_STORE: "bitwarden" },
					)
				).HOBO_SECRET_STORE,
			).toBe("bitwarden");
			const oldScope = mcp.owner.forScope?.("cd", first);
			if (!oldScope) throw new Error("No scoped owner channel.");
			oldScope.reserveCaptures?.([INFISICAL_CLI_SESSION]);
			mcp.owner.deposit(INFISICAL_CLI_SESSION, "A".repeat(24));
			const oldHandoff = mcp.owner.handoffFor(INFISICAL_CLI_SESSION);
			if (!oldHandoff) throw new Error("No pending handoff.");
			const choose = async (family: "ci" | "cd", cwd: string, id: string) => {
				let form = 0;
				return mcp.session.storeChoice?.callTool(
					"choose_secret_store",
					{ family, cwd },
					{ formElicitation: true, apps: false },
					async () => ({
						action: "accept",
						content:
							form++ === 0
								? { store: "infisical" }
								: { INFISICAL_PROJECT_ID: id },
					}),
				);
			};
			const results = [
				await choose("cd", first, "private-cd-first"),
				await choose("cd", second, "private-cd-second"),
				await choose("ci", first, "private-ci-first"),
			];
			expect(JSON.stringify(results)).not.toContain("private-");
			const settings = mcp.owner.storeSettingsFor;
			const vaultFor = mcp.owner.vaultFor;
			if (!settings || !vaultFor) throw new Error("No scoped owner session.");
			expect(await settings("cd", first).read()).toMatchObject({
				INFISICAL_PROJECT_ID: "private-cd-first",
				OTHER_SETTING: "preserved",
			});
			expect(
				(await settings("cd", first).read()).INFISICAL_IDENTITY_ID,
			).toBeUndefined();
			expect(initialVault.names()).toEqual([]);
			expect(oldHandoff.held()).toBe(false);
			expect(() => oldScope.reserveCaptures?.([INFISICAL_CLI_SESSION])).toThrow(
				/session changed/u,
			);
			const spec = OWNER_HANDOFF_SPECS.find(
				(item) => item.name === INFISICAL_CLI_SESSION,
			);
			if (!spec) throw new Error("No handoff spec.");
			await expect(
				oldHandoff.receive(CapturedSecret.parse(spec, "B".repeat(24))),
			).rejects.toThrow(/no longer waiting/u);
			expect(() => initialVault.put("INFISICAL_TOKEN", "too-late")).toThrow(
				/ended/u,
			);
			expect(await settings("cd", second).read()).toMatchObject({
				INFISICAL_PROJECT_ID: "private-cd-second",
			});
			expect(await settings("ci", first).read()).toMatchObject({
				INFISICAL_PROJECT_ID: "private-ci-first",
			});
			const cdFirst = vaultFor("cd", first);
			const cdSecond = vaultFor("cd", second);
			const ciFirst = vaultFor("ci", first);
			cdFirst.put("INFISICAL_TOKEN", "first-cd-sign-in");
			cdSecond.put("INFISICAL_TOKEN", "second-cd-sign-in");
			ciFirst.put("INFISICAL_TOKEN", "first-ci-sign-in");
			expect(cdFirst.reveal("INFISICAL_TOKEN")).toBe("first-cd-sign-in");
			expect(cdSecond.reveal("INFISICAL_TOKEN")).toBe("second-cd-sign-in");
			expect(ciFirst.reveal("INFISICAL_TOKEN")).toBe("first-ci-sign-in");
			expect(existsSync(secretStoreLocatorPath(first))).toBe(false);
			expect(existsSync(secretStoreLocatorPath(second))).toBe(false);
			await mcp.close();
			expect(await settings("cd", first).read()).toEqual({});
			expect(await settings("cd", second).read()).toEqual({});
			expect(cdFirst.names()).toEqual([]);
			expect(cdSecond.names()).toEqual([]);
			expect(ciFirst.names()).toEqual([]);
			expect(() => cdFirst.put("INFISICAL_TOKEN", "too-late")).toThrow(
				/ended/u,
			);
			expect(() => vaultFor("cd", first)).toThrow(/closed/u);
		} finally {
			await mcp.close();
			await rm(home, { force: true, recursive: true });
		}
	});

	test("rejects an in-flight store opening if the owner changes the selection", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-generation-"));
		vi.stubEnv("XDG_CONFIG_HOME", home);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const choose = async (id: string) => {
				let step = 0;
				await mcp.session.storeChoice?.callTool(
					"choose_secret_store",
					{ family: "cd", cwd: home },
					{ formElicitation: true, apps: false },
					async () => ({
						action: "accept",
						content:
							step++ === 0
								? { store: "infisical" }
								: { INFISICAL_PROJECT_ID: id },
					}),
				);
			};
			await choose("old-project");
			const settings = mcp.owner.storeSettingsFor?.("cd", home);
			const session = mcp.owner.vaultFor?.("cd", home);
			if (!settings || !session) throw new Error("No scoped owner session.");
			session.put("INFISICAL_TOKEN", "old-sign-in");
			const credentials = createTrustedVault();
			const port = createMemorySecretsPort({ id: "memory" });
			await port.put("HOBO_CD_VERCEL_TOKEN", "synthetic-deploy-token");
			let release: (() => void) | undefined;
			let started: (() => void) | undefined;
			const opening = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const loading = loadOwnerDeployCredentials({
				cwd: home,
				env: {},
				credentials,
				ownerSession: session,
				ownerSettings: settings,
				openStore: async (id) => {
					started?.();
					await gate;
					return {
						ok: true,
						store: { id, port, reference: () => "private" },
					};
				},
			});
			await opening;
			await choose("new-project");
			release?.();
			expect(await loading).toBe(false);
			expect(credentials.has("VERCEL_TOKEN")).toBe(false);
		} finally {
			await mcp.close();
			await rm(home, { force: true, recursive: true });
		}
	});

	test("rejects an older store picker after a newer picker is submitted", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-picker-"));
		vi.stubEnv("XDG_CONFIG_HOME", home);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const app = mcp.session.storeChoice;
			if (!app) throw new Error("No store picker.");
			const support = { apps: true, formElicitation: false };
			const args = { family: "cd", cwd: home };
			const older = await app.callTool(
				"choose_secret_store",
				args,
				support,
				undefined,
			);
			const newer = await app.callTool(
				"choose_secret_store",
				args,
				support,
				undefined,
			);
			const oldTicket = z.string().parse(older._meta?.hoboChoiceTicket);
			const newTicket = z.string().parse(newer._meta?.hoboChoiceTicket);
			const selected = await app.callTool(
				"submit_store_choice",
				{
					...args,
					choiceTicket: newTicket,
					store: "infisical",
					INFISICAL_PROJECT_ID: "new-project",
				},
				support,
				undefined,
			);
			expect(selected.isError).not.toBe(true);
			const stale = await app.callTool(
				"submit_store_choice",
				{
					...args,
					choiceTicket: oldTicket,
					store: "infisical",
					INFISICAL_PROJECT_ID: "old-project",
				},
				support,
				undefined,
			);
			expect(stale.isError).toBe(true);
			expect(
				(await mcp.owner.storeSettingsFor?.("cd", home).read())
					?.INFISICAL_PROJECT_ID,
			).toBe("new-project");
		} finally {
			await mcp.close();
			await rm(home, { force: true, recursive: true });
		}
	});

	test("rejects a delayed elicitation after a newer owner choice", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-elicitation-"));
		vi.stubEnv("XDG_CONFIG_HOME", home);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const app = mcp.session.storeChoice;
			if (!app) throw new Error("No store picker.");
			const support = { apps: false, formElicitation: true };
			const args = { family: "cd", cwd: home };
			let release: (() => void) | undefined;
			let started: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const pending = new Promise<void>((resolve) => {
				started = resolve;
			});
			let oldStep = 0;
			const old = app.callTool(
				"choose_secret_store",
				args,
				support,
				async () => {
					if (oldStep++ === 0) {
						started?.();
						await gate;
						return { action: "accept", content: { store: "infisical" } };
					}
					return {
						action: "accept",
						content: { INFISICAL_PROJECT_ID: "old-project" },
					};
				},
			);
			await pending;
			let newStep = 0;
			const newer = await app.callTool(
				"choose_secret_store",
				args,
				support,
				async () => ({
					action: "accept",
					content:
						newStep++ === 0
							? { store: "infisical" }
							: { INFISICAL_PROJECT_ID: "new-project" },
				}),
			);
			expect(newer.isError).not.toBe(true);
			release?.();
			expect((await old).isError).toBe(true);
			expect(
				(await mcp.owner.storeSettingsFor?.("cd", home).read())
					?.INFISICAL_PROJECT_ID,
			).toBe("new-project");
		} finally {
			await mcp.close();
			await rm(home, { force: true, recursive: true });
		}
	});

	test("waits for an in-flight store write before changing the selection", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-write-"));
		vi.stubEnv("XDG_CONFIG_HOME", home);
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const app = mcp.session.storeChoice;
			if (!app) throw new Error("No store picker.");
			const choose = async (id: string) => {
				let step = 0;
				return app.callTool(
					"choose_secret_store",
					{ family: "cd", cwd: home },
					{ apps: false, formElicitation: true },
					async () => ({
						action: "accept",
						content:
							step++ === 0
								? { store: "infisical" }
								: { INFISICAL_PROJECT_ID: id },
					}),
				);
			};
			await choose("old-project");
			const settings = mcp.owner.storeSettingsFor?.("cd", home);
			const vault = mcp.owner.vaultFor?.("cd", home);
			if (!settings || !vault) throw new Error("No scoped owner session.");
			vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
			const memory = createMemorySecretsPort({ id: "memory" });
			let release: (() => void) | undefined;
			let started: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const writing = new Promise<void>((resolve) => {
				started = resolve;
			});
			const selected = await ownerStore("cd", vault, {
				locator: settings,
				openStore: async (id) => ({
					ok: true,
					store: {
						id,
						reference: () => "private",
						port: {
							...memory,
							put: async (name, value) => {
								started?.();
								await gate;
								return memory.put(name, value);
							},
						},
					},
				}),
			});
			if (!selected.opened) throw new Error("Store did not open.");
			const store = selected.opened;
			let continueGroup: (() => void) | undefined;
			let firstDone: (() => void) | undefined;
			const betweenWrites = new Promise<void>((resolve) => {
				continueGroup = resolve;
			});
			const firstWritten = new Promise<void>((resolve) => {
				firstDone = resolve;
			});
			const put = withStoreWriteLock(store, async () => {
				await store.port.put("TEST_CONNECTION", "synthetic-value");
				firstDone?.();
				await betweenWrites;
				await store.port.put("TEST_CONNECTION_SCOPE", "synthetic-team");
			});
			await writing;
			const busy = await choose("new-project");
			expect(busy.structuredContent).toMatchObject({ status: "busy" });
			expect((await settings.read()).INFISICAL_PROJECT_ID).toBe("old-project");
			release?.();
			await firstWritten;
			expect((await choose("new-project")).structuredContent).toMatchObject({
				status: "busy",
			});
			continueGroup?.();
			await put;
			expect((await choose("new-project")).isError).not.toBe(true);
			expect(
				(await mcp.owner.storeSettingsFor?.("cd", home).read())
					?.INFISICAL_PROJECT_ID,
			).toBe("new-project");
		} finally {
			await mcp.close();
			await rm(home, { force: true, recursive: true });
		}
	});
});
