import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { prepareJournalFleet } from "@hobo/hobo-cd";
import {
	ClaimStoreUnavailableError,
	OwnerStoreOperationUncertainError,
	ownerStore,
} from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { neonJournalProvisioner } from "../src/cd-journal-provisioners.js";
import { composeHoboMcp } from "../src/mcp-serve.js";
import { supportsOwnerGuard } from "./support/owner-guard-support.js";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hobo-journal-preflight-"));
	vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
	vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

describe.runIf(supportsOwnerGuard())("journal provisioning guard", () => {
	it("does not let an old prepared owner session dispatch after another completes", async () => {
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
			const older = first.owner.storeSettingsFor?.("cd", home);
			const newer = second.owner.storeSettingsFor?.("cd", home);
			if (!older?.runPreparedStoreWrite || !newer?.runPreparedStoreWrite)
				throw new Error("No prepared owner write.");
			let entered: () => void = () => undefined;
			const reading = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let dispatched = false;
			const attempt = older.runPreparedStoreWrite(
				async () => {
					entered();
					await held;
					return { kind: "write", value: "older" } as const;
				},
				async () => {
					dispatched = true;
					return "older";
				},
			);
			const refused = expect(attempt).rejects.toThrow(/session changed/u);
			await reading;
			await expect(
				newer.runPreparedStoreWrite(
					async () => ({ kind: "write", value: "newer" }) as const,
					async (value) => value,
				),
			).resolves.toBe("newer");
			release();
			await refused;
			expect(dispatched).toBe(false);
			expect(() => newer.assertCurrent?.()).not.toThrow();
		} finally {
			release();
			await first.close();
			await second.close();
		}
	});

	it("clears a proven no-dispatch claim refusal and allows a later attempt", async () => {
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const locator = mcp.owner.storeSettingsFor?.("cd", home);
			const vault = mcp.owner.vaultFor?.("cd", home);
			if (!locator?.runStoreWrite || !vault)
				throw new Error("No owner session.");
			await locator.write({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-project",
			});
			vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
			const memory = createMemorySecretsPort({ id: "memory" });
			const selected = await ownerStore("cd", vault, {
				locator,
				env: {},
				openStore: async (id) => ({
					ok: true,
					store: {
						id,
						reference: () => "private",
						port: { ...memory, createOnly: undefined },
					},
				}),
			});
			if (!selected.opened) throw new Error("No owner store.");
			const fetch = vi.fn<typeof globalThis.fetch>();
			const provisioners = [neonJournalProvisioner(fetch)];
			for (let attempt = 0; attempt < 2; attempt++) {
				await expect(
					prepareJournalFleet({ store: selected.opened, provisioners }),
				).rejects.toBeInstanceOf(ClaimStoreUnavailableError);
				expect(() => locator.assertCurrent?.()).not.toThrow();
			}
			expect(fetch).not.toHaveBeenCalled();
			await expect(locator.runStoreWrite(async () => "ready")).resolves.toBe(
				"ready",
			);
		} finally {
			await mcp.close();
		}
	});

	it("retains uncertainty if the same refusal follows a started provider effect", async () => {
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
		});
		try {
			const locator = mcp.owner.storeSettingsFor?.("cd", home);
			const vault = mcp.owner.vaultFor?.("cd", home);
			if (!locator || !vault) throw new Error("No owner session.");
			await locator.write({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-project",
			});
			vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
			const memory = createMemorySecretsPort({ id: "memory" });
			const selected = await ownerStore("cd", vault, {
				locator,
				env: {},
				openStore: async (id) => ({
					ok: true,
					store: { id, reference: () => "private", port: memory },
				}),
			});
			if (!selected.opened) throw new Error("No owner store.");
			let started = 0;
			await expect(
				prepareJournalFleet({
					store: selected.opened,
					provisioners: [
						{
							plan: "neon-claimable",
							create: async () => {
								started++;
								throw new ClaimStoreUnavailableError();
							},
						},
					],
				}),
			).rejects.toBeInstanceOf(OwnerStoreOperationUncertainError);
			expect(started).toBe(1);
			expect(() => locator.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
		} finally {
			await mcp.close();
		}
	});

	for (const independentlyUncertain of [false, true]) {
		it(`handles closure during a read-only preparation with independent uncertainty ${independentlyUncertain}`, async () => {
			const mcp = composeHoboMcp({
				output: new PassThrough(),
				projectDir: home,
				remote: true,
			});
			let release: () => void = () => undefined;
			try {
				const locator = mcp.owner.storeSettingsFor?.("cd", home);
				const vault = mcp.owner.vaultFor?.("cd", home);
				if (!locator?.runStoreWrite || !vault)
					throw new Error("No owner session.");
				await locator.write({
					HOBO_SECRET_STORE: "infisical",
					INFISICAL_PROJECT_ID: "synthetic-project",
				});
				vault.put("INFISICAL_TOKEN", "synthetic-sign-in");
				const memory = createMemorySecretsPort({ id: "memory" });
				let reads = 0;
				let entered: () => void = () => undefined;
				const reading = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				const selected = await ownerStore("cd", vault, {
					locator,
					env: {},
					openStore: async (id) => ({
						ok: true,
						store: {
							id,
							reference: () => "private",
							port: {
								...memory,
								createOnly: undefined,
								access: async (name) => {
									if (name === "HOBO_CD_SETTINGS" && ++reads === 2) {
										entered();
										await held;
									}
									return memory.access(name);
								},
							},
						},
					}),
				});
				if (!selected.opened) throw new Error("No owner store.");
				const fetch = vi.fn<typeof globalThis.fetch>();
				const provisioners = [neonJournalProvisioner(fetch)];
				const attempt = prepareJournalFleet({
					store: selected.opened,
					provisioners,
				});
				const result = independentlyUncertain
					? expect(attempt).rejects.toBeInstanceOf(
							OwnerStoreOperationUncertainError,
						)
					: expect(attempt).rejects.toThrow(/session changed/u);
				await reading;
				if (independentlyUncertain) locator.markUncertainWrite?.();
				await mcp.close();
				await result;
				expect(fetch).not.toHaveBeenCalled();
				const restarted = composeHoboMcp({
					output: new PassThrough(),
					projectDir: home,
					remote: true,
				});
				try {
					const fresh = restarted.owner.storeSettingsFor?.("cd", home);
					if (!fresh?.runStoreWrite) throw new Error("No owner session.");
					if (independentlyUncertain) {
						expect(() => fresh.assertCurrent?.()).toThrow(
							OwnerStoreOperationUncertainError,
						);
					} else {
						await expect(
							fresh.runStoreWrite(async () => "ready"),
						).resolves.toBe("ready");
						await fresh.write({
							HOBO_SECRET_STORE: "infisical",
							INFISICAL_PROJECT_ID: "synthetic-project",
						});
						const freshVault = restarted.owner.vaultFor?.("cd", home);
						if (!freshVault) throw new Error("No owner vault.");
						freshVault.put("INFISICAL_TOKEN", "synthetic-sign-in");
						const retry = await ownerStore("cd", freshVault, {
							locator: fresh,
							env: {},
							openStore: async (id) => ({
								ok: true,
								store: {
									id,
									reference: () => "private",
									port: { ...memory, createOnly: undefined },
								},
							}),
						});
						if (!retry.opened) throw new Error("No owner store.");
						await expect(
							prepareJournalFleet({ store: retry.opened, provisioners }),
						).rejects.toBeInstanceOf(ClaimStoreUnavailableError);
						expect(fetch).not.toHaveBeenCalled();
					}
				} finally {
					await restarted.close();
				}
				release();
			} finally {
				release();
				await mcp.close();
			}
		});
	}
});
