import assert from "node:assert/strict";
import { PackError, parsePackConfiguration } from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	buildValkeyContainerSpec,
	VALKEY_CONFIG_PATH,
	VALKEY_DATA_MOUNT_PATH,
	VALKEY_REQUIREPASS_INCLUDE_PATH,
} from "../src/index.js";
import {
	AUTH_REF,
	REQUIRED_VALUES,
	VOLUME_BINDING,
	verifiedValkeyPack,
} from "./harness.js";

const manifest = verifiedValkeyPack();

function configWith(
	overrides: Partial<typeof REQUIRED_VALUES> = {},
	bindings: readonly (typeof VOLUME_BINDING)[] = [VOLUME_BINDING],
) {
	return parsePackConfiguration(manifest, {
		values: { ...REQUIRED_VALUES, ...overrides },
		volumeBindings: bindings,
	});
}

function expectPackError(fn: () => void, code: string): void {
	try {
		fn();
	} catch (error) {
		assert.ok(
			error instanceof PackError,
			`expected PackError, got ${String(error)}`,
		);
		assert.equal(error.code, code);
		return;
	}
	throw new Error(`expected ${code} but nothing was thrown`);
}

/** The rendered config, split into directives for assertion. */
function directives(
	overrides: Record<string, string | number | boolean> = {},
): string[] {
	const spec = buildValkeyContainerSpec(manifest, configWith(overrides));
	const file = spec.configFiles[0];
	assert.ok(file !== undefined);
	return file.contents
		.split("\n")
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("buildValkeyContainerSpec", () => {
	it("produces a spec pinned to the verified digest", () => {
		const spec = buildValkeyContainerSpec(manifest, configWith());
		assert.equal(spec.image, manifest.selectedImage.reference.ref);
		assert.match(spec.image, /@sha256:[0-9a-f]{64}$/u);
		assert.deepEqual(spec.command, ["valkey-server", VALKEY_CONFIG_PATH]);
	});

	it("keeps the credential out of argv and out of the environment", () => {
		const spec = buildValkeyContainerSpec(manifest, configWith());
		// argv is world-readable through `ps`.
		for (const element of spec.command) {
			assert.ok(!element.includes("hobo-secret://"));
			assert.ok(!element.includes("requirepass"));
		}
		// An environment variable is visible in /proc/<pid>/environ and in
		// `docker inspect`. This pack sets none at all.
		assert.deepEqual(spec.env, {});
		assert.deepEqual(spec.secretFiles, [
			{
				path: VALKEY_REQUIREPASS_INCLUDE_PATH,
				secretRef: AUTH_REF,
				format: "valkey-conf-requirepass",
				mode: "0400",
			},
		]);
	});

	it("includes the credential file last, where nothing can override it", () => {
		const lines = directives();
		assert.equal(lines.at(-1), `include ${VALKEY_REQUIREPASS_INCLUDE_PATH}`);
		// The rendered config never contains the material or its locator.
		assert.ok(!lines.some((line) => line.includes("hobo-secret://")));
		assert.ok(!lines.some((line) => line.startsWith("requirepass")));
	});

	it("points the data directory at the mounted volume", () => {
		const spec = buildValkeyContainerSpec(manifest, configWith());
		assert.equal(spec.volumeMounts[0]?.mountPath, VALKEY_DATA_MOUNT_PATH);
		assert.ok(directives().includes(`dir ${VALKEY_DATA_MOUNT_PATH}`));
	});

	it("turns snapshots off explicitly in cache mode", () => {
		// The shipped default config saves on a schedule, so silence would mean
		// snapshots — the empty `save` has to be written out.
		const lines = directives({
			durabilityMode: "none",
			evictionPolicy: "allkeys-lru",
		});
		assert.ok(lines.includes('save ""'));
		assert.ok(lines.includes("appendonly no"));
		assert.ok(!lines.some((line) => line.startsWith("save 9")));
	});

	it("writes a snapshot schedule for rdb-snapshots and no append-only file", () => {
		const lines = directives({ durabilityMode: "rdb-snapshots" });
		assert.ok(lines.includes("save 60 1000"));
		assert.ok(lines.includes("appendonly no"));
	});

	it("writes the matching appendfsync for each aof mode", () => {
		const everysec = directives({ durabilityMode: "aof-everysec" });
		assert.ok(everysec.includes("appendonly yes"));
		assert.ok(everysec.includes("appendfsync everysec"));
		// The AOF is the durability mechanism; snapshots on top of it would
		// double write amplification for no extra guarantee.
		assert.ok(everysec.includes('save ""'));

		const always = directives({ durabilityMode: "aof-always" });
		assert.ok(always.includes("appendfsync always"));
	});

	it("writes the eviction policy and memory limit the operator chose", () => {
		const lines = directives({
			evictionPolicy: "volatile-ttl",
			maxmemoryBytes: 134217728,
		});
		assert.ok(lines.includes("maxmemory-policy volatile-ttl"));
		assert.ok(lines.includes("maxmemory 134217728"));
	});

	it("carries the retention semantics it implements, so a receipt records them", () => {
		const durable = buildValkeyContainerSpec(manifest, configWith());
		assert.equal(durable.retention.durability.mode, "aof-everysec");
		assert.equal(durable.retention.durability.worstCaseLossMs, 1000);
		assert.equal(durable.retention.keyLossPossible, false);

		const cache = buildValkeyContainerSpec(
			manifest,
			configWith({ durabilityMode: "none", evictionPolicy: "allkeys-lru" }),
		);
		assert.equal(cache.retention.durability.worstCaseLossMs, null);
		assert.equal(cache.retention.keyLossPossible, true);
	});

	it("refuses a deployment with no durable storage", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, { values: { ...REQUIRED_VALUES } }),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});

	it("refuses external object storage for an AOF", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: { ...REQUIRED_VALUES },
					volumeBindings: [
						{
							volumeName: "valkey-data",
							storage: {
								kind: "external-storage",
								storageRef: "s3://cache/valkey",
							},
						},
					],
				}),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});

	it("refuses a configuration that omits a required retention setting", () => {
		for (const key of [
			"durabilityMode",
			"evictionPolicy",
			"maxmemoryBytes",
		] as const) {
			const { [key]: _dropped, ...rest } = REQUIRED_VALUES;
			expectPackError(
				() =>
					parsePackConfiguration(manifest, {
						values: rest,
						volumeBindings: [VOLUME_BINDING],
					}),
				"PACK_CONFIGURATION_INVALID",
			);
		}
	});

	it("refuses an unknown durability mode or eviction policy", () => {
		expectPackError(
			() => configWith({ durabilityMode: "sometimes" }),
			"PACK_CONFIGURATION_INVALID",
		);
		expectPackError(
			() => configWith({ evictionPolicy: "allkeys-vibes" }),
			"PACK_CONFIGURATION_INVALID",
		);
	});

	it("refuses a maxmemory below the declared floor", () => {
		// A server with a limit smaller than its own overhead evicts constantly
		// and looks like data loss.
		expectPackError(
			() => configWith({ maxmemoryBytes: 1024 }),
			"PACK_CONFIGURATION_INVALID",
		);
	});

	it("refuses a plaintext credential where the locator belongs", () => {
		assert.throws(() =>
			configWith({ authPasswordRef: "redis://default:hunter2@cache:6379" }),
		);
	});

	it("rejects a dataVolume that does not name the declared volume", () => {
		expectPackError(
			() =>
				buildValkeyContainerSpec(
					manifest,
					configWith({ dataVolume: "scratch" }),
				),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});
});
