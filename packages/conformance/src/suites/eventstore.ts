import type {
	AppendOptions,
	EventEnvelope,
	EventInput,
	EventStore,
	FoldHandlers,
} from "@hobo/core";
import { isJsonObject, type JsonValue } from "../json.js";

export const CAMP_EVENTSTORE_RUNTIME_PORT_CONTRACT_VERSION =
	"hobo.camp-eventstore-runtime-port/v1";

export type EventStoreConformanceAssertion =
	| "seqConditionalAppend"
	| "idempotencyKeyDedup"
	| "idempotencyCollisionScopedPerStream"
	| "poisonEventQuarantine"
	| "orderedReplayAfterReopen"
	| "dedupSurvivesReopen"
	| "replayEqualsLive"
	| "crashMidAppendAtomicity";

export type AssertionStatus = "pass" | "fail";

export interface EventStoreConformanceReport {
	readonly contract: typeof CAMP_EVENTSTORE_RUNTIME_PORT_CONTRACT_VERSION;
	readonly backend: string;
	readonly assertions: Readonly<
		Record<EventStoreConformanceAssertion, AssertionStatus>
	>;
}

export interface RuntimeLocalEventStoreFactoryOptions {
	dataDir?: string;
	clock?: { now(): string; advance?(ms: number): string };
}

export interface RuntimeLocalEventStoreLike extends EventStore {
	close(): void;
	fold<S>(
		streamId: string,
		opts: { initialState: S; handlers: FoldHandlers<S> },
	): Promise<{
		streamId: string;
		seq: number;
		state: S;
		quarantined: JsonValue[];
	}>;
}

export type CreateRuntimeLocalEventStore = (
	options?: RuntimeLocalEventStoreFactoryOptions,
) => RuntimeLocalEventStoreLike;

export async function runEventStoreConformance(
	createStore: CreateRuntimeLocalEventStore,
	options: {
		backend?: string;
		dataDirFactory?: () => string;
		removeDataDir?: (dir: string) => void;
		crashProbe?: (
			createStore: CreateRuntimeLocalEventStore,
			dataDir: string,
		) => Promise<boolean>;
	} = {},
): Promise<EventStoreConformanceReport> {
	if (!(createStore instanceof Function)) {
		throw new TypeError("createStore must be a function");
	}

	const backend = options.backend ?? "runtime-local";
	const assertions = {
		seqConditionalAppend: (await provesSeqConditionalAppend(createStore))
			? "pass"
			: "fail",
		idempotencyKeyDedup: (await provesIdempotencyKeyDedup(createStore))
			? "pass"
			: "fail",
		poisonEventQuarantine: (await provesPoisonEventQuarantine(createStore))
			? "pass"
			: "fail",
		idempotencyCollisionScopedPerStream: (await provesIdempotencyCollisionScope(
			createStore,
		))
			? "pass"
			: "fail",
		orderedReplayAfterReopen: (await provesOrderedReplayAfterReopen(
			createStore,
			options,
		))
			? "pass"
			: "fail",
		dedupSurvivesReopen: (await provesDedupSurvivesReopen(createStore, options))
			? "pass"
			: "fail",
		replayEqualsLive: (await provesReplayEqualsLive(createStore))
			? "pass"
			: "fail",
		crashMidAppendAtomicity: options.crashProbe
			? (await provesCrashMidAppendAtomicity(createStore, options))
				? "pass"
				: "fail"
			: "fail",
	} as const;

	return Object.freeze({
		contract: CAMP_EVENTSTORE_RUNTIME_PORT_CONTRACT_VERSION,
		backend,
		assertions: Object.freeze(assertions),
	});
}

