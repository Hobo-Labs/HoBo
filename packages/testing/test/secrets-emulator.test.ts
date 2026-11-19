import { resolveConfigEntry } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { createSecretEmulator, createTestHarness } from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

function app() {
	return fakeBindle({
		resources: {
			credentials: { kind: "secret" },
			other: { kind: "secret" },
		},
		handlers: {},
	});
}

describe("in-process secrets", () => {
	it("exposes versioned secret access through the real HoBo port", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const secrets = graph.secret("credentials");
			const first = await secrets.put("API_KEY", "fixture-one");
			const second = await secrets.put("API_KEY", "fixture-two");
			expect(second.versionId).not.toBe(first.versionId);
			expect(await secrets.access("API_KEY")).toMatchObject({
				status: "ok",
				material: "fixture-two",
				versionId: second.versionId,
			});
			expect(
				await secrets.accessVersion("API_KEY", first.versionId),
			).toMatchObject({ status: "ok", material: "fixture-one" });
			expect(await graph.secret("other").access("API_KEY")).toMatchObject({
				status: "denied",
				code: "secret-not-found",
			});
			expect(graph.resource("credentials").fidelity).toBe("simulated");
			expect(JSON.stringify(graph.outputs())).not.toContain("fixture-");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("can be injected into the identity resolver without leaking material", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const secrets = graph.secret("credentials");
			await secrets.put("API_KEY", "fixture-private-material");
			const result = await resolveConfigEntry({
				name: "API_KEY",
				sensitive: true,
				preferredSource: "provider-federation",
				allowedSources: ["provider-federation"],
				secretsPort: secrets,
			});
			expect(result.status).toBe("resolved");
			expect(JSON.stringify(result)).not.toContain("fixture-private-material");
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("isolates redeployments and accepts a swappable mock with cleanup", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				secret: () => ({
					...createSecretEmulator(),
					fidelity: "mocked",
					close: () => {
						closed += 1;
					},
				}),
			},
		});
		const bindle = app();
		let graph = await harness.deploy(bindle)();
		await graph.secret("credentials").put("API_KEY", "fixture-one");
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		graph = await harness.deploy(bindle)();
		try {
			expect(await graph.secret("credentials").access("API_KEY")).toMatchObject(
				{ status: "denied", code: "secret-not-found" },
			);
		} finally {
			await harness.destroy(bindle)();
		}
		expect(closed).toBe(4);
	});
});
