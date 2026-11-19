import { create, fromJsonString } from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	EVENTSTORE_LIMITS,
	type EventPosition,
	parseEventEnvelope,
} from "@hobo/core";
import {
	CrossCampProjectionLagDataSchema,
	type ProjectionReplicaConfiguredData,
	ProjectionReplicaConfiguredDataSchema,
	ProjectionReplicaObservationSchema,
	ProjectionReplicaReportSchema,
	ProjectionReplicatedEventDataSchema,
	ProjectionReplicationCheckedDataSchema,
} from "./_generated/data_pb.js";

const CONFIGURED = "projection.ReplicaConfigured";
const REPLICATED = "projection.EventReplicated";
const CHECKED = "projection.ReplicationChecked";
const LAGGED = "projection.ReplicaLagged";
const RECOVERED = "projection.ReplicaRecovered";

export interface ProjectionReplicaReportOptions {
	readonly store: Pick<DurableEventStore, "read" | "readAll">;
	readonly tenant: string;
	readonly nowMs?: () => number;
	readonly maxConfigurations?: number;
}

function safeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new TypeError(`${field} must be a non-negative safe integer`);
	return value;
}

async function replicaObservation(
	options: ProjectionReplicaReportOptions,
	streamId: string,
) {
	let configuration: ProjectionReplicaConfiguredData | undefined;
	let sequence = 0;
	let sourcePosition = 0n;
	let checkedAtMs: number | undefined;
	let pending = false;
	let recoveryPending = false;
	let lagged = false;
	for await (const event of options.store.read(streamId)) {
		if (
			event.streamId !== streamId ||
			event.seq !== sequence + 1 ||
			event.tenant !== options.tenant
		)
			throw new Error(
				`replica stream ${streamId} has an invalid sequence or tenant`,
			);
		if (recoveryPending && event.type !== RECOVERED)
			throw new Error(`replica stream ${streamId} is missing a recovery event`);
		sequence = event.seq;
		if (event.type === CONFIGURED) {
			const next = fromJsonString(
				ProjectionReplicaConfiguredDataSchema,
				JSON.stringify(event.data),
			);
			safeInteger(Number(next.boundMs), "boundMs");
			if (
				pending ||
				!next.projection.trim() ||
				!next.ownerCampId.trim() ||
				!next.replicaCampId.trim() ||
				(next.readClass !== "bounded-staleness" &&
					next.readClass !== "eventual") ||
				next.ownerCampId === next.replicaCampId ||
				(configuration !== undefined &&
					(next.projection !== configuration.projection ||
						next.ownerCampId !== configuration.ownerCampId ||
						next.replicaCampId !== configuration.replicaCampId ||
						next.sourceStreamId !== configuration.sourceStreamId))
			)
				throw new Error(
					`replica stream ${streamId} has an invalid configuration`,
				);
			configuration = next;
			continue;
		}
		if (!configuration)
			throw new Error(`replica stream ${streamId} has no configuration`);
		if (event.type === REPLICATED) {
			const data = fromJsonString(
				ProjectionReplicatedEventDataSchema,
				JSON.stringify(event.data),
			);
			const source = parseEventEnvelope(JSON.parse(data.eventJson));
			if (
				data.sourcePosition <= sourcePosition ||
				source.tenant !== options.tenant ||
				(configuration.sourceStreamId &&
					source.streamId !== configuration.sourceStreamId)
			)
				throw new Error(
					`replica stream ${streamId} has an invalid source event`,
				);
			sourcePosition = data.sourcePosition;
			pending = true;
		} else if (event.type === CHECKED) {
			const data = fromJsonString(
				ProjectionReplicationCheckedDataSchema,
				JSON.stringify(event.data),
			);
			const checked = safeInteger(Number(data.checkedAtMs), "checkedAtMs");
			if (
				data.sourceStreamId !== configuration.sourceStreamId ||
				data.sourcePosition !== sourcePosition ||
				(checkedAtMs !== undefined && checked < checkedAtMs)
			)
				throw new Error(`replica stream ${streamId} has an invalid checkpoint`);
			if (data.caughtUp) {
				checkedAtMs = checked;
				recoveryPending = lagged;
			}
			pending = false;
		} else if (event.type === LAGGED || event.type === RECOVERED) {
			const data = fromJsonString(
				CrossCampProjectionLagDataSchema,
				JSON.stringify(event.data),
			);
			if (
				pending ||
				data.projection !== configuration.projection ||
				data.ownerCampId !== configuration.ownerCampId ||
				data.replicaCampId !== configuration.replicaCampId ||
				lagged === (event.type === LAGGED)
			)
				throw new Error(
					`replica stream ${streamId} has an invalid lag transition`,
				);
			lagged = event.type === LAGGED;
			recoveryPending = false;
		} else
			throw new Error(
				`replica stream ${streamId} contains unexpected event ${event.type}`,
			);
	}
	if (!configuration || pending || recoveryPending)
		throw new Error(`replica stream ${streamId} is incomplete`);
	const now = safeInteger((options.nowMs ?? Date.now)(), "nowMs");
	if (checkedAtMs !== undefined && now < checkedAtMs)
		throw new Error(`replica stream ${streamId} clock moved backward`);
	const observedLagMs =
		checkedAtMs === undefined ? undefined : now - checkedAtMs;
	const stalenessStatus =
		observedLagMs === undefined
			? "unknown"
			: observedLagMs > Number(configuration.boundMs)
				? "exceeds-bound"
				: "within-bound";
	return create(ProjectionReplicaObservationSchema, {
		projection: configuration.projection,
		ownerCampId: configuration.ownerCampId,
		replicaCampId: configuration.replicaCampId,
		replicaStreamId: streamId,
		sourceStreamId: configuration.sourceStreamId,
		sourcePosition,
		boundMs: configuration.boundMs,
		stalenessStatus,
		...(checkedAtMs === undefined
			? undefined
			: { checkedAtMs: BigInt(checkedAtMs) }),
		...(observedLagMs === undefined
			? undefined
			: { observedLagMs: BigInt(observedLagMs) }),
		lagSignalActive: lagged,
		missingLagSignal: stalenessStatus === "exceeds-bound" && !lagged,
		defaultReadClass: configuration.readClass,
		supportedReads: [
			{ source: "owner", readClass: "session" },
			{ source: "replica", readClass: "bounded-staleness" },
			{ source: "replica", readClass: "eventual" },
		],
	});
}

