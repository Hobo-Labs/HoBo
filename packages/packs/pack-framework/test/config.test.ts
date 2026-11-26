import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	PackError,
	parsePackConfiguration,
	parsePackManifest,
} from "../src/index.js";
import { fixtureManifest } from "./harness.js";

const manifest = parsePackManifest(fixtureManifest());

const SECRET_REF = "hobo-secret://tenant-demo/packs/example/auth";

function expectPackError(fn: () => void, code: string): void {
	try {
		fn();
	} catch (error) {
		assert.ok(
			error instanceof PackError,
			`expected a PackError, got ${String(error)}`,
		);
		assert.equal(error.code, code);
		return;
	}
	throw new Error(`expected ${code} but nothing was thrown`);
}

describe("parsePackConfiguration", () => {
	it("parses a complete configuration into typed values", () => {
		const config = parsePackConfiguration(manifest, {
			values: { dataVolume: "data", authPasswordRef: SECRET_REF },
			volumeBindings: [
				{
					volumeName: "data",
					storage: { kind: "local-volume", volumeId: "vol-0001" },
				},
			],
		});
		assert.equal(config.requireString("dataVolume"), "data");
		assert.equal(config.requireSecretRef("authPasswordRef"), SECRET_REF);
		// The optional field's declared default is applied, not invented.
		assert.equal(config.requireInteger("maxMemoryBytes"), 256 * 1024 * 1024);
		assert.equal(
			config.requireVolumeBinding("data").storage.kind,
			"local-volume",
		);
	});

	it("refuses to run a persistent pack with no storage bound", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: { dataVolume: "data", authPasswordRef: SECRET_REF },
				}),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});

	it("refuses external storage for a volume that declares it is not allowed", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: { dataVolume: "data", authPasswordRef: SECRET_REF },
					volumeBindings: [
						{
							volumeName: "data",
							storage: {
								kind: "external-storage",
								storageRef: "s3://bucket/prefix",
							},
						},
					],
				}),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});

	it("rejects a plaintext credential supplied where a locator belongs", () => {
		assert.throws(() =>
			parsePackConfiguration(manifest, {
				values: {
					dataVolume: "data",
					authPasswordRef: "redis://user:hunter2@cache.internal:6379",
				},
				volumeBindings: [
					{
						volumeName: "data",
						storage: { kind: "local-volume", volumeId: "vol-0001" },
					},
				],
			}),
		);
	});

	it("rejects an undeclared configuration key", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: {
						dataVolume: "data",
						authPasswordRef: SECRET_REF,
						sneaky: "yes",
					},
					volumeBindings: [
						{
							volumeName: "data",
							storage: { kind: "local-volume", volumeId: "vol-0001" },
						},
					],
				}),
			"PACK_CONFIGURATION_INVALID",
		);
	});

	it("rejects a missing required key", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: { dataVolume: "data" },
					volumeBindings: [
						{
							volumeName: "data",
							storage: { kind: "local-volume", volumeId: "vol-0001" },
						},
					],
				}),
			"PACK_CONFIGURATION_INVALID",
		);
	});

	it("rejects an integer below its declared minimum", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: {
						dataVolume: "data",
						authPasswordRef: SECRET_REF,
						maxMemoryBytes: 1,
					},
					volumeBindings: [
						{
							volumeName: "data",
							storage: { kind: "local-volume", volumeId: "vol-0001" },
						},
					],
				}),
			"PACK_CONFIGURATION_INVALID",
		);
	});

	it("rejects a value of the wrong primitive type", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: {
						dataVolume: "data",
						authPasswordRef: SECRET_REF,
						maxMemoryBytes: "lots",
					},
					volumeBindings: [
						{
							volumeName: "data",
							storage: { kind: "local-volume", volumeId: "vol-0001" },
						},
					],
				}),
			"PACK_CONFIGURATION_INVALID",
		);
	});

	it("rejects a volume binding for an undeclared volume", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: { dataVolume: "data", authPasswordRef: SECRET_REF },
					volumeBindings: [
						{
							volumeName: "data",
							storage: { kind: "local-volume", volumeId: "vol-0001" },
						},
						{
							volumeName: "scratch",
							storage: { kind: "local-volume", volumeId: "vol-0002" },
						},
					],
				}),
			"PACK_CONFIGURATION_INVALID",
		);
	});
});