async function provesSeqConditionalAppend(
	createStore: CreateRuntimeLocalEventStore,
): Promise<boolean> {
	const store = createStore();
	try {
		await store.append(
			"conformance:seq",
			[{ type: "seq.Started", data: {} }],
			conformanceOptions(0),
		);
		try {
			await store.append(
				"conformance:seq",
				[{ type: "seq.Raced", data: {} }],
				conformanceOptions(0),
			);
			return false;
		} catch {
			const events = await collect(store, "conformance:seq");
			return events.length === 1;
		}
	} finally {
		store.close();
	}
}

async function provesIdempotencyKeyDedup(
	createStore: CreateRuntimeLocalEventStore,
): Promise<boolean> {
	const store = createStore();
	try {
		const event: EventInput = {
			type: "payment.Captured",
			data: { amount: 10 },
			meta: { idempotencyKey: "capture-1" },
		};
		await store.append("conformance:dedup", [event], conformanceOptions(0));
		const retry = await store.append(
			"conformance:dedup",
			[event],
			conformanceOptions(0),
		);
		const events = await collect(store, "conformance:dedup");
		return (
			retry.appended.length === 0 &&
			retry.deduped.length === 1 &&
			events.length === 1
		);
	} finally {
		store.close();
	}
}

async function provesPoisonEventQuarantine(
	createStore: CreateRuntimeLocalEventStore,
): Promise<boolean> {
	const store = createStore();
	try {
		await store.append(
			"conformance:poison",
			[
				{ type: "ticket.Opened", data: {} },
				{ type: "ticket.Commented", data: {} },
			],
			conformanceOptions(0),
		);
		const folded = await store.fold("conformance:poison", {
			initialState: { comments: 0 },
			handlers: {
				"ticket.Opened": () => {
					throw new Error("missing title");
				},
				"ticket.Commented": (state) => ({ comments: state.comments + 1 }),
			},
		});
		const events = await collect(store, "conformance:poison");
		return (
			folded.state.comments === 1 &&
			folded.quarantined.length === 1 &&
			events.length === 3
		);
	} finally {
		store.close();
	}
}

async function provesIdempotencyCollisionScope(
	createStore: CreateRuntimeLocalEventStore,
): Promise<boolean> {
	const store = createStore();
	try {
		const event: EventInput = {
			type: "email.Sent",
			data: { to: "user@example.test" },
			meta: { idempotencyKey: "send-1" },
		};
		await store.append("conformance:stream-a", [event], conformanceOptions(0));
		await store.append("conformance:stream-b", [event], conformanceOptions(0));
		return (
			(await collect(store, "conformance:stream-a")).length === 1 &&
			(await collect(store, "conformance:stream-b")).length === 1
		);
	} finally {
		store.close();
	}
}

async function provesOrderedReplayAfterReopen(
	createStore: CreateRuntimeLocalEventStore,
	options: {
		dataDirFactory?: () => string;
		removeDataDir?: (dir: string) => void;
	},
): Promise<boolean> {
	const dataDir =
		options.dataDirFactory?.() ?? `conformance-reopen-${Date.now()}`;
	const remove = options.removeDataDir ?? (() => undefined);
	try {
		const first = createStore({ dataDir });
		await first.append(
			"conformance:stream-1",
			[{ type: "order.Created", data: { n: 1 } }],
			conformanceOptions(0),
		);
		await first.append(
			"conformance:stream-2",
			[{ type: "order.Created", data: { n: 2 } }],
			conformanceOptions(0),
		);
		first.close();

		const reopened = createStore({ dataDir });
		try {
			const stream1 = await collect(reopened, "conformance:stream-1");
			const stream2 = await collect(reopened, "conformance:stream-2");
			return (
				isContiguous(stream1) &&
				isContiguous(stream2) &&
				isJsonObject(stream1[0]?.data) &&
				stream1[0]?.data !== null &&
				// SAFETY: assertion to `stream1[0].data as { n?: number }` is required at this boundary.
				(stream1[0].data as { n?: number }).n === 1 &&
				isJsonObject(stream2[0]?.data) &&
				stream2[0]?.data !== null &&
				// SAFETY: assertion to `stream2[0].data as { n?: number }` is required at this boundary.
				(stream2[0].data as { n?: number }).n === 2
			);
		} finally {
			reopened.close();
		}
	} finally {
		remove(dataDir);
	}
}

