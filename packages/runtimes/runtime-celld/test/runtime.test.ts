import { describe, expect, it } from "vitest";

import {
	CELLD_ON_FLUX,
	CELLD_PIN,
	CelldConfigError,
	celldCellName,
	createCelldRuntimeHost,
	HOBO_RUNTIME_CELLD_PACKAGE,
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

describe("@hobo/runtime-celld", () => {
	it("package id and experimental pin notes", () => {
		expect(HOBO_RUNTIME_CELLD_PACKAGE).toBe("@hobo/runtime-celld");
		expect(CELLD_PIN.license).toBe("Apache-2.0");
		expect(CELLD_PIN.tag).toBe("v0.2.1");
		expect(CELLD_PIN.pinnedRef).toContain("@sha256:7a438072");
		expect(CELLD_ON_FLUX.status).toBe("unsupported");
		expect(CELLD_ON_FLUX.missingProofs).toHaveLength(10);
	});

	it("parses overlay-private config and names cells from HoBo identity", () => {
		const config = parseCelldRuntimeConfig(valid);
		expect(config.operatorPortPublic).toBe(false);
		expect(
			celldCellName({
				tenantId: "acme",
				projectId: "shop",
				actorTypeId: "Cart",
				keySegments: ["user-1"],
				schemaVersion: 1,
			}),
		).toBe("hobo/acme/shop/Cart/user-1");
	});

	it("fails closed on public operator port, hostile isolation, secrets, and FS buckets", () => {
		expect(() =>
			parseCelldRuntimeConfig({ ...valid, operatorPortPublic: true }),
		).toThrow(CelldConfigError);
		expect(() =>
			parseCelldRuntimeConfig({ ...valid, isolation: "hostile" }),
		).toThrow(/hostile/);
		expect(() =>
			parseCelldRuntimeConfig({ ...valid, bucketSecretRef: "AKIAEXAMPLE" }),
		).toThrow(/locator/);
		expect(() =>
			parseCelldRuntimeConfig({ ...valid, bucketUri: "file:///tmp/cells" }),
		).toThrow(/s3/);
		expect(() =>
			parseCelldRuntimeConfig({ ...valid, componentModelWasm: true }),
		).toThrow(/Component Model/);
	});

	it("doctor records mocked CAS and keeps Flux recipe unsupported", () => {
		const bundle = createCelldRuntimeHost(valid, {
			conditionalWrite: true,
			readAfterWrite: true,
		});
		expect(bundle.ensure().placementMode).toBe("celld");
		expect(bundle.doctor.bucketCasOk).toBe(true);
		expect(bundle.doctor.celldOnFlux.status).toBe("unsupported");
	});
});
