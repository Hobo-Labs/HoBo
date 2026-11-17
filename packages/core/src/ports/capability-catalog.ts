import { isJsonString, type JsonValue } from "../json.js";
import type { CapabilitySlot } from "./capability-slot.js";

export const capability = Object.freeze({
	web: Object.freeze({
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
		isJsonString(value) && (ENV_TYPES as readonly string[]).includes(value)
	);
}
