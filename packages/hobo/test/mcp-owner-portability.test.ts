import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileSettingsStore } from "@hobo/connect-ui";
import { secretStoreLocatorPath } from "@hobo/hobo-ci";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeHoboMcp } from "../src/mcp-serve.js";
import {
	OwnerWriteGuardUnavailableError,
	ownerWriteGuard,
} from "../src/owner-write-guard.js";
import { supportsOwnerGuard } from "./support/owner-guard-support.js";

const environment = { durable: false };
const unavailable = () => {
	throw new OwnerWriteGuardUnavailableError();
};
const guardFor: typeof ownerWriteGuard = (scope, cwd) => {
	const actual = ownerWriteGuard(scope, cwd);
	return {
		currentSelection: () =>
			environment.durable ? actual.currentSelection() : unavailable(),
		changeGeneration: (expected) =>
			environment.durable ? actual.changeGeneration(expected) : unavailable(),
		currentSettingsRevision: () =>
			environment.durable ? actual.currentSettingsRevision() : unavailable(),
		currentPreparationSnapshot: (expected) =>
			environment.durable
				? actual.currentPreparationSnapshot(expected)
				: unavailable(),
		advanceSettingsRevision: (expected, nonce) =>
			environment.durable
				? actual.advanceSettingsRevision(expected, nonce)
				: unavailable(),
		assertClear: () =>
			environment.durable ? actual.assertClear() : unavailable(),
		markUncertain: () =>
			environment.durable ? actual.markUncertain() : unavailable(),
		run: async <T>(
			write: (nonce: string) => Promise<T>,
			uncertain: () => boolean,
			expected?: string,
			preflight?: () => true,
			uncertainBeforeDispatch?: () => boolean,
			snapshot?: Parameters<ReturnType<typeof ownerWriteGuard>["run"]>[5],
		): Promise<T> =>
			environment.durable
				? actual.run(
						write,
						uncertain,
						expected,
						preflight,
						uncertainBeforeDispatch,
						snapshot,
					)
				: unavailable(),
	};
};

afterEach(() => {
	environment.durable = false;
	vi.unstubAllEnvs();
});

