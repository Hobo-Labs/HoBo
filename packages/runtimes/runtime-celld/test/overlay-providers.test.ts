import { OVERLAY_PROVIDERS } from "@hobo/fleet";
import { describe, expect, it } from "vitest";

import {
	CELLD_OVERLAYS,
	CelldConfigError,
	parseCelldRuntimeConfig,
} from "../src/index.js";

const valid = {
	campId: "prod",
	tenantId: "acme",
	bucketUri: "s3://acme-cells",
	bucketSecretRef: "secret/celld-bucket",
	advertise: "cell-a.internal:8081",
	internalListen: "10.0.0.12:8081",
	overlay: "tailscale",
	svidBindingRef: "svid://camp/celld",
};

describe("celld overlay list is the fleet's OVERLAY_PROVIDERS", () => {
	it("is the same list, not a copy", () => {
		expect(CELLD_OVERLAYS).toBe(OVERLAY_PROVIDERS);
	});

	it.each([...OVERLAY_PROVIDERS])("accepts %s", (overlay) => {
		expect(parseCelldRuntimeConfig({ ...valid, overlay }).overlay).toBe(
			overlay,
		);
	});

	it.each([
		"zerotier",
		"",
		"Tailscale",
	])("refuses %j with OVERLAY_REQUIRED", (overlay) => {
		expect(() => parseCelldRuntimeConfig({ ...valid, overlay })).toThrow(
			CelldConfigError,
		);
		try {
			parseCelldRuntimeConfig({ ...valid, overlay });
		} catch (error) {
			expect(error).toMatchObject({ code: "OVERLAY_REQUIRED" });
		}
	});

	it("refuses a missing overlay and names the providers", () => {
		const { overlay: _omitted, ...rest } = valid;
		expect(() => parseCelldRuntimeConfig(rest)).toThrow(
			"overlay must be tailscale|netbird|wireguard",
		);
	});
});
