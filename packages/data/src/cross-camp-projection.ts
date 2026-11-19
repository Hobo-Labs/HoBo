import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import {
	canonicalJson,
	EVENTSTORE_LIMITS,
	type AppendOptions,
	type AppendResult,
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventStore,
	parseEventEnvelope,
	parseEventPosition,
	type PrincipalRef,
	type ReadAllOptions,
} from "@hobo/core";
import {
	CrossCampProjectionLagDataSchema,
	ProjectionReplicaConfiguredDataSchema,
	ProjectionReplicatedEventDataSchema,
	ProjectionReplicationCheckedDataSchema,
} from "./_generated/data_pb.js";
import { isOptimisticConflict } from "./errors.js";
import type { Projection, ProjectionSnapshot } from "./projection.js";

const REPLICATED = "projection.EventReplicated";
const CHECKED = "projection.ReplicationChecked";
const CONFIGURED = "projection.ReplicaConfigured";
const LAGGED = "projection.ReplicaLagged";
const RECOVERED = "projection.ReplicaRecovered";

export interface CrossCampProjectionOptions<Row> {
	readonly projection: Projection<Row>;
	readonly owner: DurableEventStore;
	readonly ownerCampId: string;
	readonly replica: EventStore;
	readonly replicaCampId: string;
	readonly sourceStreamId?: string;
	readonly replicaStreamId: string;
	readonly tenant: string;
	readonly actor: PrincipalRef;
	readonly maxStalenessMs: number;
	readonly replicaReadClass?: "bounded-staleness" | "eventual";
	readonly nowMs: () => number;
	readonly maxBatchEvents?: number;
}

export type ProjectionReadEvidence =
	| Readonly<{ source: "owner"; readClass: "session" }>
	| Readonly<{
			source: "replica";
			readClass: "bounded-staleness" | "eventual";
	  }>;

export interface CrossCampProjectionView<Row> {
	readonly snapshot: ProjectionSnapshot<Row>;
	readonly sourcePosition: string;
	readonly evidence: Extract<ProjectionReadEvidence, { source: "replica" }>;
	readonly staleness: {
		readonly status: "unknown" | "within-bound" | "exceeds-bound";
		readonly boundMs: number;
		readonly checkedAtMs: number | null;
		readonly observedLagMs: number | null;
		readonly ownerCampId: string;
		readonly replicaCampId: string;
	};
}

export interface CrossCampReplicationResult<Row> {
	readonly copied: number;
	readonly caughtUp: boolean;
	readonly view: CrossCampProjectionView<Row>;
}

export interface CrossCampProjectionSubscription {
	readonly ready: Promise<void>;
	drain(): Promise<void>;
	unsubscribe(): void;
}

interface ReplicaState {
	readonly replicaSeq: number;
	readonly events: Array<{ position: bigint; event: EventEnvelope }>;
	readonly checkedAtMs: number | null;
	readonly lagged: boolean;
	readonly boundMs: number | null;
	readonly readClass: "bounded-staleness" | "eventual" | null;
}