describe("MCP owner session without durable write primitives", () => {
	it("keeps existing-session reads available while refusing protected changes", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-owner-readonly-"));
		vi.stubEnv("XDG_CONFIG_HOME", home);
		vi.stubEnv("XDG_STATE_HOME", home);
		await fileSettingsStore(secretStoreLocatorPath(home)).write({
			HOBO_SECRET_STORE: "bitwarden",
		});
		const mcp = composeHoboMcp({
			output: new PassThrough(),
			projectDir: home,
			remote: true,
			ownerWriteGuardFor: guardFor,
		});
		try {
			const settings = mcp.owner.storeSettingsFor?.("cd", home);
			const vault = mcp.owner.vaultFor?.("cd", home);
			if (!settings?.runStoreWrite || !vault)
				throw new Error("No scoped owner session.");
			vault.put("SYNTHETIC_TOKEN", "fixture");
			expect(await settings.read()).toEqual({ HOBO_SECRET_STORE: "bitwarden" });
			await expect(
				settings.write({ HOBO_SECRET_STORE: "infisical" }),
			).rejects.toThrow(/guard is unavailable/u);
			expect(vault.has("SYNTHETIC_TOKEN")).toBe(true);
			let dispatched = false;
			await expect(
				settings.runStoreWrite(async () => {
					dispatched = true;
				}),
			).rejects.toThrow(/guard is unavailable/u);
			expect(dispatched).toBe(false);
			expect(() => settings.onOwnerChoice?.()).toThrow(/guard is unavailable/u);
			const app = mcp.session.storeChoice;
			if (!app) throw new Error("No owner store picker.");
			let step = 0;
			const choice = await app.callTool(
				"choose_secret_store",
				{ family: "cd", cwd: home },
				{ apps: false, formElicitation: true },
				async () => ({
					action: "accept",
					content: step++ === 0 ? { store: "bitwarden" } : {},
				}),
			);
			expect(choice).toMatchObject({
				isError: true,
				structuredContent: { status: "write-guard-unavailable" },
			});
			expect(choice.content).toContainEqual({
				type: "text",
				text: "Store changes are unavailable on this HoBo host. Existing connections can still be used read-only. Check the host's storage and permissions, or use a supported host.",
			});
			expect(vault.has("SYNTHETIC_TOKEN")).toBe(true);
			expect(await settings.read()).toEqual({ HOBO_SECRET_STORE: "bitwarden" });
		} finally {
			await mcp.close();
			await rm(home, { recursive: true, force: true });
		}
	});

	it.runIf(supportsOwnerGuard())(
		"does not let an unsupported server switch another server's selection",
		async () => {
			const home = await mkdtemp(join(tmpdir(), "hobo-owner-mixed-"));
			vi.stubEnv("XDG_CONFIG_HOME", home);
			vi.stubEnv("XDG_STATE_HOME", home);
			await fileSettingsStore(secretStoreLocatorPath(home)).write({
				HOBO_SECRET_STORE: "bitwarden",
			});
			const first = composeHoboMcp({
				output: new PassThrough(),
				projectDir: home,
				remote: true,
				ownerWriteGuardFor: guardFor,
			});
			const second = composeHoboMcp({
				output: new PassThrough(),
				projectDir: home,
				remote: true,
				ownerWriteGuardFor: guardFor,
			});
			try {
				environment.durable = true;
				const supported = first.owner.storeSettingsFor?.("cd", home);
				if (!supported?.runStoreWrite)
					throw new Error("No durable owner session.");
				await supported.write({ HOBO_SECRET_STORE: "bitwarden" });
				environment.durable = false;
				const unsupported = second.owner.storeSettingsFor?.("cd", home);
				if (!unsupported) throw new Error("No read-only owner session.");
				expect(() => unsupported.onOwnerChoice?.()).toThrow(
					/guard is unavailable/u,
				);
				environment.durable = true;
				await expect(
					supported.runStoreWrite(async () => "existing-selection"),
				).resolves.toBe("existing-selection");
				expect(await supported.read()).toEqual({
					HOBO_SECRET_STORE: "bitwarden",
				});
			} finally {
				await first.close();
				await second.close();
				await rm(home, { recursive: true, force: true });
			}
		},
	);

	it.runIf(supportsOwnerGuard())(
		"invalidates an unfenced session before writes resume",
		async () => {
			const home = await mkdtemp(join(tmpdir(), "hobo-owner-resumed-"));
			vi.stubEnv("XDG_CONFIG_HOME", home);
			vi.stubEnv("XDG_STATE_HOME", home);
			await fileSettingsStore(secretStoreLocatorPath(home)).write({
				HOBO_SECRET_STORE: "bitwarden",
			});
			const mcp = composeHoboMcp({
				output: new PassThrough(),
				projectDir: home,
				remote: true,
				ownerWriteGuardFor: guardFor,
			});
			try {
				const old = mcp.owner.storeSettingsFor?.("cd", home);
				const vault = mcp.owner.vaultFor?.("cd", home);
				if (!old || !vault) throw new Error("No scoped owner session.");
				expect(await old.read()).toEqual({ HOBO_SECRET_STORE: "bitwarden" });
				vault.put("SYNTHETIC_TOKEN", "fixture");
				environment.durable = true;
				await expect(old.read()).rejects.toThrow(/owner session changed/u);
				expect(vault.has("SYNTHETIC_TOKEN")).toBe(false);
				const fresh = mcp.owner.storeSettingsFor?.("cd", home);
				if (!fresh?.runStoreWrite) throw new Error("No durable write guard.");
				await expect(fresh.runStoreWrite(async () => "done")).rejects.toThrow(
					/owner form/u,
				);
				fresh.onOwnerChoice?.();
				const reselected = mcp.owner.storeSettingsFor?.("cd", home);
				if (!reselected?.runStoreWrite)
					throw new Error("No selected owner session.");
				await expect(
					reselected.runStoreWrite(async () => "done"),
				).resolves.toBe("done");
			} finally {
				await mcp.close();
				await rm(home, { recursive: true, force: true });
			}
		},
	);
});
