import assert from "node:assert/strict";
import { PackError, parsePackConfiguration } from "@hobo/pack-framework";
import { describe, it } from "vitest";

import {
	buildPostgresContainerSpec,
	POSTGRES_DATA_MOUNT_PATH,
	POSTGRES_PASSWORD_FILE_PATH,
	POSTGRES_PGDATA,
} from "../src/index.js";
import { SUPERUSER_REF, verifiedPostgresPack } from "./harness.js";

const manifest = verifiedPostgresPack();

const VOLUME_BINDING = {
	volumeName: "pgdata",
	storage: { kind: "local-volume", volumeId: "vol-pg-0001" },
} as const;

interface PostgresConfigValues {
	dataVolume: string;
	superuserPasswordRef: string;
	databaseName?: string;
	ownerRole?: string;
	hostAuthMethod?: string;
	maxConnections?: number;
}

function configWith(
	values: PostgresConfigValues,
	bindings: readonly (typeof VOLUME_BINDING)[] = [VOLUME_BINDING],
) {
	return parsePackConfiguration(manifest, { values, volumeBindings: bindings });
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

describe("buildPostgresContainerSpec", () => {
	it("produces a spec pinned to the verified digest", () => {
		const spec = buildPostgresContainerSpec(
			manifest,
			configWith({ dataVolume: "pgdata", superuserPasswordRef: SUPERUSER_REF }),
		);
		assert.equal(spec.image, manifest.selectedImage.reference.ref);
		assert.match(spec.image, /@sha256:[0-9a-f]{64}$/u);
		assert.equal(spec.architecture, "linux/amd64");
	});

	it("delivers the password as a file, never as POSTGRES_PASSWORD", () => {
		const spec = buildPostgresContainerSpec(
			manifest,
			configWith({ dataVolume: "pgdata", superuserPasswordRef: SUPERUSER_REF }),
		);
		assert.equal(spec.env.POSTGRES_PASSWORD_FILE, POSTGRES_PASSWORD_FILE_PATH);
		assert.equal(spec.env.POSTGRES_PASSWORD, undefined);
		assert.deepEqual(spec.secretFiles, [
			{
				path: POSTGRES_PASSWORD_FILE_PATH,
				secretRef: SUPERUSER_REF,
				mode: "0400",
			},
		]);
		// Only a locator ever appears in the spec.
		for (const value of Object.values(spec.env)) {
			assert.ok(!value.includes("hobo-secret://"));
		}
	});

	it("mounts the volume at the path PGDATA lives under", () => {
		const spec = buildPostgresContainerSpec(
			manifest,
			configWith({ dataVolume: "pgdata", superuserPasswordRef: SUPERUSER_REF }),
		);
		assert.equal(spec.volumeMounts[0]?.mountPath, POSTGRES_DATA_MOUNT_PATH);
		assert.equal(spec.env.PGDATA, POSTGRES_PGDATA);
		assert.ok(POSTGRES_PGDATA.startsWith(`${POSTGRES_DATA_MOUNT_PATH}/`));
	});

	it("applies the declared defaults for the optional keys", () => {
		const spec = buildPostgresContainerSpec(
			manifest,
			configWith({ dataVolume: "pgdata", superuserPasswordRef: SUPERUSER_REF }),
		);
		assert.equal(spec.env.POSTGRES_DB, "app");
		assert.equal(spec.env.POSTGRES_USER, "postgres");
		assert.equal(spec.env.POSTGRES_HOST_AUTH_METHOD, "scram-sha-256");
		assert.deepEqual(spec.command, ["postgres", "-c", "max_connections=100"]);
	});

	it("refuses to describe a deployment with no durable storage", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: { dataVolume: "pgdata", superuserPasswordRef: SUPERUSER_REF },
				}),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});

	it("refuses external object storage for PGDATA", () => {
		expectPackError(
			() =>
				parsePackConfiguration(manifest, {
					values: { dataVolume: "pgdata", superuserPasswordRef: SUPERUSER_REF },
					volumeBindings: [
						{
							volumeName: "pgdata",
							storage: {
								kind: "external-storage",
								storageRef: "s3://backups/pg",
							},
						},
					],
				}),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});

	it("refuses a plaintext connection string where the credential locator belongs", () => {
		assert.throws(() =>
			configWith({
				dataVolume: "pgdata",
				superuserPasswordRef: "postgresql://postgres:hunter2@pg-main:5432/app",
			}),
		);
	});

	it("rejects a database name that is not a safe identifier", () => {
		expectPackError(
			() =>
				buildPostgresContainerSpec(
					manifest,
					configWith({
						dataVolume: "pgdata",
						superuserPasswordRef: SUPERUSER_REF,
						databaseName: 'app"; DROP DATABASE postgres; --',
					}),
				),
			"PACK_OPERATION_FAILED",
		);
	});

	it("rejects a dataVolume that does not name the declared volume", () => {
		expectPackError(
			() =>
				buildPostgresContainerSpec(
					manifest,
					parsePackConfiguration(manifest, {
						values: {
							dataVolume: "scratch",
							superuserPasswordRef: SUPERUSER_REF,
						},
						volumeBindings: [VOLUME_BINDING],
					}),
				),
			"PACK_PERSISTENCE_REQUIRED",
		);
	});

	it("rejects max_connections outside the declared range", () => {
		expectPackError(
			() =>
				configWith({
					dataVolume: "pgdata",
					superuserPasswordRef: SUPERUSER_REF,
					maxConnections: 1,
				}),
			"PACK_CONFIGURATION_INVALID",
		);
	});
});
