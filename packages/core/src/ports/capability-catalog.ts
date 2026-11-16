/**
 * The typed capability vocabulary: every capability profile an author may name,
 * keyed by the slot that holds it.
 *
 * ## Why this exists
 *
 * A capability profile id is a string with real grammar — `<family>.<path>/v<major>`
 * (ADR-0151) — and until now every authoring site spelled one by hand. That made
 * three distinct failures possible, all of them only catchable at runtime:
 *
 * 1. A typo (`"data.postgress/v1"`) reached `yard()` and refused there, or worse
 *    matched nothing and silently narrowed a Yard's catalog.
 * 2. A profile filed under the wrong slot (`slot: "kv"`, `profile: "data.postgres/v1"`)
 *    refused with `SLOT_PROFILE_MISMATCH` — a real refusal, but one the type
 *    system had every fact needed to prevent.
 * 3. A profile that no registry entry defines looked identical, at the call
 *    site, to one that does.
 *
 * Naming a profile through {@link capability} makes all three a compile error.
 * `capability.data.postgres` cannot be misspelled, and {@link ProfileForSlot}
 * makes `slot: "kv"` reject a `data.*` profile before anything runs.
 *
 * ## Sub-capabilities are the point, not a detail
 *
 * A slot is a *kind of thing* (`data`); a profile is *which kind of that thing*
 * (`data.postgres`). The second half is what portability actually turns on: an
 * app that needs Postgres wire protocol and an app that needs "any SQL database"
 * are asking different questions, and a Yard that offers D1 answers only the
 * second. That distinction lives in the refinement graph
 * (`@hobo/capability-profiles`), where `data.postgres/v1` refines
 * `data.relational/v1` — satisfying the child satisfies the parent, never the
 * reverse. This module is the typed *names*; that registry is the *meaning*.
 *
 * ## Duplication, and the guard that makes it safe
 *
 * `@hobo/core` is layer 0 and cannot import `@hobo/capability-profiles`, so this
 * list is necessarily a second copy of the ids that registry defines. That is a
 * drift risk and it is guarded rather than hoped about:
 * `packages/capability-profiles/test/catalog-drift.test.ts` asserts this
 * catalog and the standard profile registry name exactly the same ids, in both
 * directions. Adding a profile to one and not the other fails that test.
 *
 * Provider packages may register additional profiles at runtime; those are not
 * listed here, and naming one is still allowed through the untyped `profile`
 * field. This catalog types the *first-party* vocabulary, it does not close it.
 */
import { isJsonString, type JsonValue } from "../json.js";
import type { CapabilitySlot } from "./capability-slot.js";

/**
 * Every first-party capability profile, grouped by the slot that holds it.
 *
 * Keys are the sub-capability, in camelCase; values are the wire ids. Where a
 * profile's path is nested (`data.vector.pgvector/v1`) the key flattens to the
 * distinguishing leaf (`pgvector`) rather than nesting objects, because a key
 * cannot be both a string and a namespace.
 */
