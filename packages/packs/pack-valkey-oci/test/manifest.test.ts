import assert from "node:assert/strict";
import {
	PackError,
	parsePackManifest,
	verifyPackManifest,
} from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	createValkeyPackManifest,
	VALKEY_DATA_MOUNT_PATH,
	VALKEY_DATA_VOLUME,
	VALKEY_IMAGE_DIGESTS,
	VALKEY_IMAGE_REPOSITORY,
	VALKEY_MIGRATION_PROFILE,
	VALKEY_PACK_ID,
	VALKEY_PACK_MANIFEST_DOCUMENT,
	VALKEY_PORT,
} from "../src/index.js";
import { FIXTURE_ANCHORS, FIXTURE_SIGNATURE, stubVerifier } from "./harness.js";

const manifest = createValkeyPackManifest(FIXTURE_SIGNATURE);

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

describe("the valkey pack manifest", () => {
	it("is pack.valkey.oci/v1 on the substrates that can run a container", () => {
		assert.equal(manifest.packId, VALKEY_PACK_ID);
		assert.deepEqual([...manifest.runtimeModels].sort(), [
			"oci",
			"paas",
			"vm_iaas",
		]);
		// A single-writer in-memory server with a volume is not a function
		// invocation, and there is no WASI Valkey build.
		assert.ok(!manifest.runtimeModels.includes("serverless_faas"));
		assert.ok(!manifest.runtimeModels.includes("wasm"));
	});

	it("pins every image by digest and never by tag", () => {
		assert.ok(manifest.images.length > 0);
		for (const image of manifest.images) {
			assert.match(image.digest, /^sha256:[0-9a-f]{64}$/u);
			assert.equal(image.reference.repository, VALKEY_IMAGE_REPOSITORY);
			assert.ok(!image.reference.ref.includes(":9-alpine"));
		}
		assert.deepEqual(
			manifest.images.map((image) => image.digest).sort(),
			Object.values(VALKEY_IMAGE_DIGESTS).sort(),
		);
	});

	it("claims only kv profiles — never a queue or a topic", () => {
		const claimed = manifest.implementsProfiles.map((entry) => entry.profileId);
		assert.deepEqual([...claimed].sort(), [
			"kv.redis-compatible/v1",
			"kv.valkey/v1",
		]);
		for (const profileId of claimed) {
			assert.ok(
				profileId.startsWith("kv."),
				`${profileId} is not a kv profile`,
			);
		}
		// Valkey has lists, streams, and pub/sub. None of them is a delivery
		// guarantee, so none of them appears here.
		assert.ok(!claimed.some((id) => id.startsWith("queue.")));
		assert.ok(!claimed.some((id) => id.startsWith("topic.")));
	});

	it("requires a volume at the path the image works in", () => {
		assert.equal(manifest.persistence.requirement, "required");
		const volume = manifest.persistence.volumes[0];
		assert.equal(volume?.name, VALKEY_DATA_VOLUME);
		assert.equal(volume?.mountPath, VALKEY_DATA_MOUNT_PATH);
		// An RDB or AOF is an ordinary file, so object storage cannot back it.
		assert.equal(volume?.externalStorageAllowed, false);
		assert.equal(volume?.accessMode, "single-writer");
	});

	it("requires the three retention settings with no defaults", () => {
		for (const key of ["durabilityMode", "evictionPolicy", "maxmemoryBytes"]) {
			const field = manifest.configSchema.find((entry) => entry.key === key);
			assert.equal(field?.necessity, "required", `${key} must be required`);
			// A default here would be the pack choosing the operator's data-loss
			// budget for them.
			assert.equal(
				field?.defaultValue,
				undefined,
				`${key} must not have a default`,
			);
		}
	});

	it("offers every documented durability mode and eviction policy as a choice", () => {
		const durability = manifest.configSchema.find(
			(entry) => entry.key === "durabilityMode",
		);
		assert.deepEqual(durability?.enumValues, [
			"none",
			"rdb-snapshots",
			"aof-everysec",
			"aof-always",
		]);
		const eviction = manifest.configSchema.find(
			(entry) => entry.key === "evictionPolicy",
		);
		assert.ok(eviction?.enumValues?.includes("noeviction"));
		assert.ok(eviction?.enumValues?.includes("allkeys-lru"));
	});

	it("is Yard-owned, so nothing is claimable from a provider", () => {
		assert.equal(manifest.ownership, "yard-owned");
	});

	it("produces the redis protocol binding and nothing else", () => {
		assert.deepEqual(manifest.producesBindingProfiles, [
			"binding.redis-protocol/v1",
		]);
	});

	it("declares argv-array operations, never a shell", () => {
		assert.ok(manifest.operations.length > 0);
		for (const operation of manifest.operations) {
			assert.equal(operation.shell, false);
			assert.notEqual(operation.credentialDelivery, "none");
		}
		const migration = manifest.operations.find(
			(operation) => operation.kind === "migration",
		);
		assert.equal(migration?.profileRef, VALKEY_MIGRATION_PROFILE);
	});

	it("probes with a command, because an open port is not a ready server", () => {
		// During an AOF load the socket accepts connections and every command is
		// answered with LOADING, so a TCP readiness probe would lie.
		assert.equal(manifest.probes.readiness.kind, "exec");
		assert.deepEqual(manifest.probes.liveness?.kind, "tcp");
		assert.equal(manifest.ports[0]?.containerPort, VALKEY_PORT);
		// Camp exposure: an in-memory store on a Yard-wide port is a lateral
		// movement path.
		assert.equal(manifest.ports[0]?.exposure, "camp");
	});

	it("cites a source for every fact it asserts", () => {
		assert.ok(manifest.provenance.sourceRefs.length >= 4);
		for (const ref of manifest.provenance.sourceRefs) {
			assert.match(ref.url, /^https:\/\//u);
			assert.match(ref.checkedAt, /^\d{4}-\d{2}-\d{2}$/u);
		}
		// Not invented: the digests came from the registry, not a build record.
		assert.equal(manifest.provenance.sourceRevision, "unverified");
	});

	it("does not claim container-executed conformance evidence it does not have", () => {
		assert.equal(manifest.conformance.executedAgainstContainer, false);
	});

	it("verifies against a trusted key and rejects an untrusted one", () => {
		const verified = verifyPackManifest({
			manifest,
			verifier: stubVerifier("valid"),
			anchors: FIXTURE_ANCHORS,
			requestedArchitecture: "linux/amd64",
		});
		assert.equal(verified.selectedArchitecture, "linux/amd64");
		assert.equal(
			verified.selectedImage.digest,
			VALKEY_IMAGE_DIGESTS["linux/amd64"],
		);

		expectPackError(
			() =>
				verifyPackManifest({
					manifest,
					verifier: stubVerifier("valid"),
					anchors: { ...FIXTURE_ANCHORS, trustedKeyIds: ["some-other-key"] },
					requestedArchitecture: "linux/amd64",
				}),
			"PACK_INTEGRITY_UNVERIFIED",
		);
	});

	it("refuses an architecture it has no digest for", () => {
		expectPackError(
			() =>
				verifyPackManifest({
					manifest,
					verifier: stubVerifier("valid"),
					anchors: FIXTURE_ANCHORS,
					requestedArchitecture: "linux/s390x",
				}),
			"ARCHITECTURE_UNSUPPORTED",
		);
	});

	it("rejects a document whose image reference carries a tag", () => {
		expectPackError(
			() =>
				parsePackManifest({
					...VALKEY_PACK_MANIFEST_DOCUMENT,
					images: [
						{
							architecture: "linux/amd64",
							reference: `${VALKEY_IMAGE_REPOSITORY}:9-alpine`,
						},
					],
					signature: FIXTURE_SIGNATURE,
				}),
			"PACK_INTEGRITY_UNVERIFIED",
		);
	});
});
