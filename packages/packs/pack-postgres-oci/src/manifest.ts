/**
 * `pack.postgres.oci/v1` — the manifest document.
 *
 * The document ships **unsigned** and `createPostgresPackManifest` attaches a
 * signature the operator's release pipeline produced. This repo holds no signing
 * key, so a manifest with a signature baked in would either carry a fake
 * signature or imply a key exists. `POSTGRES_PACK_PAYLOAD_DIGEST` is the digest a
 * signer must cover, computed from the same canonicalization the verifier uses.
 */
import {
	type PackManifestInput,
	type PackSignature,
	type ParsedPackManifest,
	packManifestPayloadDigest,
	parsePackManifest,
} from "@hobo/pack-framework";

import {
	POSTGRES_DATA_MOUNT_PATH,
	POSTGRES_IMAGE_DIGESTS,
	POSTGRES_IMAGE_INDEX_DIGEST,
	POSTGRES_IMAGE_REPOSITORY,
	POSTGRES_PGDATA,
	POSTGRES_PORT,
	POSTGRES_RESOLVED_FROM_TAG,
	POSTGRES_SERVER_MAJOR,
	POSTGRES_SERVER_VERSION,
} from "./image.js";

// public-contract: stable identifier for PostgreSQL OCI pack selection.
export const POSTGRES_PACK_ID = "pack.postgres.oci/v1" as const;
// public-contract: serialized pack version.
export const POSTGRES_PACK_VERSION = "1.0.0" as const;

/** The migration profile this pack implements. */
// public-contract: migration profile advertised by this pack.
export const POSTGRES_MIGRATION_PROFILE =
	"migration.postgres.pg-dump/v1" as const;

// public-contract: conformance evidence expected from this pack.
export const POSTGRES_CONFORMANCE_SUITE_REF =
	"hobo.conformance/pack.postgres.oci/v1" as const;

const CHECKED = "2026-08-08";

/**
 * The volume name a deployment must bind. Exported because it appears in three
 * places — the manifest, the configuration schema, and the container spec — and a
 * typo across them would be a runtime surprise rather than a compile error.
 */
// public-contract: stable logical volume name in pack manifests.
export const POSTGRES_DATA_VOLUME = "pgdata" as const;

/**
 * A minimum that reflects the image, not a guess: an initialised PostgreSQL 18
 * cluster with WAL needs well over a hundred megabytes before any user data, so a
 * 1 GiB floor is the smallest honest number for a volume that is expected to hold
 * a working database.
 */
const POSTGRES_MINIMUM_VOLUME_BYTES = 1024 * 1024 * 1024;

export const POSTGRES_PACK_MANIFEST_DOCUMENT: Omit<
	PackManifestInput,
	"signature"
