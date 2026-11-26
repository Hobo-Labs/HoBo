/**
 * `pack.valkey.oci/v1` — the manifest document.
 *
 * The document ships **unsigned**; `createValkeyPackManifest` attaches a signature
 * an operator's release pipeline produced. This repo holds no signing key, so a
 * baked-in signature would either be fake or imply a key exists.
 *
 * Two things about this manifest are unusual and deliberate:
 *
 * 1. `durabilityMode`, `evictionPolicy`, and `maxmemoryBytes` are **required**
 *    configuration with no defaults. A Redis-compatible server is a durable
 *    keyspace or a lossy cache depending on those three settings, and a pack that
 *    picked them silently would be choosing the operator's data-loss budget for
 *    them.
 * 2. The profile claims stop at `kv.*`. Valkey ships lists, streams, and pub/sub,
 *    and none of those make it a queue or a topic — those primitives have their
 *    own profiles, their own conformance, and their own delivery guarantees.
 */
import {
	type PackManifestInput,
	type PackSignature,
	type ParsedPackManifest,
	packManifestPayloadDigest,
	parsePackManifest,
} from "@hobo/pack-framework";

import {
	VALKEY_DATA_MOUNT_PATH,
	VALKEY_IMAGE_DIGESTS,
	VALKEY_IMAGE_INDEX_DIGEST,
	VALKEY_IMAGE_REPOSITORY,
	VALKEY_PORT,
	VALKEY_RESOLVED_FROM_TAG,
	VALKEY_SERVER_MAJOR,
	VALKEY_SERVER_VERSION,
} from "./image.js";
import {
	VALKEY_DURABILITY_MODES,
	VALKEY_EVICTION_POLICIES,
} from "./semantics.js";

// public-contract: stable identifier for Valkey OCI pack selection.
export const VALKEY_PACK_ID = "pack.valkey.oci/v1" as const;
// public-contract: serialized pack version.
export const VALKEY_PACK_VERSION = "1.0.0" as const;

/** Live keyspace handoff, used when ownership moves between Yards. */
// public-contract: migration profile advertised by this pack.
export const VALKEY_MIGRATION_PROFILE =
	"migration.valkey.replica-handoff/v1" as const;

// public-contract: conformance evidence expected from this pack.
export const VALKEY_CONFORMANCE_SUITE_REF =
	"hobo.conformance/pack.valkey.oci/v1" as const;

const CHECKED = "2026-08-08";

// public-contract: stable logical volume name in pack manifests.
export const VALKEY_DATA_VOLUME = "valkey-data" as const;

/**
 * A deliberately small floor. Unlike a relational cluster, an empty Valkey
 * keyspace occupies almost nothing on disk; 256 MiB is enough for an AOF plus a
 * rewrite of a modest keyspace, and a larger number here would be a guess.
 */
const VALKEY_MINIMUM_VOLUME_BYTES = 256 * 1024 * 1024;

export const VALKEY_PACK_MANIFEST_DOCUMENT: Omit<
	PackManifestInput,
	"signature"
