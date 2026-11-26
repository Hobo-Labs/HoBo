import { describe, expect, it } from "vitest";

import {
	ConvexDeployError,
	type ConvexSpawn,
	deployConvexApp,
} from "../src/deploy.js";

type ConvexSpawnCall = Parameters<ConvexSpawn>[0];

import { ConvexCredentialsError } from "../src/management-api.js";
import {
	describeWorkOsAuthKit,
	requireWorkOsAuthKit,
	WorkOsCredentialsError,
} from "../src/workos.js";

describe("deployConvexApp", () => {
	it("fails closed without deploy key or self-host pair", async () => {
		await expect(deployConvexApp({ root: "/tmp/app" })).rejects.toBeInstanceOf(
			ConvexCredentialsError,
		);
	});

	it("mock lane returns deterministic URL without spawn", async () => {
		const result = await deployConvexApp({
			root: "/tmp/app",
			mock: true,
			deploymentName: "demo",
		});
		expect(result).toEqual({
			ok: true,
			deploymentUrl: "https://demo.convex.cloud",
			deploymentName: "demo",
			mocked: true,
			mode: "mock",
		});
	});

	it("invokes injected spawn with CONVEX_DEPLOY_KEY (not echoed in result)", async () => {
		const calls: ConvexSpawnCall[] = [];
		const result = await deployConvexApp({
			root: "/tmp/swag",
			deployKey: "secret-key",
			deploymentName: "ship",
			spawn: async (input) => {
				calls.push(input);
				return {
					exitCode: 0,
					stdout: "Deployed to https://ship.convex.cloud\n",
					stderr: "",
				};
			},
		});
		expect(result.deploymentUrl).toBe("https://ship.convex.cloud");
		expect(result.mocked).toBe(false);
		expect(result.mode).toBe("cloud");
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call).toBeDefined();
		expect(call?.env.CONVEX_DEPLOY_KEY).toBe("secret-key");
		expect(call.args).toContain("convex");
		expect(call.cwd).toContain("swag");
		expect(JSON.stringify(result)).not.toContain("secret-key");
	});

	it("self-host path passes CONVEX_SELF_HOSTED_* and uses local URL", async () => {
		const calls: ConvexSpawnCall[] = [];
		const result = await deployConvexApp({
			root: "/tmp/swag",
			selfHostedUrl: "http://127.0.0.1:3210",
			selfHostedAdminKey: "name|admin-secret",
			deploymentName: "local",
			spawn: async (input) => {
				calls.push(input);
				return {
					exitCode: 0,
					stdout: "Deployed to http://127.0.0.1:3210\n",
					stderr: "",
				};
			},
		});
		expect(result.deploymentUrl).toBe("http://127.0.0.1:3210");
		expect(result.mode).toBe("self-hosted");
		expect(result.mocked).toBe(false);
		const call = calls[0];
		expect(call).toBeDefined();
		expect(call?.env.CONVEX_SELF_HOSTED_URL).toBe("http://127.0.0.1:3210");
		expect(call.env.CONVEX_SELF_HOSTED_ADMIN_KEY).toBe("name|admin-secret");
		expect(call.env.CONVEX_DEPLOY_KEY).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("admin-secret");
	});

	it("surfaces non-zero spawn as ConvexDeployError", async () => {
		await expect(
			deployConvexApp({
				root: "/tmp/app",
				deployKey: "k",
				spawn: async () => ({
					exitCode: 1,
					stdout: "",
					stderr: "auth failed",
				}),
			}),
		).rejects.toBeInstanceOf(ConvexDeployError);
	});
});

describe("WorkOS AuthKit preflight", () => {
	it("reports missing keys without echoing values", () => {
		const preflight = describeWorkOsAuthKit({
			VITE_WORKOS_CLIENT_ID: "present",
		});
		expect(preflight.ready).toBe(false);
		expect(preflight.missing).toEqual([
			"VITE_WORKOS_REDIRECT_URI",
			"WORKOS_CLIENT_ID",
		]);
		expect(preflight.remediation).toMatch(/Camp secretRef/);
	});

	it("requireWorkOsAuthKit throws WorkOsCredentialsError", () => {
		expect(() => requireWorkOsAuthKit({})).toThrow(WorkOsCredentialsError);
	});

	it("passes when all required env present", () => {
		expect(() =>
			requireWorkOsAuthKit({
				VITE_WORKOS_CLIENT_ID: "c",
				VITE_WORKOS_REDIRECT_URI: "http://localhost:5173",
				WORKOS_CLIENT_ID: "c",
			}),
		).not.toThrow();
	});
});