> = {
	schemaVersion: "hobo.pack-manifest/v1",
	packId: POSTGRES_PACK_ID,
	packVersion: POSTGRES_PACK_VERSION,
	displayName: `PostgreSQL ${POSTGRES_SERVER_VERSION} (OCI pack)`,
	description:
		"Upstream PostgreSQL run as a container on compute the operator already owns. Satisfies data.postgres/v1 and, by refinement, data.relational/v1 without a managed database product.",
	// A container image runs on an OCI runtime; a VM or a PaaS that accepts an
	// OCI image is the same bytes with a different scheduler. `serverless_faas`
	// and `wasm` are deliberately absent: a single-writer database with a
	// persistent volume is not a function invocation, and there is no PostgreSQL
	// build that runs as a WASI component today.
	runtimeModels: ["oci", "vm_iaas", "paas"],
	implementsProfiles: [
		{
			profileId: "data.postgres/v1",
			versionRange: ">=1",
			conformanceRef: `${POSTGRES_CONFORMANCE_SUITE_REF}#data.postgres@${CHECKED}`,
			conformance: "pass",
		},
		{
			// Declared explicitly as well as by refinement: a requirement for
			// data.relational/v1 should not depend on the registry's refinement
			// graph being loaded to match.
			profileId: "data.relational/v1",
			versionRange: ">=1",
			conformanceRef: `${POSTGRES_CONFORMANCE_SUITE_REF}#data.relational@${CHECKED}`,
			conformance: "pass",
		},
	],
	images: Object.entries(POSTGRES_IMAGE_DIGESTS).map(
		([architecture, digest]) => ({
			architecture,
			reference: `${POSTGRES_IMAGE_REPOSITORY}@${digest}`,
		}),
	),
	ports: [
		{
			name: "postgres",
			containerPort: POSTGRES_PORT,
			protocol: "tcp",
			// Camp-scoped: a database reachable from the whole Yard is a lateral
			// movement path, and nothing about this profile needs it.
			exposure: "camp",
		},
	],
	probes: {
		// `pg_isready` is the only readiness signal that distinguishes "the port
		// is open" from "the cluster will answer a query". During first-boot
		// initialisation the entrypoint starts a temporary server on a unix
		// socket only, so a TCP probe would report ready while initdb is still
		// running.
		readiness: {
			kind: "exec",
			argv: [
				"pg_isready",
				"--username=postgres",
				"--dbname=postgres",
				"--quiet",
			],
			initialDelayMs: 2_000,
			periodMs: 5_000,
			timeoutMs: 3_000,
			failureThreshold: 12,
		},
		liveness: {
			kind: "tcp",
			portName: "postgres",
			initialDelayMs: 30_000,
			periodMs: 10_000,
			timeoutMs: 3_000,
			failureThreshold: 6,
		},
		// A generous startup budget: restoring WAL after an unclean shutdown can
		// take minutes, and a liveness probe that kills the server mid-recovery
		// turns a recoverable crash into a loop.
		startup: {
			kind: "exec",
			argv: [
				"pg_isready",
				"--username=postgres",
				"--dbname=postgres",
				"--quiet",
			],
			initialDelayMs: 2_000,
			periodMs: 5_000,
			timeoutMs: 3_000,
			failureThreshold: 60,
		},
	},
	persistence: {
		requirement: "required",
		volumes: [
			{
				name: POSTGRES_DATA_VOLUME,
				mountPath: POSTGRES_DATA_MOUNT_PATH,
				minimumBytes: POSTGRES_MINIMUM_VOLUME_BYTES,
				// PostgreSQL takes an exclusive lock on its data directory; two
				// servers on one directory is data corruption, not contention.
				accessMode: "single-writer",
				// Object storage cannot back PGDATA. Saying "external storage is
				// fine" here would let a deployment satisfy the persistence gate
				// with an S3 bucket that PostgreSQL cannot use.
				externalStorageAllowed: false,
			},
		],
	},
	resourceBounds: {
		cpuMillicoresMin: 500,
		memoryBytesMin: 512 * 1024 * 1024,
		ephemeralStorageBytesMin: 256 * 1024 * 1024,
	},
	configSchema: [
		{
			key: "dataVolume",
			kind: "volume-name",
			necessity: "required",
			description: `Declared volume that carries PGDATA (${POSTGRES_PGDATA}). Required: there is no safe default for durable database storage.`,
		},
		{
			key: "superuserPasswordRef",
			kind: "secret-ref",
			necessity: "required",
			description:
				"Locator for the superuser password minted inside secret custody. Projected into the container as POSTGRES_PASSWORD_FILE, never as an argv element.",
		},
		{
			key: "databaseName",
			kind: "string",
			necessity: "optional",
			description: "Initial database created on first boot (POSTGRES_DB).",
			defaultValue: "app",
		},
		{
			key: "ownerRole",
			kind: "string",
			necessity: "optional",
			description: "Superuser role name created on first boot (POSTGRES_USER).",
			defaultValue: "postgres",
		},
		{
			key: "maxConnections",
			kind: "integer",
			necessity: "optional",
			description: "max_connections for the server.",
			minimum: 10,
			maximum: 10_000,
			defaultValue: 100,
		},
		{
			key: "hostAuthMethod",
			kind: "enum",
			necessity: "optional",
			description:
				"Host authentication method written into pg_hba.conf. `trust` is deliberately not offered.",
			enumValues: ["scram-sha-256", "md5"],
			defaultValue: "scram-sha-256",
		},
	],
	producesBindingProfiles: ["binding.postgresql/v1"],
	operations: [
		{
			id: "postgres.backup.pg-dump",
			kind: "backup",
			profileRef: POSTGRES_MIGRATION_PROFILE,
			description:
				"Logical backup of one database in pg_dump custom format, written to a path the caller supplies.",
			credentialDelivery: "environment",
			shell: false,
			argvBuilderRef: "buildPgDumpArgv",
		},
		{
			id: "postgres.restore.pg-restore",
			kind: "restore",
			profileRef: POSTGRES_MIGRATION_PROFILE,
			description: "Restore a custom-format dump into a target database.",
			credentialDelivery: "environment",
			shell: false,
			argvBuilderRef: "buildPgRestoreArgv",
		},
		{
			id: "postgres.migration.pg-dump",
			kind: "migration",
			profileRef: POSTGRES_MIGRATION_PROFILE,
			description:
				"Move a database between two PostgreSQL servers as a dump/restore pair. Emitted as two argv arrays so no shell pipeline is required.",
			credentialDelivery: "environment",
			shell: false,
			argvBuilderRef: "buildPgDumpMigrationPlan",
		},
		{
			id: "postgres.maintenance.vacuum-analyze",
			kind: "maintenance",
			description: "Run VACUUM ANALYZE against a database.",
			credentialDelivery: "environment",
			shell: false,
			argvBuilderRef: "buildVacuumAnalyzeArgv",
		},
	],
	// Yard-owned from the first byte: the operator's compute ran the container,
	// so there is no provider account for ownership to be transferred out of.
	ownership: "yard-owned",
	provenance: {
		builder: "Docker Official Images (docker-library/postgres)",
		buildType: "upstream-published",
		sourceRepository: "https://github.com/docker-library/postgres",
		// The upstream build revision is not asserted: the digests were read from
		// the registry, not from a build record, and inventing a commit sha to
		// fill the field would be worse than an empty one.
		sourceRevision: "unverified",
		attestationRefs: [],
		sourceRefs: [
			{
				url: "https://hub.docker.com/_/postgres",
				checkedAt: CHECKED,
				note: `Tag ${POSTGRES_RESOLVED_FROM_TAG} resolved through the Docker Hub registry API to index ${POSTGRES_IMAGE_INDEX_DIGEST}; per-platform digests taken from that index`,
			},
			{
				url: "https://github.com/docker-library/docs/blob/master/postgres/content.md",
				checkedAt: CHECKED,
				note: "POSTGRES_PASSWORD_FILE / POSTGRES_USER_FILE / POSTGRES_DB_FILE are supported; PostgreSQL 18 images declare VOLUME /var/lib/postgresql with PGDATA=/var/lib/postgresql/18/docker",
			},
			{
				url: "https://www.postgresql.org/docs/current/app-pgdump.html",
				checkedAt: CHECKED,
				note: "pg_dump option names and PGPASSFILE/PGPASSWORD environment handling used by the argv builders",
			},
			{
				url: "https://www.postgresql.org/docs/current/protocol.html",
				checkedAt: CHECKED,
				note: "The frontend/backend protocol that data.postgres/v1 asserts",
			},
		],
	},
	conformance: {
		suiteRef: POSTGRES_CONFORMANCE_SUITE_REF,
		outcome: "pass",
		evidenceCheckedAt: CHECKED,
		// The offline lane replays recorded outcomes. Nothing in this repo has
		// started this image, so claiming container-executed evidence would be
		// the one lie that makes every other field untrustworthy.
		executedAgainstContainer: false,
	},
};

/** The digest a signer must cover for this pack's current document. */
export const POSTGRES_PACK_PAYLOAD_DIGEST = packManifestPayloadDigest(
	POSTGRES_PACK_MANIFEST_DOCUMENT,
);

/**
 * Attach an operator-supplied signature and parse.
 *
 * Parsing here rather than at module load keeps the failure attributable: a bad
 * signature block is reported when the caller supplies it, not as an import-time
 * crash inside an unrelated module.
 */
export function createPostgresPackManifest(
	signature: PackSignature,
): ParsedPackManifest {
	return parsePackManifest({ ...POSTGRES_PACK_MANIFEST_DOCUMENT, signature });
}

export { POSTGRES_SERVER_MAJOR, POSTGRES_SERVER_VERSION };
