/**
 * The first-party capability profile catalog.
 *
 * These are data, not code paths: a provider package registers additional
 * profiles through {@link createCapabilityProfileRegistry} without editing this
 * file. Every profile cites the source that justifies its semantics.
 */
import type {
	CapabilityProfileDescriptor,
	EvidenceSourceRef,
} from "./descriptor.js";

const CHECKED = "2026-08-08";

const hoboSource = (path: string, note: string): EvidenceSourceRef => ({
	url: `https://github.com/Tyler-R-Kendrick/HoBo/blob/main/${path}`,
	checkedAt: CHECKED,
	note,
});

type ProfileSeed = {
	id: string;
	primitive: CapabilityProfileDescriptor["primitive"];
	displayName: string;
	description: string;
	refines?: readonly string[];
	requires?: readonly string[];
	conflictsWith?: readonly string[];
	features?: CapabilityProfileDescriptor["features"];
	guarantees?: CapabilityProfileDescriptor["guarantees"];
	maturity?: CapabilityProfileDescriptor["maturity"];
	sourceRefs?: readonly EvidenceSourceRef[];
};

function profile(seed: ProfileSeed): CapabilityProfileDescriptor {
	const slug = seed.id.replace(/[./]/gu, "-");
	return {
		schemaVersion: "hobo.capability-profile/v1",
		id: seed.id,
		primitive: seed.primitive,
		displayName: seed.displayName,
		description: seed.description,
		refines: seed.refines ?? [],
		...(seed.requires !== undefined ? { requires: seed.requires } : undefined),
		...(seed.conflictsWith !== undefined
			? { conflictsWith: seed.conflictsWith }
			: undefined),
		requirementSchemaRef: `hobo.capability-requirement/${slug}`,
		conformanceSuiteRef: `conformance.${seed.id}`,
		features: seed.features ?? [],
		guarantees: seed.guarantees ?? [],
		maturity: seed.maturity ?? "stable",
		sourceRefs: seed.sourceRefs ?? [
			hoboSource(
				"docs/design/adr/07-portability-extensibility.md",
				"HoBo-owned semantics; no external product defines this profile",
			),
		],
	};
}

const bool = (key: string, description: string) =>
	({ key, description, valueKind: "boolean" }) as const;
const integer = (key: string, description: string) =>
	({ key, description, valueKind: "integer" }) as const;

/** web */
const WEB: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "web.static/v1",
		primitive: "web",
		displayName: "Static site",
		description:
			"Prebuilt immutable assets served over HTTPS. No server-side rendering.",
		features: [
			integer("maxFileCount", "Maximum number of deployable files."),
			integer("maxFileBytes", "Maximum size of any single file."),
			bool("spaFallback", "Serves index.html for unmatched routes."),
			bool("immutableCaching", "Supports content-hashed immutable caching."),
			bool("customRedirects", "Supports declarative redirects."),
			bool("customHeaders", "Supports declarative response headers."),
		],
		guarantees: [bool("httpsOnly", "Assets are only served over TLS.")],
	}),
	profile({
		id: "web.hosted/v1",
		primitive: "web",
		displayName: "Hosted web surface",
		description:
			"A provider-managed public web origin with a stable hostname and TLS.",
		refines: ["web.static/v1"],
		features: [bool("customDomain", "Supports attaching a custom domain.")],
	}),
	profile({
		id: "web.ssr/v1",
		primitive: "web",
		displayName: "Server-rendered web",
		description: "Dynamic per-request rendering at the web edge or origin.",
		refines: ["web.hosted/v1"],
		features: [bool("streamingResponse", "Supports streamed HTML responses.")],
	}),
];

/** api */
const API: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "api.http/v1",
		primitive: "api",
		displayName: "HTTP API",
		description: "A backend HTTP request/response surface.",
		features: [
			integer("maxBodyBytes", "Maximum inbound request body size."),
			integer("timeoutMs", "Maximum request wall-clock duration."),
			bool("streaming", "Supports streamed responses."),
			bool("websocketUpgrade", "Supports upgrading a request to WebSocket."),
			bool("egress", "Workload may make outbound network calls."),
		],
	}),
	profile({
		id: "api.rpc/v1",
		primitive: "api",
		displayName: "RPC API",
		description:
			"A typed remote-procedure surface over HTTP or another transport.",
		refines: ["api.http/v1"],
	}),
];

