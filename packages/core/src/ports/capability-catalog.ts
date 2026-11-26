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

export const capability = Object.freeze({
	web: Object.freeze({
		project: "web.project/v1",
		static: "web.static/v1",
		hosted: "web.hosted/v1",
		ssr: "web.ssr/v1",
	}),

	api: Object.freeze({
		http: "api.http/v1",
		rpc: "api.rpc/v1",
	}),

	service: Object.freeze({
		worker: "service.worker/v1",
		batch: "service.batch/v1",
		scheduled: "service.scheduled/v1",
		queueConsumer: "service.queue-consumer/v1",
	}),

	data: Object.freeze({
		relational: "data.relational/v1",
		postgres: "data.postgres/v1",
		mysql: "data.mysql/v1",
		sqlite: "data.sqlite/v1",
		nosql: "data.nosql/v1",
		document: "data.document/v1",
		mongodb: "data.mongodb/v1",
		graph: "data.graph/v1",
		wideColumn: "data.wide-column/v1",
		vector: "data.vector/v1",
		pgvector: "data.vector.pgvector/v1",
		convex: "data.convex/v1",
	}),

	kv: Object.freeze({
		keyValue: "kv.key-value/v1",
		redisCompatible: "kv.redis-compatible/v1",
		valkey: "kv.valkey/v1",
		durableObject: "kv.durable-object/v1",
		eventJournal: "kv.durable-object.event-journal/v1",
		durableInbox: "kv.durable-object.durable-inbox/v1",
		transactionalOutbox: "kv.durable-object.transactional-outbox/v1",
		exportableState: "kv.durable-object.exportable-state/v1",
	}),

	bucket: Object.freeze({
		object: "bucket.object/v1",
		s3Compatible: "bucket.s3-compatible/v1",
		filesystem: "bucket.filesystem/v1",
		contentAddressed: "bucket.content-addressed/v1",
		fileStorage: "bucket.file-storage/v1",
	}),

	queue: Object.freeze({
		atLeastOnce: "queue.at-least-once/v1",
		fifo: "queue.fifo/v1",
		deadLetter: "queue.dead-letter/v1",
		delay: "queue.delay/v1",
	}),

	topic: Object.freeze({
		pubsub: "topic.pubsub/v1",
		durableLog: "topic.durable-log/v1",
		consumerGroups: "topic.consumer-groups/v1",
		ephemeralPubsub: "topic.ephemeral-pubsub/v1",
	}),

	/**
	 * Referring to a secret without carrying it. Every profile here is about the
	 * *reference*; material never appears in a record.
	 */
	secretRef: Object.freeze({
		locator: "secret-ref.locator/v1",
		dynamicResolution: "secret-ref.dynamic-resolution/v1",
		runtimeProjection: "secret-ref.runtime-projection/v1",
	}),

	webhook: Object.freeze({
		inboundHttp: "webhook.inbound-http/v1",
		outboundDelivery: "webhook.outbound-delivery/v1",
		realtime: "webhook.realtime/v1",
		channel: "realtime.channel/v1",
		sse: "realtime.sse/v1",
		websocket: "realtime.websocket/v1",
	}),
	schedule: Object.freeze({
		cron: "schedule.cron/v1",
	}),
} as const);

export type ProfileForSlot<S extends CapabilitySlot> =
	(typeof capability)[S][keyof (typeof capability)[S]];

export type CapabilityProfileId = {
	[S in CapabilitySlot]: ProfileForSlot<S>;
}[CapabilitySlot];

export const CAPABILITY_PROFILE_IDS: readonly CapabilityProfileId[] =
	Object.freeze(
		Object.values(capability)
			.flatMap((group) => Object.values(group))
			.sort() as CapabilityProfileId[],
	);

export function slotForProfile(profile: string): CapabilitySlot | undefined {
	return PROFILE_TO_SLOT.get(profile);
}

const PROFILE_TO_SLOT: ReadonlyMap<string, CapabilitySlot> = new Map(
	Object.entries(capability).flatMap(([slot, group]) =>
		Object.values(group).map((profile): readonly [string, CapabilitySlot] => [
			profile,
			slot as CapabilitySlot,
		]),
	) as ReadonlyArray<readonly [string, CapabilitySlot]>,
);

export const ENV_TYPES = Object.freeze([
	"production",
	"staging",
	"ephemeral",
	"development",
] as const);

export type EnvType = (typeof ENV_TYPES)[number];

export function isEnvType(value: JsonValue | undefined): value is EnvType {
	return (
		isJsonString(value) &&
		(ENV_TYPES as readonly string[]).includes(value)
	);
}
