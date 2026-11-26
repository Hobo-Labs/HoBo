import { describe, expect, it } from "vitest";
import {
	createWebernetesProvider,
	supportsAnonymousTemporaryDeploy,
	webernetesNativePorts,
} from "../src/index.js";
import { provisionTemporaryEnvironmentStation } from "../src/temporary-station.js";

describe("@hobo/provider-webernetes", () => {
	it("exposes Matching-honest native ports", () => {
		const provider = createWebernetesProvider();
		expect(webernetesNativePorts().length).toBeGreaterThan(0);
		expect(provider.capabilities.length).toBe(webernetesNativePorts().length);
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(compute?.satisfies({ port: "compute" }).kind).toBe("full");
	});

	it("temporary deploy support flag is honest", () => {
		expect(supportsAnonymousTemporaryDeploy).toBe(true);
	});

	it("refuses to invent a station when no host transport was configured", async () => {
		await expect(
			provisionTemporaryEnvironmentStation({ stationId: "st-1" }),
		).rejects.toThrow("real local station host transport");
	});

	it("temporary provision path delegates to the configured local host", async () => {
		const result = await provisionTemporaryEnvironmentStation({
			stationId: "st-1",
			transport: {
				async provision({ stationId }) {
					return {
						stationUrl: `http://127.0.0.1:4321/stations/${stationId}/`,
						claimUrl: `http://127.0.0.1:4321/stations/${stationId}/#claim`,
					};
				},
			},
		});
		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.providerId).toBe("webernetes");
		expect(result.claimUrl.length).toBeGreaterThan(0);
	});

	it("hands back an endpoint actually served by the injected local host", async () => {
		const stationId = "station-real-local";
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ ok: true, stationId }));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			// SAFETY: a successful numeric TCP listen returns AddressInfo, not a Unix socket path.
			const address = server.address() as AddressInfo;
			const url = `http://127.0.0.1:${address.port}/stations/${stationId}/`;
			const station = await provisionTemporaryEnvironmentStation({
				stationId,
				transport: {
					async provision() {
						return { stationUrl: url, claimUrl: `${url}#claim` };
					},
				},
			});
			const response = await fetch(station.primaryUrl);
			expect(response.ok).toBe(true);
			expect(await response.json()).toEqual({ ok: true, stationId });
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