/** service */
const SERVICE: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "service.worker/v1",
		primitive: "service",
		displayName: "Background worker",
		description:
			"Long-lived or invoked background compute with no public route.",
	}),
	profile({
		id: "service.batch/v1",
		primitive: "service",
		displayName: "Batch job",
		description: "Bounded run-to-completion compute.",
		refines: ["service.worker/v1"],
	}),
	profile({
		id: "service.scheduled/v1",
		primitive: "service",
		displayName: "Scheduled work",
		description:
			"Time-triggered execution. Never inferred from the ability to run a worker — it requires explicit product evidence and conformance.",
		refines: ["service.worker/v1"],
		features: [bool("cronExpressions", "Accepts cron-syntax schedules.")],
	}),
	profile({
		id: "service.queue-consumer/v1",
		primitive: "service",
		displayName: "Queue consumer",
		description: "Compute driven by delivery from a queue primitive.",
		refines: ["service.worker/v1"],
		features: [
			integer("maxBatchSize", "Maximum messages delivered per invocation."),
		],
	}),
];

/** data */
const DATA: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "data.relational/v1",
		primitive: "data",
		displayName: "Relational database",
		description:
			"SQL tables, schema/DDL, and transactions. Satisfied by SQLite-class, D1, MySQL, or PostgreSQL implementations.",
		features: [
			bool("jsonDocuments", "Stores and queries JSON document columns."),
			bool("preparedStatements", "Supports server-side prepared statements."),
			integer("maxStorageBytes", "Maximum stored bytes."),
		],
		guarantees: [
			bool("transactions", "Multi-statement transactions with rollback."),
			bool("constraints", "Enforces declared constraints and indexes."),
		],
	}),
	profile({
		id: "data.postgres/v1",
		primitive: "data",
		displayName: "PostgreSQL",
		description:
			"Actual PostgreSQL wire protocol and behaviour. Cloudflare D1 satisfies data.relational/v1 but never this profile.",
		refines: ["data.relational/v1"],
		features: [
			{
				key: "serverVersion",
				description: "PostgreSQL server major version.",
				valueKind: "semver-range",
			},
			{
				key: "extensions",
				description: "Installable PostgreSQL extensions.",
				valueKind: "string-set",
			},
			integer("maxConnections", "Maximum concurrent client connections."),
			bool("pooling", "Provider offers a pooled connection endpoint."),
		],
		guarantees: [
			bool(
				"postgresWireProtocol",
				"Speaks the PostgreSQL frontend/backend protocol.",
			),
			bool("tls", "Requires TLS on the client connection."),
		],
		sourceRefs: [
			{
				url: "https://www.postgresql.org/docs/current/protocol.html",
				checkedAt: CHECKED,
				note: "PostgreSQL frontend/backend protocol is the normative behaviour this profile asserts",
			},
		],
	}),
	profile({
		id: "data.mysql/v1",
		primitive: "data",
		displayName: "MySQL",
		description: "MySQL/MariaDB wire protocol and behaviour.",
		refines: ["data.relational/v1"],
		guarantees: [
			bool("mysqlWireProtocol", "Speaks the MySQL client protocol."),
		],
		sourceRefs: [
			{
				url: "https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html",
				checkedAt: CHECKED,
			},
		],
	}),
	profile({
		id: "data.sqlite/v1",
		primitive: "data",
		displayName: "SQLite-compatible",
		description: "SQLite dialect and single-writer semantics.",
		refines: ["data.relational/v1"],
		guarantees: [bool("sqliteDialect", "Accepts the SQLite SQL dialect.")],
		sourceRefs: [
			{ url: "https://www.sqlite.org/lang.html", checkedAt: CHECKED },
		],
	}),
	profile({
		id: "data.nosql/v1",
		primitive: "data",
		displayName: "Non-relational store",
		description:
			"Durable structured storage that is not a SQL engine. The umbrella every non-relational engine refines into, so an app that needs *a* non-relational store — and genuinely does not care which — can say so without naming one. It asserts nothing beyond persistence and keyed retrieval: no joins, no cross-entity transactions, no schema enforcement. An app that needs any of those wants data.relational/v1 instead.",
		features: [bool("secondaryIndexes", "Supports secondary indexes.")],
		guarantees: [
			bool("durableWrites", "An acknowledged write survives a restart."),
		],
	}),
	profile({
		id: "data.document/v1",
		primitive: "data",
		displayName: "Document store",
		description: "Schemaless or schema-flexible document persistence.",
		refines: ["data.nosql/v1"],
		features: [bool("secondaryIndexes", "Supports secondary indexes.")],
	}),
	profile({
		id: "data.mongodb/v1",
		primitive: "data",
		displayName: "MongoDB",
		description:
			"The MongoDB wire protocol and document model: BSON documents addressed by `_id`, the CRUD and aggregation command surface, and — on a replica set — multi-document transactions and change streams. The engine-level node `@hobo/data-mongodb` implements (ADR-0177). A document store that merely looks similar does not satisfy it.",
		refines: ["data.document/v1"],
		features: [
			bool(
				"changeStreams",
				"Change streams are available (requires a replica set or sharded cluster).",
			),
			bool(
				"multiDocumentTransactions",
				"Multi-document ACID transactions are available.",
			),
		],
		guarantees: [
			bool(
				"mongodbWireProtocol",
				"Speaks the MongoDB wire protocol to unmodified drivers.",
			),
		],
		sourceRefs: [
			{
				url: "https://www.mongodb.com/docs/manual/changeStreams/",
				checkedAt: CHECKED,
			},
		],
	}),
	profile({
		id: "data.graph/v1",
		primitive: "data",
		displayName: "Graph store",
		description: "Vertex/edge persistence with traversal queries.",
		refines: ["data.nosql/v1"],
	}),
	profile({
		id: "data.wide-column/v1",
		primitive: "data",
		displayName: "Wide-column store",
		description:
			"Row-keyed sparse columns at scale: a partition key selects a row, columns within it are addressed individually, and the column set varies per row. DynamoDB, Bigtable and Cassandra-class engines.",
		refines: ["data.nosql/v1"],
		features: [
			bool("secondaryIndexes", "Supports secondary indexes."),
			bool("rangeQueries", "Supports ordered range scans within a partition."),
		],
	}),
	profile({
		id: "data.vector/v1",
		primitive: "data",
		displayName: "Vector store",
		description:
			"Dense-vector persistence with approximate nearest-neighbour search.",
		refines: ["data.nosql/v1"],
		features: [
			integer("maxDimensions", "Maximum supported vector dimensionality."),
		],
	}),
	profile({
		id: "data.vector.pgvector/v1",
		primitive: "data",
		displayName: "pgvector",
		description:
			"Vector search through the PostgreSQL pgvector extension. Requires an actual PostgreSQL implementation.",
		refines: ["data.vector/v1"],
		requires: ["data.postgres/v1"],
		sourceRefs: [
			{ url: "https://github.com/pgvector/pgvector", checkedAt: CHECKED },
		],
	}),
	profile({
		id: "data.convex/v1",
		primitive: "data",
		displayName: "Convex backend",
		description:
			"A Convex application backend: documents, HTTP actions, realtime WebSockets, scheduled work, and file storage over the Convex protocol. Not a generic SQL or document store.",
		refines: ["data.document/v1"],
		maturity: "preview",
		sourceRefs: [
			{ url: "https://docs.convex.dev/self-hosting", checkedAt: CHECKED },
		],
	}),
];

