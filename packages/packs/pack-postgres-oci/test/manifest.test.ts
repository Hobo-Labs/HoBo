import assert from "node:assert/strict";
import {
	PackError,
	parsePinnedImageRef,
	verifyPackManifest,
} from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	createPostgresPackManifest,
	POSTGRES_DATA_MOUNT_PATH,
	POSTGRES_IMAGE_DIGESTS,
	POSTGRES_IMAGE_REPOSITORY,
	POSTGRES_MIGRATION_PROFILE,
	POSTGRES_PACK_ID,
	POSTGRES_PACK_MANIFEST_DOCUMENT,
	POSTGRES_PGDATA,
	postgresImageReference,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import {
	FIXTURE_ANCHORS,
	FIXTURE_SIGNATURE,
	stubVerifier,
	verifiedPostgresPack,
} from "./harness.js";

describe("the postgres pack manifest", () => {
	it("parses and identifies itself as pack.postgres.oci/v1", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		assert.equal(manifest.packId, POSTGRES_PACK_ID);
		assert.equal(manifest.parsedPackId.family, "postgres");
		assert.deepEqual(manifest.parsedPackId.qualifiers, ["oci"]);
	});

	it("pins a sha256 digest for every architecture it claims, from one repository", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		assert.ok(manifest.images.length >= 2);
		for (const image of manifest.images) {
			assert.match(image.digest, /^sha256:[0-9a-f]{64}$/u);
			assert.equal(image.repository, POSTGRES_IMAGE_REPOSITORY);
			// No tag survives into the reference the executor will pull.
			assert.equal(
				image.reference.ref,
				`${POSTGRES_IMAGE_REPOSITORY}@${image.digest}`,
			);
		}
	});

	it("exposes the same digests through the image helper", () => {
		assert.equal(
			postgresImageReference("linux/amd64"),
			`${POSTGRES_IMAGE_REPOSITORY}@${POSTGRES_IMAGE_DIGESTS["linux/amd64"]}`,
		);
		// An architecture with no evidence gets no reference rather than a guess.
		assert.equal(postgresImageReference("linux/s390x"), undefined);
	});

	it("cannot be re-pinned to a tag", () => {
		assert.throws(
			() => parsePinnedImageRef(`${POSTGRES_IMAGE_REPOSITORY}:18-alpine`),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "PACK_INTEGRITY_UNVERIFIED");
				return true;
			},
		);
	});

	it("requires persistent storage at the path the pinned image actually uses", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		assert.equal(manifest.persistence.requirement, "required");
		if (manifest.persistence.requirement !== "required") return;
		const volume = manifest.persistence.volumes[0];
		assert.equal(volume?.mountPath, POSTGRES_DATA_MOUNT_PATH);
		// PostgreSQL 18 moved PGDATA under the volume; a mount at the old
		// /var/lib/postgresql/data would not cover it.
		assert.ok(POSTGRES_PGDATA.startsWith(`${POSTGRES_DATA_MOUNT_PATH}/`));
		assert.equal(volume?.accessMode, "single-writer");
		assert.equal(volume?.externalStorageAllowed, false);
	});

	it("claims data.postgres/v1 and data.relational/v1, both as realization pack", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		const ids = manifest.implementsProfiles.map((claim) => claim.profileId);
		assert.deepEqual(ids, ["data.postgres/v1", "data.relational/v1"]);
		for (const claim of manifest.implementsProfiles) {
			assert.equal(claim.realization, "pack");
			assert.equal(claim.conformance, "pass");
		}
	});

	it("makes no managed-provider claim and stays Yard-owned", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		assert.equal(manifest.ownership, "yard-owned");
		const serialized = JSON.stringify(manifest);
		assert.ok(!serialized.includes("provider-claim"));
	});

	it("declares an export path and the pg-dump migration profile", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		const kinds = manifest.operations.map((operation) => operation.kind);
		assert.ok(kinds.includes("backup"));
		assert.ok(kinds.includes("restore"));
		assert.ok(
			manifest.operations.some(
				(operation) =>
					operation.kind === "migration" &&
					operation.profileRef === POSTGRES_MIGRATION_PROFILE,
			),
		);
		for (const operation of manifest.operations) {
			assert.equal(operation.shell, false);
			assert.notEqual(operation.credentialDelivery, "none");
		}
	});

	it("uses pg_isready for readiness rather than an open port", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		assert.equal(manifest.probes.readiness.kind, "exec");
		if (manifest.probes.readiness.kind !== "exec") return;
		assert.equal(manifest.probes.readiness.argv[0], "pg_isready");
	});

	it("does not let a required configuration key carry a default", () => {
		const manifest = createPostgresPackManifest(FIXTURE_SIGNATURE);
		for (const field of manifest.configSchema) {
			if (field.necessity === "required")
				assert.equal(field.defaultValue, undefined);
			if (field.kind === "secret-ref")
				assert.equal(field.defaultValue, undefined);
		}
	});

	it("never offers trust as a host authentication method", () => {
		const field = POSTGRES_PACK_MANIFEST_DOCUMENT.configSchema.find(
			(entry) => entry.key === "hostAuthMethod",
		);
		assert.ok(field?.enumValues !== undefined);
		assert.ok(!(field?.enumValues ?? []).includes("trust"));
	});

	it("cites its sources with the date each was checked", () => {
		for (const source of POSTGRES_PACK_MANIFEST_DOCUMENT.provenance
			.sourceRefs) {
			assert.match(source.url, /^https:\/\//u);
			assert.match(source.checkedAt, /^\d{4}-\d{2}-\d{2}$/u);
			assert.ok(source.note.length > 0);
		}
	});

	it("does not claim container-executed conformance evidence it does not have", () => {
		assert.equal(
			POSTGRES_PACK_MANIFEST_DOCUMENT.conformance.executedAgainstContainer,
			false,
		);
	});
});

