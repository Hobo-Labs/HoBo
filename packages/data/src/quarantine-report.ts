import { create } from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	EVENTSTORE_LIMITS,
	type EventEnvelope,
	type EventPosition,
} from "@hobo/core";
import {
	type QuarantineFinding,
	QuarantineFindingSchema,
	type QuarantineReport,
	QuarantineReportSchema,
} from "./_generated/data_pb.js";
import { isJsonString } from "./json.js";
import {
	parseAggregateQuarantine,
	parseEventStoreQuarantine,
	parseProjectionQuarantine,
	quarantineSequence,
} from "./quarantine-facts.js";

export interface QuarantineReportOptions {
	readonly store: Pick<DurableEventStore, "read" | "readAll">;
	readonly tenant: string;
	readonly after?: EventPosition;
	readonly maxFindings?: number;
	readonly maxScanned?: number;
}

const REMEDIATION =
	"Investigate the fold or upcaster and choose an explicit keep-quarantined or reprocess policy.";

function positiveLimit(
	value: number | undefined,
	fallback: number,
	name: string,
) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1)
		throw new TypeError(`${name} must be a positive integer`);
	return result;
}

async function sourceEvent(
	store: QuarantineReportOptions["store"],
	streamId: string,
	seq: number,
	tenant: string,
) {
	for await (const event of store.read(streamId, seq)) {
		if (event.seq === seq && event.tenant === tenant) return event;
		break;
	}
	throw new Error("quarantine target is missing from its source stream");
}

async function toFinding(
	store: QuarantineReportOptions["store"],
	record: EventEnvelope,
): Promise<QuarantineFinding | undefined> {
	let sourceStreamId = record.streamId;
	let offendingSeq: bigint;
	let offendingEventId: string;
	let offendingType: string;
	let fold = "";
	let foldKind: "aggregate" | "projection" | "eventstore";
	let reason: string;
	if (record.type === "aggregate.QuarantineRecorded") {
		const data = parseAggregateQuarantine(record);
		const source = await sourceEvent(
			store,
			sourceStreamId,
			quarantineSequence(data.offendingSeq),
			record.tenant,
		);
		if (
			source.seq >= record.seq ||
			source.id !== data.offendingEventId ||
			source.type !== data.offendingType ||
			data.foldKind !== "aggregate"
		) {
			throw new Error(
				"aggregate quarantine target does not match its source event",
			);
		}
		offendingSeq = data.offendingSeq;
		offendingEventId = data.offendingEventId;
		offendingType = data.offendingType;
		fold = data.fold;
		foldKind = "aggregate";
		reason = data.reason;
	} else if (record.type === "projection.QuarantineRecorded") {
		const data = parseProjectionQuarantine(record);
		sourceStreamId = data.sourceStreamId;
		offendingSeq = data.offendingSeq;
		offendingEventId = data.offendingEventId;
		offendingType = data.offendingType;
		fold = data.projection;
		foldKind = "projection";
		reason = data.reason;
	} else if (record.type.endsWith(".Quarantined")) {
		const data = parseEventStoreQuarantine(record);
		const source = await sourceEvent(
			store,
			sourceStreamId,
			quarantineSequence(data.offendingSeq),
			record.tenant,
		);
		const targetId = record.meta?.quarantines;
		if (
			source.seq >= record.seq ||
			(targetId !== undefined &&
				(!isJsonString(targetId) || targetId !== source.id)) ||
			(data.offendingType && data.offendingType !== source.type)
		) {
			throw new Error(
				"event-store quarantine target does not match its source event",
			);
		}
		offendingSeq = data.offendingSeq;
		offendingEventId = source.id;
		offendingType = source.type;
		foldKind = "eventstore";
		reason = data.reason;
	} else return undefined;
	if (
		!sourceStreamId ||
		!offendingEventId ||
		!offendingType ||
		(foldKind !== "eventstore" && !fold)
	) {
		throw new TypeError("incomplete quarantine record");
	}
	const recordedTarget = record.meta?.quarantines;
	if (
		recordedTarget !== undefined &&
		(!isJsonString(recordedTarget) || recordedTarget !== offendingEventId)
	) {
		throw new Error("quarantine metadata does not match its source event");
	}
	return create(QuarantineFindingSchema, {
		sourceStreamId,
		offendingSeq,
		offendingEventId,
		offendingType,
		fold,
		foldKind,
		reason,
		recordStreamId: record.streamId,
		recordSeq: BigInt(record.seq),
		code: "event-log.poison-quarantined",
		severity: "incident",
		remediation: REMEDIATION,
	});
}

export async function readQuarantineReport(
	options: QuarantineReportOptions,
): Promise<QuarantineReport> {
	if (!options.tenant.trim()) throw new TypeError("tenant is required");
	const maxFindings = positiveLimit(options.maxFindings, 100, "maxFindings");
	const maxScanned = positiveLimit(options.maxScanned, 10_000, "maxScanned");
	const findings: QuarantineFinding[] = [];
	let cursor = options.after;
	let scanned = 0;
	let complete = false;
	while (scanned < maxScanned && findings.length < maxFindings) {
		const limit = Math.min(EVENTSTORE_LIMITS.maxReadPage, maxScanned - scanned);
		let pageSize = 0;
		for await (const item of options.store.readAll({
			tenant: options.tenant,
			limit,
			...(cursor === undefined ? undefined : { after: cursor }),
		})) {
			if (
				(cursor !== undefined && item.position <= cursor) ||
				item.event.tenant !== options.tenant
			)
				throw new Error(
					"event store returned an unexpected position or tenant",
				);
			cursor = item.position;
			pageSize += 1;
			scanned += 1;
			const finding = await toFinding(options.store, item.event);
			if (finding) findings.push(finding);
			if (findings.length >= maxFindings) break;
		}
		if (pageSize < limit && findings.length < maxFindings) {
			complete = true;
			break;
		}
	}
	if (!complete && cursor !== undefined) {
		complete = true;
		for await (const _item of options.store.readAll({
			tenant: options.tenant,
			limit: 1,
			after: cursor,
		})) {
			complete = false;
			break;
		}
	}
	return create(QuarantineReportSchema, {
		findings,
		complete,
		nextPosition: complete ? "" : (cursor?.toString() ?? ""),
	});
}