async function provesDedupSurvivesReopen(
	createStore: CreateRuntimeLocalEventStore,
	options: {
		dataDirFactory?: () => string;
		removeDataDir?: (dir: string) => void;
	},
): Promise<boolean> {
	const dataDir =
		options.dataDirFactory?.() ?? `conformance-dedup-${Date.now()}`;
	const remove = options.removeDataDir ?? (() => undefined);
	try {
		const event: EventInput = {
			type: "payment.Captured",
			data: { amount: 42 },
			meta: { idempotencyKey: "persisted-key" },
		};
		const first = createStore({ dataDir });
		await first.append("conformance:persist", [event], conformanceOptions(0));
		first.close();

		const reopened = createStore({ dataDir });
		try {
			const retry = await reopened.append(
				"conformance:persist",
				[event],
				conformanceOptions(0),
			);
			return retry.appended.length === 0 && retry.deduped.length === 1;
		} finally {
			reopened.close();
		}
	} finally {
		remove(dataDir);
	}
}

async function provesReplayEqualsLive(
	createStore: CreateRuntimeLocalEventStore,
): Promise<boolean> {
	const store = createStore();
	try {
		await store.append(
			"conformance:fold",
			[
				{ type: "cart.ItemAdded", data: { sku: "a" } },
				{ type: "cart.ItemAdded", data: { sku: "b" } },
			],
			conformanceOptions(0),
		);
		const live = await store.fold("conformance:fold", {
			// SAFETY: assertion to `[] as string[]` is required at this boundary.
			initialState: { items: [] as string[] },
			handlers: {
				"cart.ItemAdded": (state, event) => ({
					items: [
						...state.items,
						// SAFETY: assertion to `event.data as { sku?: string }` is required at this boundary.
						String((event.data as { sku?: string }).sku ?? ""),
					],
				}),
			},
		});
		const replay = await store.fold("conformance:fold", {
			// SAFETY: assertion to `[] as string[]` is required at this boundary.
			initialState: { items: [] as string[] },
			handlers: {
				"cart.ItemAdded": (state, event) => ({
					items: [
						...state.items,
						// SAFETY: assertion to `event.data as { sku?: string }` is required at this boundary.
						String((event.data as { sku?: string }).sku ?? ""),
					],
				}),
			},
		});
		return (
			JSON.stringify(live.state) === JSON.stringify(replay.state) &&
			live.seq === replay.seq
		);
	} finally {
		store.close();
	}
}

async function provesCrashMidAppendAtomicity(
	createStore: CreateRuntimeLocalEventStore,
	options: {
		dataDirFactory?: () => string;
		removeDataDir?: (dir: string) => void;
		crashProbe?: (
			createStore: CreateRuntimeLocalEventStore,
			dataDir: string,
		) => Promise<boolean>;
	},
): Promise<boolean> {
	if (!options.crashProbe || !options.dataDirFactory) {
		return false;
	}
	const dataDir = options.dataDirFactory();
	const remove = options.removeDataDir ?? (() => undefined);
	try {
		return await options.crashProbe(createStore, dataDir);
	} finally {
		remove(dataDir);
	}
}

async function collect(
	store: EventStore,
	streamId: string,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId)) {
		events.push(event);
	}
	return events;
}

function isContiguous(events: EventEnvelope[]): boolean {
	for (let index = 0; index < events.length; index += 1) {
		if (events[index]?.seq !== index + 1) {
			return false;
		}
	}
	return true;
}

function conformanceOptions(expectedSeq: number): AppendOptions {
	return {
		expectedSeq,
		actor: { kind: "system", id: "conformance" },
		tenant: "conformance-tenant",
	};
}