export function createCrossCampProjection<Row>(
	options: CrossCampProjectionOptions<Row>,
) {
	for (const [name, value] of [
		["projection name", options.projection.name],
		["ownerCampId", options.ownerCampId],
		["replicaCampId", options.replicaCampId],
		["replicaStreamId", options.replicaStreamId],
		["tenant", options.tenant],
	] as const) {
		if (!value.trim()) throw new TypeError(`${name} must not be empty`);
	}
	if (options.sourceStreamId !== undefined && !options.sourceStreamId.trim())
		throw new TypeError("sourceStreamId must not be empty");
	if (options.ownerCampId === options.replicaCampId)
		throw new TypeError("owner and replica camps must differ");
	if (options.owner === options.replica)
		throw new TypeError("owner and replica stores must differ");
	integer(options.maxStalenessMs, "maxStalenessMs");
	const replicaReadClass = options.replicaReadClass ?? "bounded-staleness";
	if (
		replicaReadClass !== "bounded-staleness" &&
		replicaReadClass !== "eventual"
	)
		throw new TypeError("unsupported replica read class");
	const maxBatchEvents =
		options.maxBatchEvents ?? EVENTSTORE_LIMITS.maxBatchEvents - 2;
	if (
		!Number.isSafeInteger(maxBatchEvents) ||
		maxBatchEvents < 1 ||
		maxBatchEvents > EVENTSTORE_LIMITS.maxBatchEvents - 2
	)
		throw new TypeError("maxBatchEvents exceeds the event-store batch limit");

	function readSource(after: bigint, limit: number) {
		const readOptions: ReadAllOptions = {
			after: parseEventPosition(after),
			limit,
			tenant: options.tenant,
		};
		if (options.sourceStreamId !== undefined)
			return options.owner.readAll({
				...readOptions,
				filter: { streamId: options.sourceStreamId },
			});
		return options.owner.readAll(readOptions);
	}

	function sourceEvent(input: EventEnvelope): EventEnvelope {
		const event = parseEventEnvelope(input);
		if (
			event.tenant !== options.tenant ||
			(options.sourceStreamId !== undefined &&
				event.streamId !== options.sourceStreamId)
		)
			throw new Error("source returned an event outside the projection source");
		return event;
	}

	async function loadReplica(): Promise<ReplicaState> {
		const events: Array<{ position: bigint; event: EventEnvelope }> = [];
		let replicaSeq = 0;
		let checkedAtMs: number | null = null;
		let lagged = false;
		let boundMs: number | null = null;
		let readClass: "bounded-staleness" | "eventual" | null = null;
		let pending = false;
		let recoveryPending = false;
		for await (const record of options.replica.read(options.replicaStreamId)) {
			if (record.seq !== replicaSeq + 1)
				throw new Error("replica stream has a sequence gap");
			if (record.tenant !== options.tenant)
				throw new Error("replica stream has an unexpected tenant");
			if (recoveryPending && record.type !== RECOVERED)
				throw new Error("replica checkpoint is missing its recovery event");
			replicaSeq = record.seq;
			if (record.type === CONFIGURED) {
				const data = fromJsonString(
					ProjectionReplicaConfiguredDataSchema,
					JSON.stringify(record.data),
				);
				if (
					pending ||
					data.projection !== options.projection.name ||
					data.ownerCampId !== options.ownerCampId ||
					data.replicaCampId !== options.replicaCampId ||
					data.sourceStreamId !== (options.sourceStreamId ?? "") ||
					(data.readClass !== "bounded-staleness" &&
						data.readClass !== "eventual")
				)
					throw new Error("replica contains an invalid configuration");
				boundMs = safeNumber(data.boundMs, "boundMs");
				readClass = data.readClass;
			} else if (record.type === REPLICATED) {
				if (boundMs === null)
					throw new Error("replica configuration is missing");
				const data = fromJsonString(
					ProjectionReplicatedEventDataSchema,
					JSON.stringify(record.data),
				);
				const event = parseEventEnvelope(JSON.parse(data.eventJson));
				if (
					(options.sourceStreamId !== undefined &&
						event.streamId !== options.sourceStreamId) ||
					event.tenant !== options.tenant ||
					data.sourcePosition <= (events.at(-1)?.position ?? 0n)
				)
					throw new Error(
						"replica contains an invalid source position or event",
					);
				events.push({ position: data.sourcePosition, event });
				pending = true;
			} else if (record.type === CHECKED) {
				if (boundMs === null)
					throw new Error("replica configuration is missing");
				const data = fromJsonString(
					ProjectionReplicationCheckedDataSchema,
					JSON.stringify(record.data),
				);
				const checked = safeNumber(data.checkedAtMs, "checkedAtMs");
				if (
					data.sourceStreamId !== (options.sourceStreamId ?? "") ||
					data.sourcePosition !== (events.at(-1)?.position ?? 0n)
				)
					throw new Error(
						"replica checkpoint does not match its source events",
					);
				if (checkedAtMs !== null && checked < checkedAtMs)
					throw new Error("replica checkpoint clock moved backward");
				if (data.caughtUp) {
					checkedAtMs = checked;
					recoveryPending = lagged;
				}
				pending = false;
			} else if (record.type === LAGGED || record.type === RECOVERED) {
				if (boundMs === null)
					throw new Error("replica configuration is missing");
				const data = fromJsonString(
					CrossCampProjectionLagDataSchema,
					JSON.stringify(record.data),
				);
				if (
					pending ||
					data.projection !== options.projection.name ||
					data.ownerCampId !== options.ownerCampId ||
					data.replicaCampId !== options.replicaCampId ||
					lagged === (record.type === LAGGED)
				)
					throw new Error("replica contains an invalid lag transition");
				lagged = record.type === LAGGED;
				recoveryPending = false;
			} else {
				throw new Error(`unexpected replica event ${record.type}`);
			}
		}
		if (pending || recoveryPending)
			throw new Error("replica contains an incomplete batch");
		return { replicaSeq, events, checkedAtMs, lagged, boundMs, readClass };
	}

	async function configure(state: ReplicaState): Promise<boolean> {
		if (
			state.boundMs === options.maxStalenessMs &&
			state.readClass === replicaReadClass
		)
			return true;
		try {
			await options.replica.append(
				options.replicaStreamId,
				[
					{
						type: CONFIGURED,
						data: toJson(
							ProjectionReplicaConfiguredDataSchema,
							create(ProjectionReplicaConfiguredDataSchema, {
								projection: options.projection.name,
								ownerCampId: options.ownerCampId,
								replicaCampId: options.replicaCampId,
								sourceStreamId: options.sourceStreamId ?? "",
								boundMs: BigInt(options.maxStalenessMs),
								readClass: replicaReadClass,
							}),
							{ alwaysEmitImplicit: true },
						),
					},
				],
				{
					expectedSeq: state.replicaSeq,
					actor: options.actor,
					tenant: options.tenant,
				},
			);
		} catch (error) {
			if (!(error instanceof Error) || !isOptimisticConflict(error))
				throw error;
		}
		return false;
	}

	function lagEvent(
		lagged: boolean,
		sourcePosition: bigint,
		observedLagMs: number,
	): EventInput {
		return {
			type: lagged ? LAGGED : RECOVERED,
			data: toJson(
				CrossCampProjectionLagDataSchema,
				create(CrossCampProjectionLagDataSchema, {
					projection: options.projection.name,
					ownerCampId: options.ownerCampId,
					replicaCampId: options.replicaCampId,
					sourcePosition,
					boundMs: BigInt(options.maxStalenessMs),
					observedLagMs: BigInt(observedLagMs),
				}),
				{ alwaysEmitImplicit: true },
			),
		};
	}

	async function view(
		initial: ReplicaState,
		readClass: "bounded-staleness" | "eventual" = replicaReadClass,
	): Promise<CrossCampProjectionView<Row>> {
		let state = initial;
		for (let attempt = 0; attempt < 8; attempt += 1) {
			if (!(await configure(state))) {
				state = await loadReplica();
				continue;
			}
			const now = integer(options.nowMs(), "nowMs");
			const checked = state.checkedAtMs;
			if (checked !== null && now < checked)
				throw new Error("replica clock moved backward");
			const observedLagMs = checked === null ? null : now - checked;
			const status =
				observedLagMs === null
					? "unknown"
					: observedLagMs > options.maxStalenessMs
						? "exceeds-bound"
						: "within-bound";
			const lagged = status === "exceeds-bound";
			if (observedLagMs !== null && lagged !== state.lagged) {
				const event = lagEvent(
					lagged,
					state.events.at(-1)?.position ?? 0n,
					observedLagMs,
				);
				try {
					await options.replica.append(options.replicaStreamId, [event], {
						expectedSeq: state.replicaSeq,
						actor: options.actor,
						tenant: options.tenant,
					});
				} catch (error) {
					if (!(error instanceof Error) || !isOptimisticConflict(error))
						throw error;
					state = await loadReplica();
					continue;
				}
			}
			return {
				snapshot: options.projection.fold(
					state.events.map(({ event }) => event),
				),
				sourcePosition: String(state.events.at(-1)?.position ?? 0n),
				evidence: { source: "replica", readClass },
				staleness: {
					status,
					boundMs: options.maxStalenessMs,
					checkedAtMs: checked,
					observedLagMs,
					ownerCampId: options.ownerCampId,
					replicaCampId: options.replicaCampId,
				},
			};
		}
		throw new Error("replica remained busy while recording lag state");
	}

	async function replicate(): Promise<CrossCampReplicationResult<Row>> {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const state = await loadReplica();
			if (!(await configure(state))) continue;
			const checkedAtMs = integer(options.nowMs(), "nowMs");
			if (state.checkedAtMs !== null && checkedAtMs < state.checkedAtMs)
				throw new Error("replica clock moved backward");
			const last = state.events.at(-1);
			const events: Array<{ position: bigint; event: EventEnvelope }> = [];
			let matchedLast = last === undefined;
			let caughtUp = true;
			for await (const raw of readSource(
				last ? last.position - 1n : 0n,
				maxBatchEvents + (last ? 2 : 1),
			)) {
				const event = sourceEvent(raw.event);
				if (!matchedLast) {
					if (
						raw.position !== last?.position ||
						canonicalJson(JSON.parse(JSON.stringify(event))) !==
							canonicalJson(JSON.parse(JSON.stringify(last?.event)))
					)
						throw new Error("source stream no longer matches the replica");
					matchedLast = true;
					continue;
				}
				if (raw.position <= (events.at(-1)?.position ?? last?.position ?? 0n))
					throw new Error("source positions are not increasing");
				if (events.length === maxBatchEvents) {
					caughtUp = false;
					break;
				}
				events.push({ position: raw.position, event });
			}
			if (!matchedLast)
				throw new Error("source stream no longer matches the replica");
			const records: EventInput[] = events.map(({ position, event }) => ({
				type: REPLICATED,
				data: toJson(
					ProjectionReplicatedEventDataSchema,
					create(ProjectionReplicatedEventDataSchema, {
						eventJson: JSON.stringify(event),
						sourcePosition: position,
					}),
				),
			}));
			records.push({
				type: CHECKED,
				data: toJson(
					ProjectionReplicationCheckedDataSchema,
					create(ProjectionReplicationCheckedDataSchema, {
						sourceStreamId: options.sourceStreamId ?? "",
						sourcePosition: events.at(-1)?.position ?? last?.position ?? 0n,
						checkedAtMs: BigInt(checkedAtMs),
						caughtUp,
					}),
					{ alwaysEmitImplicit: true },
				),
			});
			if (caughtUp && state.lagged)
				records.push(
					lagEvent(false, events.at(-1)?.position ?? last?.position ?? 0n, 0),
				);
			try {
				await options.replica.append(options.replicaStreamId, records, {
					expectedSeq: state.replicaSeq,
					actor: options.actor,
					tenant: options.tenant,
				});
			} catch (error) {
				if (error instanceof Error && isOptimisticConflict(error)) continue;
				throw error;
			}
			return {
				copied: events.length,
				caughtUp,
				view: await view({
					replicaSeq: state.replicaSeq + records.length,
					events: [...state.events, ...events],
					checkedAtMs: caughtUp ? checkedAtMs : state.checkedAtMs,
					lagged: caughtUp ? false : state.lagged,
					boundMs: state.boundMs,
					readClass: state.readClass,
				}),
			};
		}
		throw new Error(
			"replica remained busy after concurrent replication retries",
		);
	}

	async function ownerSnapshot(
		write?: EventEnvelope,
	): Promise<ProjectionSnapshot<Row>> {
		const required = write === undefined ? undefined : sourceEvent(write);
		const events: EventEnvelope[] = [];
		let observed = required === undefined;
		let position = 0n;
		let count: number;
		do {
			count = 0;
			for await (const record of readSource(
				position,
				EVENTSTORE_LIMITS.maxReadPage,
			)) {
				if (record.position <= position)
					throw new Error("source positions are not increasing");
				position = record.position;
				const event = sourceEvent(record.event);
				if (
					required &&
					event.id === required.id &&
					event.streamId === required.streamId &&
					event.seq === required.seq
				)
					observed = true;
				events.push(event);
				count += 1;
			}
		} while (count === EVENTSTORE_LIMITS.maxReadPage);
		if (!observed)
			throw new Error("owner read did not observe the required session write");
		return options.projection.fold(events);
	}

	return Object.freeze({
		replicate,
		async read(
			readClass: "bounded-staleness" | "eventual" = replicaReadClass,
		): Promise<CrossCampProjectionView<Row>> {
			if (readClass !== "bounded-staleness" && readClass !== "eventual")
				throw new TypeError("unsupported replica read class");
			return view(await loadReplica(), readClass);
		},
		readOwner: () => ownerSnapshot(),
		async readSession(write: EventEnvelope) {
			const evidence = {
				source: "owner",
				readClass: "session",
			} satisfies ProjectionReadEvidence;
			return { snapshot: await ownerSnapshot(write), evidence };
		},
		async append(
			campId: string,
			streamId: string,
			events: EventInput[],
			append: AppendOptions,
		): Promise<AppendResult> {
			if (campId !== options.ownerCampId && campId !== options.replicaCampId)
				throw new Error(`unknown camp ${campId}`);
			if (
				options.sourceStreamId !== undefined &&
				streamId !== options.sourceStreamId
			)
				throw new Error("stream is outside the projection source");
			if (append.tenant !== options.tenant)
				throw new Error("tenant does not match the projection source");
			return options.owner.append(streamId, events, append);
		},
		subscribe(
			handler: (result: CrossCampProjectionView<Row>) => void | Promise<void>,
		): CrossCampProjectionSubscription {
			let tail = Promise.resolve();
			let failure: unknown;
			const subscription = options.replica.subscribe(
				{ streamId: options.replicaStreamId, type: CHECKED },
				() => {
					tail = tail.then(async () => {
						if (failure !== undefined) return;
						try {
							await handler(await view(await loadReplica()));
						} catch (error) {
							failure = error;
						}
					});
				},
			);
			return {
				ready: subscription.ready ?? Promise.resolve(),
				async drain() {
					await subscription.ready;
					await tail;
					if (failure !== undefined) throw failure;
				},
				unsubscribe() {
					subscription.unsubscribe();
				},
			};
		},
	});
}

function integer(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new TypeError(`${field} must be a non-negative safe integer`);
	return value;
}

function safeNumber(value: bigint, field: string): number {
	return integer(Number(value), field);
}