export const capability = Object.freeze({
	/**
	 * Serving a web surface. The refinement chain runs from most capable to
	 * least demanding — `ssr` satisfies `hosted`, which satisfies `static` — so
	 * requiring `static` asks for the weakest thing that still serves assets,
	 * and requiring `ssr` asks for per-request rendering.
	 */
	web: Object.freeze({
		/** Prebuilt immutable assets over HTTPS. No server-side rendering. */
		static: "web.static/v1",
		/** A provider-managed public origin with a stable hostname and TLS. */
		hosted: "web.hosted/v1",
		/** Dynamic per-request rendering — the "site with a backend" case. */
		ssr: "web.ssr/v1",
	}),

	/** Exposing a callable interface. */
	api: Object.freeze({
		/** Request/response over HTTP. */
		http: "api.http/v1",
		/** Typed remote procedure calls. */
		rpc: "api.rpc/v1",
	}),

	/** Running code that is not a request handler. */
	service: Object.freeze({
		/** Long-running or event-driven compute. */
		worker: "service.worker/v1",
		/** Bounded work that runs to completion. */
		batch: "service.batch/v1",
		/** Time-triggered work. */
		scheduled: "service.scheduled/v1",
		/** Work driven by a queue subscription. */
		queueConsumer: "service.queue-consumer/v1",
	}),

	/**
	 * Durable structured storage. This is the slot where sub-capability matters
	 * most: `relational` and `nosql` are umbrellas, and the concrete engines
	 * refine into them.
	 */
	data: Object.freeze({
		/** Any SQL engine: tables, DDL, transactions. */
		relational: "data.relational/v1",
		/** Actual PostgreSQL wire protocol. */
		postgres: "data.postgres/v1",
		/** MySQL/MariaDB wire protocol. */
		mysql: "data.mysql/v1",
		/** SQLite dialect and single-writer semantics. */
		sqlite: "data.sqlite/v1",
		/** Any non-relational engine: document, graph, wide-column, or vector. */
		nosql: "data.nosql/v1",
		/** Schemaless or schema-flexible document persistence. */
		document: "data.document/v1",
		/** MongoDB wire protocol and document model. */
		mongodb: "data.mongodb/v1",
		/** Vertex/edge persistence with traversal queries. */
		graph: "data.graph/v1",
		/** Row-keyed sparse columns at scale. */
		wideColumn: "data.wide-column/v1",
		/** Dense-vector persistence with nearest-neighbour search. */
		vector: "data.vector/v1",
		/** Vector search through the PostgreSQL pgvector extension. */
		pgvector: "data.vector.pgvector/v1",
		/** A Convex application backend. Not a generic store. */
		convex: "data.convex/v1",
	}),

	/** Keyed lookup. */
	kv: Object.freeze({
		/** Get/set/delete over an opaque key space. */
		keyValue: "kv.key-value/v1",
		/** The Redis command surface. */
		redisCompatible: "kv.redis-compatible/v1",
		/** Valkey, a Redis fork. */
		valkey: "kv.valkey/v1",
		/** Single-threaded addressable object with durable state. */
		durableObject: "kv.durable-object/v1",
		/** Durable object used as an append-only event journal. */
		eventJournal: "kv.durable-object.event-journal/v1",
		/** Durable object used as an idempotent inbox. */
		durableInbox: "kv.durable-object.durable-inbox/v1",
		/** Durable object used as a transactional outbox. */
		transactionalOutbox: "kv.durable-object.transactional-outbox/v1",
		/** Durable object whose state can be exported wholesale. */
		exportableState: "kv.durable-object.exportable-state/v1",
	}),

	/** Blob storage. */
	bucket: Object.freeze({
		/** Put/get/delete over an opaque object key space. */
		object: "bucket.object/v1",
		/** The S3 API surface. */
		s3Compatible: "bucket.s3-compatible/v1",
		/** Hierarchical paths with directory semantics. */
		filesystem: "bucket.filesystem/v1",
		/** Objects addressed by the hash of their content. */
		contentAddressed: "bucket.content-addressed/v1",
		/** User-facing file storage with metadata. */
		fileStorage: "bucket.file-storage/v1",
	}),

	/** Point-to-point messaging. */
	queue: Object.freeze({
		/** Delivery at least once; duplicates are possible. */
		atLeastOnce: "queue.at-least-once/v1",
		/** Strict ordering within a group, with de-duplication. */
		fifo: "queue.fifo/v1",
		/** Exhausted messages divert rather than vanish. */
		deadLetter: "queue.dead-letter/v1",
		/** Delivery deferred until a requested time. */
		delay: "queue.delay/v1",
	}),

	/** Fan-out messaging. */
	topic: Object.freeze({
		/** One publish, many subscribers. */
		pubsub: "topic.pubsub/v1",
		/** Retained, replayable, offset-addressed log. */
		durableLog: "topic.durable-log/v1",
		/** Competing consumers sharing a subscription. */
		consumerGroups: "topic.consumer-groups/v1",
		/** No retention; a subscriber that is not connected misses the message. */
		ephemeralPubsub: "topic.ephemeral-pubsub/v1",
	}),

	/**
	 * Referring to a secret without carrying it. Every profile here is about the
	 * *reference*; material never appears in a record.
	 */
	secretRef: Object.freeze({
		/** A `scheme://path` pointer resolved at use time. */
		locator: "secret-ref.locator/v1",
		/** Material minted on demand rather than stored. */
		dynamicResolution: "secret-ref.dynamic-resolution/v1",
		/** Material projected into a runtime without touching the record. */
		runtimeProjection: "secret-ref.runtime-projection/v1",
	}),

	/**
	 * Inbound and outbound event delivery. Two profile families land in this one
	 * slot — `webhook.*` and `realtime.*` — because both are "something outside
	 * pushes to, or is pushed from, the app".
	 */
	webhook: Object.freeze({
		/** Receiving an HTTP callback from a third party. */
		inboundHttp: "webhook.inbound-http/v1",
		/** Delivering an HTTP callback, with retry. */
		outboundDelivery: "webhook.outbound-delivery/v1",
		/** A persistent bidirectional channel. */
		realtime: "webhook.realtime/v1",
		/** A named channel clients subscribe to. */
		channel: "realtime.channel/v1",
		/** Server-sent events over a held HTTP response. */
		sse: "realtime.sse/v1",
		/** A WebSocket connection. */
		websocket: "realtime.websocket/v1",
	}),
} as const);

