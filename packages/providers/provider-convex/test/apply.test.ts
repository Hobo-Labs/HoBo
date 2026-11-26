import { describe, expect, it } from "vitest";

import { applyDriverProgram } from "../src/apply.js";
import { CONVEX_PROVIDER_ID } from "../src/manifest.js";
import { createConvexProvider } from "../src/provider.js";
import { CONVEX_SDK_RESOURCES } from "../src/resources.js";

describe("applyDriverProgram", () => {
	it("executes realize IR against self-host credentials via injected spawn", async () => {
		const provider = createConvexProvider();
		const { driver } = provider.realize({
			name: "backend",
			port: "database",
			provider: CONVEX_PROVIDER_ID,
			deploymentId: "hobo-swaghaus",
		});
		const result = await applyDriverProgram({
			program: driver,
			root: "/tmp/swag",
			selfHostedUrl: "http://127.0.0.1:3210",
			selfHostedAdminKey: "admin|secret",
			spawn: async (input) => {
				expect(input.env.CONVEX_SELF_HOSTED_URL).toBe("http://127.0.0.1:3210");
				return {
					exitCode: 0,
					stdout: "ok http://127.0.0.1:3210\n",
					stderr: "",
				};
			},
		});
		expect(result.ok).toBe(true);
		expect(result.mode).toBe("self-hosted");
		expect(result.deploymentUrl).toBe("http://127.0.0.1:3210");
		expect(result.connectionRefs.deploymentUrl).toBe("http://127.0.0.1:3210");
		expect(JSON.stringify(result)).not.toContain("secret");
	});
});

describe("SDK resource definitions", () => {
	it("publishes defineResource adapters for Matching", () => {
		expect(CONVEX_SDK_RESOURCES.length).toBe(2);
		expect(CONVEX_SDK_RESOURCES[0]?.providerId).toBe(CONVEX_PROVIDER_ID);
		expect(CONVEX_SDK_RESOURCES[0]?.port).toBe("database");
		expect(CONVEX_SDK_RESOURCES[1]?.port).toBe("compute");
	});
});