> = {
	schemaVersion: "hobo.pack-manifest/v1",
	packId: VALKEY_PACK_ID,
	packVersion: VALKEY_PACK_VERSION,
	displayName: `Valkey ${VALKEY_SERVER_VERSION} (OCI pack)`,
	description:
		"Upstream Valkey run as a container on compute the operator already owns. Satisfies kv.redis-compatible/v1 and kv.valkey/v1 with persistence, eviction, and durability stated per deployment rather than assumed.",
	runtimeModels: ["oci", "vm_iaas", "paas"],
	implementsProfiles: [
		{
			profileId: "kv.redis-compatible/v1",
			versionRange: ">=1",
			conformanceRef: `${VALKEY_CONFORMANCE_SUITE_REF}#kv.redis-compatible@${CHECKED}`,
			conformance: "pass",
		},
		{
			// Declared explicitly as well as by refinement, so a requirement for
			// kv.valkey/v1 matches without the registry's refinement graph.
			profileId: "kv.valkey/v1",
			versionRange: ">=1",
			conformanceRef: `${VALKEY_CONFORMANCE_SUITE_REF}#kv.valkey@${CHECKED}`,
			conformance: "pass",
		},
		// There is no queue.* or topic.* claim here, and that omission is the
		// point. Valkey's LPUSH/BRPOP look like a queue and its streams look like
		// a log, but neither carries the redelivery, visibility-timeout, or
		// consumer-group guarantees those profiles assert, and this pack has no
		// conformance evidence for them. See test/selection.test.ts, which pins
		// the rejection.
	],
	images: Object.entries(VALKEY_IMAGE_DIGESTS).map(
		([architecture, digest]) => ({
			architecture,
			reference: `${VALKEY_IMAGE_REPOSITORY}@${digest}`,
		}),
	),
	ports: [
		{
			name: "valkey",
			containerPort: VALKEY_PORT,
			protocol: "tcp",
			// Camp-scoped. An unauthenticated-by-default protocol on a
			// Yard-visible port is how a cache becomes someone else's shell.
			exposure: "camp",
		},
	],
	probes: {
		// `valkey-cli ping` proves the server will answer a command, which a TCP
		// connect does not: during an AOF load the port is open and every command
		// is refused with LOADING.
		readiness: {
			kind: "exec",
			argv: ["valkey-cli", "ping"],
			initialDelayMs: 1_000,
			periodMs: 5_000,
			timeoutMs: 3_000,
			failureThreshold: 12,
		},
		liveness: {
			kind: "tcp",
			portName: "valkey",
			initialDelayMs: 10_000,
			periodMs: 10_000,
			timeoutMs: 3_000,
			failureThreshold: 6,
		},
		// Loading a large AOF or RDB takes as long as it takes; a liveness probe
		// that kills the server mid-load turns a slow start into a crash loop.
		startup: {
			kind: "exec",
			argv: ["valkey-cli", "ping"],
			initialDelayMs: 1_000,
			periodMs: 5_000,
			timeoutMs: 3_000,
			failureThreshold: 120,
		},
	},
	persistence: {
		requirement: "required",
		volumes: [
			{
				name: VALKEY_DATA_VOLUME,
				mountPath: VALKEY_DATA_MOUNT_PATH,
				minimumBytes: VALKEY_MINIMUM_VOLUME_BYTES,
				// One server owns its data directory; a second process writing
				// the same AOF is corruption.
				accessMode: "single-writer",
				// An RDB or AOF is written with ordinary file semantics, so
				// object storage cannot back it.
				externalStorageAllowed: false,
			},
		],
	},
	resourceBounds: {
		// An in-memory store is bounded by memory, not by CPU: a single-threaded
		// command loop rarely needs a whole core, and `maxmemoryBytes` is what
		// the operator actually has to size.
		cpuMillicoresMin: 250,
		memoryBytesMin: 128 * 1024 * 1024,
		ephemeralStorageBytesMin: 64 * 1024 * 1024,
	},
	configSchema: [
		{
			key: "dataVolume",
			kind: "volume-name",
			necessity: "required",
			description: `Declared volume mounted at ${VALKEY_DATA_MOUNT_PATH}. Required in every durability mode: the pinned image declares no VOLUME of its own, so an unmounted server writes its snapshot into a container layer that disappears with the container.`,
		},
		{
			key: "authPasswordRef",
			kind: "secret-ref",
			necessity: "required",
			description:
				"Locator for the requirepass credential minted inside secret custody. Projected as an included config file, never as argv and never as an environment variable.",
		},
		{
			key: "durabilityMode",
			kind: "enum",
			necessity: "required",
			description:
				"How the keyspace reaches the volume, and therefore what a crash costs: none (cache; a restart starts empty), rdb-snapshots (up to 60s of writes lost), aof-everysec (about 1s), aof-always (no acknowledged write lost, at the volume's fsync latency). Required with no default, because this is the operator's data-loss budget rather than the pack's.",
			enumValues: [...VALKEY_DURABILITY_MODES],
		},
		{
			key: "evictionPolicy",
			kind: "enum",
			necessity: "required",
			description:
				"What happens at maxmemory. noeviction refuses writes with an error; allkeys-* may discard a key that has no TTL; volatile-* only discards keys that carry one. Required with no default, because the difference between 'a write fails' and 'a key silently vanishes' is a decision, not a preference.",
			enumValues: [...VALKEY_EVICTION_POLICIES],
		},
		{
			key: "maxmemoryBytes",
			kind: "integer",
			necessity: "required",
			description:
				"maxmemory for the server. Required: a server with no limit is killed by the host's OOM killer instead of applying the eviction policy the operator chose.",
			minimum: 8 * 1024 * 1024,
			maximum: 1024 * 1024 * 1024 * 1024,
		},
		{
			key: "databases",
			kind: "integer",
			necessity: "optional",
			description: "Number of logical databases (SELECT index space).",
			minimum: 1,
			maximum: 256,
			defaultValue: 16,
		},
	],
	producesBindingProfiles: ["binding.redis-protocol/v1"],
	operations: [
		{
			id: "valkey.backup.rdb-dump",
			kind: "backup",
			profileRef: VALKEY_MIGRATION_PROFILE,
			description:
				"Ask the server for a fresh RDB over the protocol and write it to a path the caller supplies. Works in every durability mode, including cache mode, because the snapshot is produced on demand rather than read off the volume.",
			credentialDelivery: "environment",
			shell: false,
			argvBuilderRef: "buildValkeyRdbBackupArgv",
		},
		{
			id: "valkey.migration.replica-handoff",
			kind: "migration",
			profileRef: VALKEY_MIGRATION_PROFILE,
			description:
				"Move a live keyspace between servers: make the target a replica, wait for the initial sync, then promote it. Emitted as separate argv arrays so the wait is a real step with an observable outcome instead of a sleep inside a shell pipeline.",
			credentialDelivery: "environment",
			shell: false,
			argvBuilderRef: "buildValkeyReplicaHandoffPlan",
		},
		{
			id: "valkey.maintenance.rewrite-aof",
			kind: "maintenance",
			description:
				"Compact the append-only file. Meaningful only in an aof-* durability mode; the builder refuses it otherwise rather than issuing a command the server will ignore.",
			credentialDelivery: "environment",
			shell: false,
			argvBuilderRef: "buildValkeyRewriteAofArgv",
		},
	],
	// Yard-owned: the operator's own compute ran the container, so there is no
	// provider account for ownership to be transferred out of. Moving a Valkey
	// instance between Yards is a Yard-to-Yard transfer using the replica-handoff
	// operation above, not a claim against a vendor.
	ownership: "yard-owned",
	provenance: {
		builder: "Valkey project official image (valkey-io/valkey-container)",
		buildType: "upstream-published",
		sourceRepository: "https://github.com/valkey-io/valkey-container",
		// Not asserted: the digests came from the registry, not from a build
		// record, and inventing a commit sha to fill this field would be worse
		// than leaving it visibly unknown.
		sourceRevision: "unverified",
		attestationRefs: [],
		sourceRefs: [
			{
				url: "https://hub.docker.com/r/valkey/valkey",
				checkedAt: CHECKED,
				note: `Tag ${VALKEY_RESOLVED_FROM_TAG} resolved through the Docker Hub registry API to index ${VALKEY_IMAGE_INDEX_DIGEST}; per-platform digests taken from that index`,
			},
			{
				url: "https://valkey.io/topics/persistence/",
				checkedAt: CHECKED,
				note: "RDB snapshot and AOF appendfsync semantics the durability modes describe",
			},
			{
				url: "https://valkey.io/topics/lru-cache/",
				checkedAt: CHECKED,
				note: "maxmemory-policy behaviour the eviction table describes",
			},
			{
				url: "https://valkey.io/topics/replication/",
				checkedAt: CHECKED,
				note: "REPLICAOF / WAIT semantics the replica-handoff migration uses",
			},
		],
	},
	conformance: {
		suiteRef: VALKEY_CONFORMANCE_SUITE_REF,
		outcome: "pass",
		evidenceCheckedAt: CHECKED,
		// Nothing in this repo has started this image. The offline lane replays
		// recorded outcomes, and claiming container-executed evidence would make
		// every other field in this manifest untrustworthy.
		executedAgainstContainer: false,
	},
};

/** The digest a signer must cover for this pack's current document. */
export const VALKEY_PACK_PAYLOAD_DIGEST = packManifestPayloadDigest(
	VALKEY_PACK_MANIFEST_DOCUMENT,
);

export function createValkeyPackManifest(
	signature: PackSignature,
): ParsedPackManifest {
	return parsePackManifest({ ...VALKEY_PACK_MANIFEST_DOCUMENT, signature });
}

export { VALKEY_SERVER_MAJOR, VALKEY_SERVER_VERSION };
