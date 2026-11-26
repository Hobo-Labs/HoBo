/**
 * The parse boundary between a Yard's untrusted request and a container spec.
 *
 * These tests deliberately pass `unknown`-shaped input — the sort of thing an
 * HTTP body or a manifest file actually contains — because the value of the
 * boundary is what it refuses, not what it accepts.
 */
import { describe, expect, it } from "vitest";

import {
	buildValkeyDeployment,
	parseValkeyDeploymentRequest,
	parseValkeyResourceRef,
} from "../src/index.js";
import { AUTH_REF, REQUIRED_VALUES, verifiedValkeyPack } from "./harness.js";

const REQUEST = {
	resourceRef: "resource:yard-1/cache-main",
	values: { ...REQUIRED_VALUES },
	volumeBindings: [
		{
			volumeName: "valkey-data",
			storage: { kind: "local-volume", volumeId: "vol-valkey-1" },
		},
	],
};

describe("parseValkeyResourceRef", () => {
	it("accepts resource:<yard>/<name>", () => {
		expect(parseValkeyResourceRef("resource:yard-1/cache-main")).toBe(
			"resource:yard-1/cache-main",
		);
	});

	it.each([
		["a display name", "cache main"],
		["a missing yard segment", "resource:cache-main"],
		["an uppercase segment", "resource:Yard-1/cache-main"],
		["a number", 7],
		["null", null],
	])("refuses %s", (_case, input) => {
		expect(() => parseValkeyResourceRef(input)).toThrow(
			/resource:<yard>\/<name>/u,
		);
	});
});

describe("parseValkeyDeploymentRequest", () => {
	it("produces a request whose configuration is already checked against the manifest", () => {
		const request = parseValkeyDeploymentRequest(verifiedValkeyPack(), REQUEST);

		expect(request.resourceRef).toBe("resource:yard-1/cache-main");
		expect(request.config.requireString("durabilityMode")).toBe("aof-everysec");
		expect(request.config.requireSecretRef("authPasswordRef")).toBe(AUTH_REF);
	});

	it("refuses a nested configuration value rather than stringifying it", () => {
		expect(() =>
			parseValkeyDeploymentRequest(verifiedValkeyPack(), {
				...REQUEST,
				values: { ...REQUIRED_VALUES, maxmemoryBytes: { bytes: 268_435_456 } },
			}),
		).toThrow(/must be a string, number, or boolean/u);
	});

	it("refuses a volume binding with no recognised storage kind", () => {
		expect(() =>
			parseValkeyDeploymentRequest(verifiedValkeyPack(), {
				...REQUEST,
				volumeBindings: [
					{ volumeName: "valkey-data", storage: { kind: "magic" } },
				],
			}),
		).toThrow(/local-volume or external-storage/u);
	});

	it("refuses a request that omits the volume the pack requires", () => {
		expect(() =>
			parseValkeyDeploymentRequest(verifiedValkeyPack(), {
				...REQUEST,
				volumeBindings: [],
			}),
		).toThrow();
	});

	it("refuses a request that omits a required retention setting", () => {
		const { durabilityMode: _dropped, ...rest } = REQUIRED_VALUES;
		expect(() =>
			parseValkeyDeploymentRequest(verifiedValkeyPack(), {
				...REQUEST,
				values: rest,
			}),
		).toThrow(/durabilityMode/u);
	});

	it("refuses input that is not an object at all", () => {
		expect(() =>
			parseValkeyDeploymentRequest(verifiedValkeyPack(), ["resource:yard-1/x"]),
		).toThrow(/must be an object/u);
	});
});

describe("buildValkeyDeployment", () => {
	it("carries the parsed resource ref through to the plan alongside the spec", () => {
		const manifest = verifiedValkeyPack();
		const plan = buildValkeyDeployment(
			manifest,
			parseValkeyDeploymentRequest(manifest, REQUEST),
		);

		expect(plan.resourceRef).toBe("resource:yard-1/cache-main");
		expect(plan.spec.image).toContain("@sha256:");
		expect(plan.spec.volumeMounts[0]?.binding.storage).toEqual({
			kind: "local-volume",
			volumeId: "vol-valkey-1",
		});
	});
});