export async function readProjectionReplicaReport(
	options: ProjectionReplicaReportOptions,
) {
	if (!options.tenant.trim()) throw new TypeError("tenant is required");
	const maximum = safeInteger(
		options.maxConfigurations ?? 100_000,
		"maxConfigurations",
	);
	if (maximum === 0) throw new TypeError("maxConfigurations must be positive");
	const streams = new Set<string>();
	let after: EventPosition | undefined;
	let scanned = 0;
	for (;;) {
		const limit = Math.min(
			EVENTSTORE_LIMITS.maxReadPage,
			maximum - scanned + 1,
		);
		let count = 0;
		for await (const item of options.store.readAll({
			tenant: options.tenant,
			filter: { type: CONFIGURED },
			limit,
			...(after === undefined ? undefined : { after }),
		})) {
			if (
				(after !== undefined && item.position <= after) ||
				item.event.tenant !== options.tenant ||
				item.event.type !== CONFIGURED
			)
				throw new Error(
					"event store returned an unexpected replica configuration",
				);
			after = item.position;
			count += 1;
			scanned += 1;
			if (scanned > maximum)
				throw new Error("projection configuration scan limit exceeded");
			streams.add(item.event.streamId);
		}
		if (count < limit) break;
	}
	const replicas = [];
	for (const streamId of [...streams].sort())
		replicas.push(await replicaObservation(options, streamId));
	return create(ProjectionReplicaReportSchema, { replicas });
}