/** kv */
const KV: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "kv.key-value/v1",
		primitive: "kv",
		displayName: "Key/value store",
		description: "Opaque key to opaque value storage with optional TTL.",
		features: [
			bool("ttl", "Supports per-key expiry."),
			integer("maxValueBytes", "Maximum stored value size."),
		],
	}),
	profile({
		id: "kv.redis-compatible/v1",
		primitive: "kv",
		displayName: "Redis-compatible store",
		description:
			"Redis command semantics. Availability of lists, streams, or pub/sub here never implies the queue or topic primitives — those need their own profiles and conformance.",
		refines: ["kv.key-value/v1"],
		features: [
			bool("atomicIncrement", "Supports atomic INCR/DECR."),
			bool("sortedSets", "Supports sorted-set commands."),
			bool("restTransport", "Exposes an HTTP/REST command transport."),
		],
		guarantees: [
			bool("redisCommandSemantics", "Implements Redis command semantics."),
		],
		sourceRefs: [
			{ url: "https://redis.io/docs/latest/commands/", checkedAt: CHECKED },
		],
	}),
	profile({
		id: "kv.valkey/v1",
		primitive: "kv",
		displayName: "Valkey",
		description: "Valkey server semantics.",
		refines: ["kv.redis-compatible/v1"],
		sourceRefs: [{ url: "https://valkey.io/", checkedAt: CHECKED }],
	}),
	profile({
		id: "kv.durable-object/v1",
		primitive: "kv",
		displayName: "Single-writer durable object",
		description:
			"Per-key single-threaded stateful object with transactional local storage.",
		refines: ["kv.key-value/v1"],
		guarantees: [
			bool("singleWriter", "One active writer per object identity."),
		],
	}),
	profile({
		id: "kv.durable-object.event-journal/v1",
		primitive: "kv",
		displayName: "Durable object event journal",
		description:
			"Append-only actor-local fact stream with expected-revision CAS inside one transaction.",
		refines: ["kv.durable-object/v1"],
		guarantees: [
			bool("appendOnlyFacts", "Facts are immutable after commit."),
			bool(
				"expectedRevisionCas",
				"Append compares expected revision atomically.",
			),
		],
		sourceRefs: [
			hoboSource(
				"docs/design/adr/03-data-plane-sqlite-default.md",
				"Actor-local journal mirrors ADR-0135 stream-head CAS; not a global EventStore",
			),
		],
	}),
	profile({
		id: "kv.durable-object.durable-inbox/v1",
		primitive: "kv",
		displayName: "Durable object command inbox",
		description:
			"Accepted commands persist before acknowledgement and survive receive-loss of an engine mailbox.",
		refines: ["kv.durable-object.event-journal/v1"],
		guarantees: [
			bool(
				"acceptedCommandDurable",
				"A successful accept implies an inbox row that wake/restart can recover.",
			),
		],
		sourceRefs: [
			{
				url: "https://rivet.dev/docs/actors/queues/",
				checkedAt: "2026-08-13",
				note: "Rivet removes queue messages on receive; HoBo inbox is the authority",
			},
		],
	}),
	profile({
		id: "kv.durable-object.transactional-outbox/v1",
		primitive: "kv",
		displayName: "Durable object transactional outbox",
		description:
			"Effects stage in the same actor-local transaction as facts; dispatch runs after commit.",
		refines: ["kv.durable-object.event-journal/v1"],
		guarantees: [
			bool(
				"effectsStagedWithFacts",
				"Outbox rows commit atomically with the facts that decided them.",
			),
		],
	}),
	profile({
		id: "kv.durable-object.exportable-state/v1",
		primitive: "kv",
		displayName: "Exportable durable object state",
		description:
			"Logical export/import of journal, inbox, outbox, and timers for Trails. Not a physical SQLite copy.",
		refines: ["kv.durable-object.event-journal/v1"],
		guarantees: [
			bool(
				"logicalExport",
				"Export is a content-addressed logical record independent of engine files.",
			),
		],
	}),
];

