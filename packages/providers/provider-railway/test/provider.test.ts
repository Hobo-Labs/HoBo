import { describe, expect, it } from "vitest";
import {
	createRailwayProvider,
	railwayNativePorts,
	supportsAnonymousTemporaryDeploy,
} from "../src/index.js";
import {
	provisionTemporaryEnvironmentStation,
	TemporaryProvisionUnavailableError,
} from "../src/temporary-station.js";

describe("@hobo/provider-railway", () => {
	it("exposes Matching-honest native ports", () => {
		const provider = createRailwayProvider();
		expect(railwayNativePorts().length).toBeGreaterThan(0);
		expect(provider.capabilities.length).toBe(railwayNativePorts().length);
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(compute?.satisfies({ port: "compute" }).kind).toBe("full");
	});

	it("temporary deploy support flag is honest", () => {
		expect(supportsAnonymousTemporaryDeploy).toBe(false);
	});

	it("temporary provision path", async () => {
		// The previous `/fail closed|no password-free|Temporary/i` matched the
		// word "Temporary" — which the *class name* and half the vocabulary in
		// this package contain — so it could not distinguish this refusal from
		// any other error thrown on the way. The refusal is structured data on
		// purpose; assert the data, not a word in the prose.
		const refused = await provisionTemporaryEnvironmentStation({
			stationId: "st-1",
		}).then(
			() => undefined,
			(cause: Error) => cause,
		);
		expect(
			refused,
			"temporary provisioning resolved instead of refusing",
		).toBeInstanceOf(TemporaryProvisionUnavailableError);
		if (!(refused instanceof TemporaryProvisionUnavailableError)) {
			throw new Error("expected TemporaryProvisionUnavailableError");
		}
		const error = refused;
		// Literals, not `railwayTemporaryStationRefusal()`: comparing the
		// refusal to the same function that produced it asserts nothing at all
		// — it stays green through any change to the payload.
		expect(error.code).toBe("HOBO_TEMP_PROVISION_UNAVAILABLE");
		expect(error.refusal).toEqual({
			providerId: "railway",
			code: "HOBO_TEMP_PROVISION_UNAVAILABLE",
			supportsAnonymousTemporaryDeploy: false,
			reason:
				"Railway has no password-free Temporary Accounts / agent provision API. Examples fail closed — no permanent tokens.",
		});
	});
});
