import { describe, expect, it } from "vitest";

import {
	applyFluxDeploy,
	FLUX_RIVET_RUNNER_RECIPE,
	type JsonValue,
	parseFluxDeploySpec,
} from "../src/index.js";
import { isJsonArray, isJsonNumber, isJsonObject } from "../src/json.js";

describe("flux public live probes", () => {
	it("reaches the public Flux apps API without credentials", async () => {
		const response = await fetch(
			"https://api.runonflux.io/apps/whitelistedrepositories",
		);
		expect(response.ok).toBe(true);
		// SAFETY: fetch json() is a JSON value at this live-probe boundary.
		const body = (await response.json()) as JsonValue;
		expect(isJsonObject(body)).toBe(true);
		if (!isJsonObject(body)) return;
		expect(body.status).toBe("success");
		expect(isJsonArray(body.data)).toBe(true);
	});

	it("reaches daemon getinfo and does not treat it as actor HA", async () => {
		const response = await fetch("https://api.runonflux.io/daemon/getinfo");
		expect(response.ok).toBe(true);
		// SAFETY: fetch json() is a JSON value at this live-probe boundary.
		const body = (await response.json()) as JsonValue;
		expect(isJsonObject(body)).toBe(true);
		if (!isJsonObject(body)) return;
		expect(body.status).toBe("success");
		const data = isJsonObject(body.data) ? body.data : undefined;
		expect(isJsonNumber(data?.connections)).toBe(true);
	});

	it("still refuses to apply an actor primitive to Flux after a live probe", () => {
		expect(() =>
			parseFluxDeploySpec({
				source: "oci",
				imageDigest: "sha256:abc",
				tier: "paid-multi-instance",
				environment: "preview",
				primitives: ["actor"],
			}),
		).toThrow(/actor/);
		expect(FLUX_RIVET_RUNNER_RECIPE.runners).toBe("flux-outbound-only");
		expect(
			applyFluxDeploy(
				parseFluxDeploySpec({
					source: "git",
					tier: "community-free",
					environment: "preview",
					primitives: ["web"],
				}),
			).orbitMode,
		).toBe(true);
	});

	it("unsigned GET /apps/appregister is not a successful apply", async () => {
		let response: Response;
		try {
			response = await fetch("https://api.runonflux.io/apps/appregister", {
				signal: AbortSignal.timeout(8_000),
			});
		} catch (error) {
			throw new Error(
				`flux appregister probe failed (timeout/network is a failure): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		expect(response.ok).toBe(false);
		expect(response.status).toBeGreaterThanOrEqual(400);
	});
});
