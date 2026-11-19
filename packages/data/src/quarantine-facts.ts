import { create, fromJsonString } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	type AggregateQuarantinedEventData,
	AggregateQuarantinedEventDataSchema,
	type EventStoreQuarantinedEventData,
	EventStoreQuarantinedEventDataSchema,
	type ProjectionQuarantinedEventData,
	ProjectionQuarantinedEventDataSchema,
	QuarantineReprocessFindingSchema,
} from "./_generated/data_pb.js";

export function quarantineReprocessFinding(
	event: EventEnvelope,
	fold: string,
	foldKind: "aggregate" | "projection",
) {
	return create(QuarantineReprocessFindingSchema, {
		code: "event-log.quarantine-reprocess-policy-required",
		sourceStreamId: event.streamId,
		offendingSeq: BigInt(event.seq),
		offendingEventId: event.id,
		fold,
		foldKind,
	});
}

export function quarantineSequence(value: bigint): number {
	const sequence = Number(value);
	if (!Number.isSafeInteger(sequence) || sequence < 1) {
		throw new TypeError("invalid quarantine target sequence");
	}
	return sequence;
}

export function parseAggregateQuarantine(
	event: EventEnvelope,
): AggregateQuarantinedEventData {
	const data = fromJsonString(
		AggregateQuarantinedEventDataSchema,
		JSON.stringify(event.data),
	);
	quarantineSequence(data.offendingSeq);
	if (
		!data.offendingType ||
		!data.offendingEventId ||
		!data.fold ||
		data.foldKind !== "aggregate"
	) {
		throw new TypeError("invalid aggregate quarantine record");
	}
	if (
		event.meta?.quarantines !== undefined &&
		event.meta.quarantines !== data.offendingEventId
	) {
		throw new TypeError("quarantine metadata does not match its source event");
	}
	return data;
}

export function parseProjectionQuarantine(
	event: EventEnvelope,
): ProjectionQuarantinedEventData {
	const data = fromJsonString(
		ProjectionQuarantinedEventDataSchema,
		JSON.stringify(event.data),
	);
	quarantineSequence(data.offendingSeq);
	if (
		!data.projection ||
		!data.sourceStreamId ||
		!data.offendingType ||
		!data.offendingEventId
	) {
		throw new TypeError("invalid projection quarantine record");
	}
	if (
		event.meta?.quarantines !== undefined &&
		event.meta.quarantines !== data.offendingEventId
	) {
		throw new TypeError("quarantine metadata does not match its source event");
	}
	return data;
}

export function parseEventStoreQuarantine(
	event: EventEnvelope,
): EventStoreQuarantinedEventData {
	const data = fromJsonString(
		EventStoreQuarantinedEventDataSchema,
		JSON.stringify(event.data),
		{ ignoreUnknownFields: true },
	);
	quarantineSequence(data.offendingSeq);
	return data;
}