/** bucket */
const BUCKET: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "bucket.object/v1",
		primitive: "bucket",
		displayName: "Object storage",
		description: "Key-addressed blob storage.",
		features: [integer("maxObjectBytes", "Maximum single-object size.")],
	}),
	profile({
		id: "bucket.s3-compatible/v1",
		primitive: "bucket",
		displayName: "S3-compatible storage",
		description: "S3 API compatibility including presigned URLs.",
		refines: ["bucket.object/v1"],
		guarantees: [bool("s3Api", "Implements the S3 REST API surface.")],
	}),
	profile({
		id: "bucket.filesystem/v1",
		primitive: "bucket",
		displayName: "Filesystem storage",
		description: "POSIX-like path-addressed persistent storage.",
		refines: ["bucket.object/v1"],
	}),
	profile({
		id: "bucket.content-addressed/v1",
		primitive: "bucket",
		displayName: "Content-addressed storage",
		description: "Digest-addressed immutable storage.",
		refines: ["bucket.object/v1"],
		guarantees: [
			bool("immutable", "Stored content cannot be mutated in place."),
		],
	}),
	profile({
		id: "bucket.file-storage/v1",
		primitive: "bucket",
		displayName: "Application file storage",
		description:
			"Application-scoped file storage managed by a backend product.",
		refines: ["bucket.object/v1"],
	}),
];

/** queue */
const QUEUE: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "queue.at-least-once/v1",
		primitive: "queue",
		displayName: "At-least-once queue",
		description: "Work queue with at-least-once delivery.",
		guarantees: [
			bool("atLeastOnce", "Each message is delivered at least once."),
		],
	}),
	profile({
		id: "queue.fifo/v1",
		primitive: "queue",
		displayName: "FIFO queue",
		description: "Ordered delivery within a partition or group key.",
		refines: ["queue.at-least-once/v1"],
		guarantees: [bool("orderedWithinGroup", "Preserves per-group ordering.")],
	}),
	profile({
		id: "queue.delay/v1",
		primitive: "queue",
		displayName: "Delayed delivery queue",
		description: "Per-message visibility delay.",
		refines: ["queue.at-least-once/v1"],
	}),
	profile({
		id: "queue.dead-letter/v1",
		primitive: "queue",
		displayName: "Dead-letter queue",
		description: "Automatic diversion of repeatedly failed messages.",
		refines: ["queue.at-least-once/v1"],
	}),
];