/** The profile ids a given slot may hold. */
export type ProfileForSlot<S extends CapabilitySlot> =
	(typeof capability)[S][keyof (typeof capability)[S]];

/** Any first-party capability profile id. */
export type CapabilityProfileId = {
	[S in CapabilitySlot]: ProfileForSlot<S>;
}[CapabilitySlot];

/** Every first-party profile id, sorted, for iteration and drift checks. */
export const CAPABILITY_PROFILE_IDS: readonly CapabilityProfileId[] =
	Object.freeze(
		// SAFETY: assertion required at this I/O or test boundary.
		Object.values(capability)
			.flatMap((group) => Object.values(group))
			.sort() as CapabilityProfileId[],
	);

/**
 * Which slot holds a profile, or `undefined` for one this catalog does not name.
 *
 * A provider may register profiles beyond the first-party set, so `undefined`
 * means "not first-party", never "invalid".
 */
export function slotForProfile(profile: string): CapabilitySlot | undefined {
	return PROFILE_TO_SLOT.get(profile);
}

const PROFILE_TO_SLOT: ReadonlyMap<string, CapabilitySlot> = new Map(
	// SAFETY: assertion required at this I/O or test boundary.
	Object.entries(capability).flatMap(([slot, group]) =>
		Object.values(group).map((profile): readonly [string, CapabilitySlot] => [
			profile,
			// SAFETY: assertion required at this I/O or test boundary.
			slot as CapabilitySlot,
		]),
	) as ReadonlyArray<readonly [string, CapabilitySlot]>,
);

/**
 * Environment types a Camp may declare.
 *
 * These were bare strings at every call site, which is how `"preview"` and
 * `"ephemeral"` both ended up in use for the same thing. `ephemeral` is the
 * repo's spelling; `preview` is the word humans say, so the Camp builder keeps
 * a `preview()` method that compiles to `ephemeral` rather than adding a
 * second value that means the same thing.
 */
export const ENV_TYPES = Object.freeze([
	"production",
	"staging",
	"ephemeral",
	"development",
] as const);

export type EnvType = (typeof ENV_TYPES)[number];

/** True when `value` is one of the declared environment types. */
export function isEnvType(value: JsonValue | undefined): value is EnvType {
	return (
		isJsonString(value) &&
		// SAFETY: assertion required at this I/O or test boundary.
		(ENV_TYPES as readonly string[]).includes(value)
	);
}