describe("verification of the postgres pack", () => {
	it("selects the image for the requested architecture", () => {
		assert.equal(
			verifiedPostgresPack("linux/arm64").selectedImage.digest,
			POSTGRES_IMAGE_DIGESTS["linux/arm64"],
		);
	});

	it("refuses an architecture the pack has no evidence for", () => {
		assert.throws(
			() =>
				verifyPackManifest({
					manifest: createPostgresPackManifest(FIXTURE_SIGNATURE),
					verifier: stubVerifier("valid"),
					anchors: FIXTURE_ANCHORS,
					requestedArchitecture: "linux/s390x",
				}),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "ARCHITECTURE_UNSUPPORTED");
				return true;
			},
		);
	});

	it("refuses to run when the manifest is unsigned by a trusted key", () => {
		assert.throws(
			() =>
				verifyPackManifest({
					manifest: createPostgresPackManifest(FIXTURE_SIGNATURE),
					verifier: stubVerifier("unknown"),
					anchors: FIXTURE_ANCHORS,
					requestedArchitecture: "linux/amd64",
				}),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "PACK_INTEGRITY_UNVERIFIED");
				return true;
			},
		);
	});

	it("refuses a registry outside the operator's allowlist", () => {
		assert.throws(
			() =>
				verifyPackManifest({
					manifest: createPostgresPackManifest(FIXTURE_SIGNATURE),
					verifier: stubVerifier("valid"),
					anchors: {
						trustedKeyIds: [FIXTURE_SIGNATURE.keyId],
						allowedRegistries: ["ghcr.io"],
					},
					requestedArchitecture: "linux/amd64",
				}),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "PACK_INTEGRITY_UNVERIFIED");
				return true;
			},
		);
	});

	it("detects a document edited after signing", () => {
		assert.throws(
			() =>
				verifyPackManifest({
					manifest: createPostgresPackManifest({
						...FIXTURE_SIGNATURE,
						payloadDigest:
							"sha256:0000000000000000000000000000000000000000000000000000000000000000",
					}),
					verifier: stubVerifier("valid"),
					anchors: FIXTURE_ANCHORS,
					requestedArchitecture: "linux/amd64",
				}),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "PROVIDER_CONTRACT_CHANGED");
				return true;
			},
		);
	});
});
