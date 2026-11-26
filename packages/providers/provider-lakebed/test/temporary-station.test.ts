import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import { createLakebedProvider, lakebedNativePorts } from "../src/index.js";
import {
	type LakebedAnonymousTransport,
	parseLakebedDeployOutput,
	provisionTemporaryEnvironmentStation,
	supportsAnonymousTemporaryDeploy,
} from "../src/temporary-station.js";

describe("lakebed anonymous temporary station", () => {
	it("advertises anonymous temporary deploy support", () => {
		expect(supportsAnonymousTemporaryDeploy).toBe(true);
	});

	it("native ports match equivalence (no queue/container fiction)", () => {
		expect([...lakebedNativePorts()].sort()).toEqual(
			["compute", "database", "kv", "objectStore"].sort(),
		);
		const provider = createLakebedProvider();
		expect(provider.capabilities.map((c) => c.port).sort()).toEqual(
			["compute", "database", "kv", "objectStore"].sort(),
		);
		expect(
			must(
				provider.capabilities.find((c) => c.port === "kv"),
				"provider.capabilities .find((c) => c.port === 'kv')",
			).satisfies({ port: "kv", features: ["durable"] }).kind,
		).toBe("full");
		expect(
			must(
				provider.capabilities.find((c) => c.port === "compute"),
				"provider.capabilities .find((c) => c.port === 'compute')",
			).satisfies({ port: "compute", features: ["container"] }).kind,
		).toBe("partial");
	});

	it("parses lakebed deploy JSON and URL output", () => {
		expect(
			parseLakebedDeployOutput(
				'{"deployId":"d1","url":"https://d1.lakebed.app","claimUrl":"https://lakebed.dev/claim/d1","expiresAt":"2030-01-01T00:00:00.000Z"}\n',
			),
		).toEqual({
			deployId: "d1",
			stationUrl: "https://d1.lakebed.app",
			claimUrl: "https://lakebed.dev/claim/d1",
			expiresAt: "2030-01-01T00:00:00.000Z",
		});
		expect(() =>
			parseLakebedDeployOutput("Deployed: https://anon42.lakebed.app/\n"),
		).toThrow("provider-issued claim URL");
	});

	it("reads current CLI pretty JSON without confusing the API and application URLs", () => {
		const parsed = parseLakebedDeployOutput(
			JSON.stringify(
				{
					api: "https://api.lakebed.dev",
					deployId: "dep_actual",
					expiresAt: "2030-01-01T00:00:00.000Z",
					url: "https://actual.lakebed.app",
					claimUrl:
						"https://api.lakebed.dev/claim/dep_actual/provider-issued-token",
				},
				null,
				2,
			),
		);
		expect(parsed.stationUrl).toBe("https://actual.lakebed.app");
		expect(parsed.claimUrl).toBe(
			"https://api.lakebed.dev/claim/dep_actual/provider-issued-token",
		);
	});

	it("rejects URLs that are not owned Lakebed endpoints", () => {
		expect(() =>
			parseLakebedDeployOutput(
				'{"deployId":"d1","url":"https://attacker.example","claimUrl":"https://lakebed.dev/claim/d1","expiresAt":"2030-01-01T00:00:00.000Z"}',
			),
		).toThrow("unexpected host");
	});

	it("provisions via injectable transport (no LAKEBED_TOKEN)", async () => {
		const transport: LakebedAnonymousTransport = {
			async deployAnonymous({ stationId }) {
				return {
					deployId: `dep-${stationId}`,
					stationUrl: `https://${stationId}.lakebed.app`,
					claimUrl: `https://lakebed.dev/claim/dep-${stationId}`,
					expiresAt: "2030-01-01T00:00:00.000Z",
				};
			},
		};
		const result = await provisionTemporaryEnvironmentStation({
			stationId: "st-lakebed-1",
			transport,
		});
		expect(result).toMatchObject({
			stationId: "st-lakebed-1",
			stationUrl: "https://st-lakebed-1.lakebed.app",
			primaryUrl: "https://st-lakebed-1.lakebed.app",
			claimUrl: "https://lakebed.dev/claim/dep-st-lakebed-1",
			providerId: "lakebed",
			anonymous: true,
			temporary: true,
		});
		expect(result.expiresAt).toMatch(/^\d{4}-/);
	});
});
