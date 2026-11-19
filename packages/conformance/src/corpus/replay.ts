import { createHash } from "node:crypto";
import {
	assertReplayEqualsLive,
	type EventEnvelope,
	type FoldFn,
	type ReplayReport,
	stableStringify,
} from "@hobo/runtime/replay";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

import { createSeededClock, createSeededUlid } from "./deterministic-seed.js";

export const REPLAY_CORPUS_SEED = "hobo.s1-16.hello-bindle";

export interface GreetingReadModel {
	served: ReadonlyArray<{ name: string; message: string }>;
	count: number;
	seq: Record<string, number>;
}

export function emptyGreetingReadModel(): GreetingReadModel {
	return { served: [], count: 0, seq: {} };
}

export const helloBindleFold: FoldFn<GreetingReadModel> = (state, event) => {
	const seq = { ...state.seq, [event.streamId]: event.seq };

	if (event.type === "greeting.Served") {
		const data = event.data as { name?: JsonValue; message?: JsonValue };
		const served = [
			...state.served,
			{ name: String(data.name ?? ""), message: String(data.message ?? "") },
		];
		return { served, count: state.count + 1, seq };
	}

	return { ...state, seq };
};

export interface ReplayCorpus {
	readonly id: string;
	readonly description: string;
	readonly seed: string;
	readonly events: readonly EventEnvelope[];
	readonly expected: {
		readonly state: GreetingReadModel;
		readonly stateDigest: string;
	};
}

function digestState(state: GreetingReadModel): string {
	return createHash("sha256")
		.update(stableStringify(cloneAsJson(state)))
		.digest("hex");
}

export function parseReplayCorpus(raw: JsonValue): ReplayCorpus {
	if (!raw || !isJsonObject(raw)) {
		throw new TypeError("replay corpus must be an object");
	}
	const value = raw as JsonObject;
	if (!isJsonString(value.id) || value.id.length === 0) {
		throw new TypeError("replay corpus id is required");
	}
	if (!Array.isArray(value.events) || value.events.length === 0) {
		throw new TypeError("replay corpus must carry events");
	}
	const expected = value.expected as JsonObject | undefined;
	if (
		!expected ||
		!isJsonString(expected.stateDigest) ||
		expected.stateDigest.length === 0
	) {
		throw new TypeError("replay corpus must carry an expected state digest");
	}
	return Object.freeze({
		id: value.id,
		description: isJsonString(value.description) ? value.description : "",
		seed: isJsonString(value.seed) ? value.seed : REPLAY_CORPUS_SEED,
		events: value.events as never,
		expected: {
			state: expected.state as never,
			stateDigest: expected.stateDigest,
		},
	});
}

export function foldLive(events: readonly EventEnvelope[]): GreetingReadModel {
	let state = emptyGreetingReadModel();
	for (const event of events) {
		state = helloBindleFold(state, structuredClone(event), {
			seed: REPLAY_CORPUS_SEED,
			mode: "live",
			eventKey: `${event.streamId}:${event.seq}`,
			now: () => new Date(0).toISOString(),
			random: () => 0,
		});
	}
	return state;
}

export function buildReplayCorpus(): ReplayCorpus[] {
	return [buildGreetingsCorpus(), buildRepeatedGreetingsCorpus()];
}

function buildGreetingsCorpus(): ReplayCorpus {
	const clock = createSeededClock();
	const ulid = createSeededUlid(`${REPLAY_CORPUS_SEED}:greetings`);
	const events: EventEnvelope[] = [];

	for (const name of ["HoBo", "world"]) {
		const streamId = `greeting:${name}`;
		events.push(
			makeEvent(ulid, clock, streamId, 1, "greeting.Requested", 1, { name }),
		);
		events.push(
			makeEvent(ulid, clock, streamId, 2, "greeting.Served", 1, {
				name,
				message: `hello, ${name}`,
			}),
		);
	}

	const state = foldLive(events);
	return Object.freeze({
		id: "hello-bindle-greetings",
		description:
			"hello-bindle greeting read model recorded under seeded Clock + ULID",
		seed: REPLAY_CORPUS_SEED,
		events,
		expected: { state, stateDigest: digestState(state) },
	});
}

function buildRepeatedGreetingsCorpus(): ReplayCorpus {
	const clock = createSeededClock();
	const ulid = createSeededUlid(`${REPLAY_CORPUS_SEED}:repeated`);
	const events: EventEnvelope[] = [];
	for (const name of ["HoBo", "world", "HoBo"]) {
		const streamId = "greeting:repeated";
		events.push(
			makeEvent(
				ulid,
				clock,
				streamId,
				events.length + 1,
				"greeting.Requested",
				1,
				{ name },
			),
		);
		events.push(
			makeEvent(
				ulid,
				clock,
				streamId,
				events.length + 1,
				"greeting.Served",
				1,
				{
					name,
					message: `hello, ${name}`,
				},
			),
		);
	}
	const state = foldLive(events);
	return Object.freeze({
		id: "hello-bindle-repeated-greetings",
		description: "repeated greetings in one ordered stream",
		seed: REPLAY_CORPUS_SEED,
		events,
		expected: { state, stateDigest: digestState(state) },
	});
}

function makeEvent(
	ulid: ReturnType<typeof createSeededUlid>,
	clock: ReturnType<typeof createSeededClock>,
	streamId: string,
	seq: number,
	type: string,
	v: number,
	data: JsonObject,
): EventEnvelope {
	const ts = clock.nowIso();
	const id = ulid.next(clock.nowMs());
	clock.tick();
	return Object.freeze({ id, streamId, seq, type, v, ts, data });
}

export interface CorpusReplayResult {
	readonly report: ReplayReport;
	readonly liveState: GreetingReadModel;
	readonly digestMatches: boolean;
}

export function assertCorpusReplayEqualsLive(
	corpus: ReplayCorpus,
): CorpusReplayResult {
	const report = assertReplayEqualsLive<GreetingReadModel>({
		events: corpus.events as EventEnvelope[],
		fold: helloBindleFold,
		initialState: emptyGreetingReadModel(),
		seed: corpus.seed,
		runId: corpus.id,
	});

	const liveState = foldLive(corpus.events);
	const liveDigest = digestState(liveState);

	if (liveDigest !== corpus.expected.stateDigest) {
		throw new Error(
			`replay corpus ${corpus.id}: live digest ${liveDigest} != committed ${corpus.expected.stateDigest}`,
		);
	}
	if (report.stateDigest !== corpus.expected.stateDigest) {
		throw new Error(
			`replay corpus ${corpus.id}: replay digest ${report.stateDigest} != committed ${corpus.expected.stateDigest}`,
		);
	}

	return Object.freeze({
		report,
		liveState,
		digestMatches: true,
	});
}
