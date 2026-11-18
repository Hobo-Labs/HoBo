import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createTrustedVault } from "@hobo/core";
import {
	ownerStore,
	ownerStoreSessionEnvironment,
	secretStoreLocatorPath,
	withStoreWriteLock,
} from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { CapturedSecret } from "@hobo/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	INFISICAL_CLI_SESSION,
	OWNER_HANDOFF_SPECS,
} from "../src/mcp-owner-channel.js";
import { composeHoboMcp } from "../src/mcp-serve.js";
import { loadOwnerDeployCredentials } from "../src/owner-deploy-credentials.js";

afterEach(() => vi.unstubAllEnvs());

describe("MCP owner store session", () => {
	it("keeps project and CI/CD selections and sign-ins separate and private", async () => {
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

	it("rejects an in-flight store opening if the owner changes the selection", async () => {
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
					return { ok: true, store: { id, port, reference: () => "private" } };
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

	it("rejects an older store picker after a newer picker is submitted", async () => {
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

	it("rejects a delayed elicitation after a newer owner choice", async () => {
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

	it("waits for an in-flight store write before changing the selection", async () => {
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
