import { createHash } from "node:crypto";
import {
	assertReplayEqualsLive,
	type EventEnvelope,
	type FoldFn,
	type ReplayReport,
	stableStringify,
	type UpcastFn,
} from "@hobo/runtime/replay";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

import { createSeededClock, createSeededUlid } from "./deterministic-seed.js";

/**
 * Replay==live production corpus (S1-16).
 *
 * A committed golden corpus recorded from `examples/hello-bindle` under seeded
 * Clock + ULID. Rebuilding the read model from zero (replay) must equal the
 * live fold byte-for-byte, and an upcaster case (`vN -> vN+1`, an evolved event
 * body) must round-trip. This is the production replay lane the S1-24 gate
 * runs; it reuses `@hobo/runtime`'s replay engine (`assertReplayEqualsLive`) —
 * it does not reinvent replay.
 */

export const REPLAY_CORPUS_SEED = "hobo.s1-16.hello-bindle";

/**
 * The hello-bindle read model: greetings served, folded from the domain event
 * stream. Deterministic and read-only (no writes, no ambient clock/entropy).
 */
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
		// SAFETY: assertion to `ent.data as { name?: JsonValue; message?: JsonValue }; ` is required at this boundary.
		const data = event.data as { name?: JsonValue; message?: JsonValue };
		const served = [
			...state.served,
			{ name: String(data.name ?? ""), message: String(data.message ?? "") },
		];
		return { served, count: state.count + 1, seq };
	}

	return { ...state, seq };
};

/**
 * Upcaster chain for `greeting.Served`: v1 carried `{ name, text }`; v2 renames
 * `text -> message`. Old events remain replayable forever — the reader lifts
 * them to the current version before folding.
 */
export const helloBindleUpcast: UpcastFn = (event) => {
	if (event.type === "greeting.Served" && (event.v ?? 1) < 2) {
		// SAFETY: assertion to `t.data as { name?: JsonValue; text?: JsonValue }; ` is required at this boundary.
		const data = event.data as { name?: JsonValue; text?: JsonValue };
		return {
			...event,
			v: 2,
			data: { name: data.name ?? null, message: data.text ?? null },
		};
	}
	return event;
};

export interface ReplayCorpus {
	readonly id: string;
	readonly description: string;
	readonly seed: string;
	/** Whether folding requires the upcaster (a corpus case with an evolved body). */
	readonly requiresUpcaster: boolean;
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

/** Parse-don't-validate: lift a committed corpus JSON blob into a typed corpus. */
export function parseReplayCorpus(raw: JsonValue): ReplayCorpus {
	if (!raw || !isJsonObject(raw)) {
		throw new TypeError("replay corpus must be an object");
	}
	// SAFETY: assertion to `as JsonObject; i` is required at this boundary.
	const value = raw as JsonObject;
	if (!isJsonString(value.id) || value.id.length === 0) {
		throw new TypeError("replay corpus id is required");
	}
	if (!Array.isArray(value.events) || value.events.length === 0) {
		throw new TypeError("replay corpus must carry events");
	}
	// SAFETY: assertion to `e.expected as JsonObject | undefined; i` is required at this boundary.
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
		requiresUpcaster: value.requiresUpcaster === true,
		// SAFETY: assertion to `e.events as EventEnvelope[], ` is required at this boundary.
		events: value.events as never,
		expected: {
			// SAFETY: corpus expected.state is the pinned GreetingReadModel.
			state: expected.state as never,
			stateDigest: expected.stateDigest,
		},
	});
}

/**
 * Fold the corpus events in live arrival order with the given upcaster — the
 * "live" state the committed corpus pins its expectation to.
 */
export function foldLive(
	events: readonly EventEnvelope[],
	upcast: UpcastFn,
): GreetingReadModel {
	let state = emptyGreetingReadModel();
	for (const event of events) {
		const lifted = upcast(structuredClone(event), {
			seed: REPLAY_CORPUS_SEED,
			mode: "live",
			eventKey: `${event.streamId}:${event.seq}`,
			now: () => new Date(0).toISOString(),
			random: () => 0,
		});
		state = helloBindleFold(state, lifted, {
			seed: REPLAY_CORPUS_SEED,
			mode: "live",
			eventKey: `${event.streamId}:${event.seq}`,
			now: () => new Date(0).toISOString(),
			random: () => 0,
		});
	}
	return state;
}

/**
 * Record the golden corpus deterministically from a hello-bindle run. Two
 * cases: `greetings` (current schema) and `greetings-upcast` (an evolved v1
 * body that the upcaster lifts to v2).
 */
export function buildReplayCorpus(): ReplayCorpus[] {
	return [buildGreetingsCorpus(), buildUpcastCorpus()];
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
			makeEvent(ulid, clock, streamId, 2, "greeting.Served", 2, {
				name,
				message: `hello, ${name}`,
			}),
		);
	}

	const state = foldLive(events, helloBindleUpcast);
	return Object.freeze({
		id: "hello-bindle-greetings",
		description:
			"hello-bindle greeting read model recorded under seeded Clock + ULID",
		seed: REPLAY_CORPUS_SEED,
		requiresUpcaster: false,
		events,
		expected: { state, stateDigest: digestState(state) },
	});
}

function buildUpcastCorpus(): ReplayCorpus {
	const clock = createSeededClock();
	const ulid = createSeededUlid(`${REPLAY_CORPUS_SEED}:upcast`);
	const streamId = "greeting:legacy";
	const events: EventEnvelope[] = [
		makeEvent(ulid, clock, streamId, 1, "greeting.Requested", 1, {
			name: "legacy",
		}),
		// A legacy v1 `greeting.Served` body: `{ name, text }` before the
		// `text -> message` rename. The upcaster must lift it to v2.
		makeEvent(ulid, clock, streamId, 2, "greeting.Served", 1, {
			name: "legacy",
			text: "hello, legacy",
		}),
	];

	const state = foldLive(events, helloBindleUpcast);
	return Object.freeze({
		id: "hello-bindle-greetings-upcast",
		description:
			"an evolved v1 greeting.Served body upcast to v2 (text -> message)",
		seed: REPLAY_CORPUS_SEED,
		requiresUpcaster: true,
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

/**
 * Assert the corpus rebuilds byte-for-byte: replay (canonical order) equals
 * live (arrival order) via `@hobo/runtime`'s engine, and the recomputed state
 * digest equals the committed golden digest. Throws on any divergence.
 */
export function assertCorpusReplayEqualsLive(
	corpus: ReplayCorpus,
): CorpusReplayResult {
	const report = assertReplayEqualsLive<GreetingReadModel>({
		// SAFETY: assertion to `.events as EventEnvelope[], fo` is required at this boundary.
		events: corpus.events as EventEnvelope[],
		fold: helloBindleFold,
		initialState: emptyGreetingReadModel(),
		upcast: helloBindleUpcast,
		seed: corpus.seed,
		runId: corpus.id,
	});

	const liveState = foldLive(corpus.events, helloBindleUpcast);
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