/** topic */
const TOPIC: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "topic.pubsub/v1",
		primitive: "topic",
		displayName: "Publish/subscribe topic",
		description: "Fan-out delivery to current subscribers.",
	}),
	profile({
		id: "topic.ephemeral-pubsub/v1",
		primitive: "topic",
		displayName: "Ephemeral publish/subscribe",
		description:
			"Fan-out with no retention. Redis pub/sub sits here, and it is not a durable log.",
		refines: ["topic.pubsub/v1"],
	}),
	profile({
		id: "topic.durable-log/v1",
		primitive: "topic",
		displayName: "Durable log topic",
		description: "Retained, offset-addressed append-only log.",
		refines: ["topic.pubsub/v1"],
		guarantees: [
			bool("retention", "Messages are retained for a declared window."),
		],
	}),
	profile({
		id: "topic.consumer-groups/v1",
		primitive: "topic",
		displayName: "Consumer groups",
		description: "Coordinated partitioned consumption with tracked offsets.",
		refines: ["topic.durable-log/v1"],
	}),
];

/** secretRef */
const SECRET_REF: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "secret-ref.locator/v1",
		primitive: "secretRef",
		displayName: "Secret locator",
		description:
			"An opaque reference to secret authority. Describes reference behaviour only — never a plaintext secret store.",
	}),
	profile({
		id: "secret-ref.runtime-projection/v1",
		primitive: "secretRef",
		displayName: "Runtime secret projection",
		description:
			"Projection of a referenced secret into an authorized workload at runtime.",
		refines: ["secret-ref.locator/v1"],
	}),
	profile({
		id: "secret-ref.dynamic-resolution/v1",
		primitive: "secretRef",
		displayName: "Dynamic secret resolution",
		description:
			"Short-lived credentials minted per workload identity on demand.",
		refines: ["secret-ref.runtime-projection/v1"],
		guarantees: [
			bool(
				"rotationWithoutRedeploy",
				"Value rotates without changing the reference.",
			),
		],
	}),
];

/** webhook + realtime */
const WEBHOOK: readonly CapabilityProfileDescriptor[] = [
	profile({
		id: "webhook.inbound-http/v1",
		primitive: "webhook",
		displayName: "Inbound webhook",
		description: "A public endpoint that accepts third-party HTTP callbacks.",
		features: [integer("maxBodyBytes", "Maximum accepted callback body size.")],
	}),
	profile({
		id: "webhook.outbound-delivery/v1",
		primitive: "webhook",
		displayName: "Outbound webhook delivery",
		description: "Retrying delivery of events to subscriber endpoints.",
	}),
	profile({
		id: "webhook.realtime/v1",
		primitive: "webhook",
		displayName: "Realtime channel",
		description: "Persistent bidirectional or server-push delivery to clients.",
	}),
	profile({
		id: "realtime.websocket/v1",
		primitive: "webhook",
		displayName: "WebSocket",
		description:
			"RFC 6455 WebSocket upgrade, framing, and reconnect behaviour.",
		refines: ["webhook.realtime/v1"],
		guarantees: [
			bool("bidirectional", "Client and server may both initiate frames."),
		],
		sourceRefs: [
			{ url: "https://www.rfc-editor.org/rfc/rfc6455", checkedAt: CHECKED },
		],
	}),
	profile({
		id: "realtime.sse/v1",
		primitive: "webhook",
		displayName: "Server-sent events",
		description: "Unidirectional server push over an HTTP stream.",
		refines: ["webhook.realtime/v1"],
	}),
	profile({
		id: "realtime.channel/v1",
		primitive: "webhook",
		displayName: "Named realtime channel",
		description: "Topic-scoped realtime fan-out to subscribed clients.",
		refines: ["webhook.realtime/v1"],
	}),
];

export const STANDARD_CAPABILITY_PROFILES: readonly CapabilityProfileDescriptor[] =
	[
		...WEB,
		...API,
		...SERVICE,
		...DATA,
		...KV,
		...BUCKET,
		...QUEUE,
		...TOPIC,
		...SECRET_REF,
		...WEBHOOK,
	];
