/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this test intentionally casts controlled malformed fixtures to exercise runtime validation contracts. */

import { describe, expect, it } from "vitest";

import {
	createSeededClock,
	createSeededUlid,
} from "../src/corpus/deterministic-seed.js";
import {
	assertCorpusReplayEqualsLive,
	buildReplayCorpus,
	emptyGreetingReadModel,
	foldLive,
	helloBindleFold,
	helloBindleUpcast,
	parseReplayCorpus,
	REPLAY_CORPUS_SEED,
} from "../src/corpus/replay.js";
import {
	createAdapterRegistry,
	createConformanceSuiteRegistry,
} from "../src/registry.js";
import { createCaseContext, createSeededRandom } from "../src/seed.js";
import { createConformanceSuite } from "../src/suite.js";

const FOLD_CONTEXT = {
	seed: REPLAY_CORPUS_SEED,
	mode: "live" as const,
	eventKey: "k",
	now: () => new Date(0).toISOString(),
	random: () => 0,
};

type EventFixture = {
	id: string;
	streamId: string;
	seq: number;
	type: string;
	v: number | undefined;
	ts: string;
	data: { name?: string; message?: string; text?: string };
};

function event(overrides: Partial<EventFixture> = {}): EventFixture {
	return {
		id: "01",
		streamId: "greeting:a",
		seq: 1,
		type: "greeting.Served",
		v: 2,
		ts: "2026-01-01T00:00:00.000Z",
		data: { name: "a", message: "hello, a" },
		...overrides,
	};
}

describe("createSeededClock", () => {
	it("starts at a fixed instant and never reads wall time", () => {
		const clock = createSeededClock();
		expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
		expect(createSeededClock().nowMs()).toBe(clock.nowMs());
	});

	it("advances by a fixed step and returns the new instant", () => {
		const clock = createSeededClock();
		const before = clock.nowMs();
		expect(clock.tick()).toBe(before + 1000);
		expect(clock.nowMs()).toBe(before + 1000);
	});

	it("honours an explicit start and step", () => {
		const clock = createSeededClock(0, 5);
		expect(clock.nowIso()).toBe("1970-01-01T00:00:00.000Z");
		clock.tick();
		expect(clock.nowMs()).toBe(5);
	});

	it("is monotonic across many ticks", () => {
		const clock = createSeededClock();
		let previous = clock.nowMs();
		for (let index = 0; index < 50; index += 1) {
			const next = clock.tick();
			expect(next).toBeGreaterThan(previous);
			previous = next;
		}
	});

	it("gives each clock its own state", () => {
		const first = createSeededClock();
		first.tick();
		expect(createSeededClock().nowMs()).toBeLessThan(first.nowMs());
	});
});

describe("createSeededUlid", () => {
	it("produces 26-character Crockford ids", () => {
		const id = createSeededUlid("seed").next(0);
		expect(id).toHaveLength(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
	});

	it("is reproducible for the same seed and call order", () => {
		const first = createSeededUlid("seed");
		const second = createSeededUlid("seed");
		expect([first.next(0), first.next(0)]).toEqual([
			second.next(0),
			second.next(0),
		]);
	});

	it("differs by seed", () => {
		expect(createSeededUlid("a").next(0)).not.toBe(
			createSeededUlid("b").next(0),
		);
	});

	it("differs by call index at the same instant", () => {
		const ulid = createSeededUlid("seed");
		expect(ulid.next(0)).not.toBe(ulid.next(0));
	});

	it("encodes time as a lexically sortable prefix", () => {
		const ulid = createSeededUlid("seed");
		const early = ulid.next(1000).slice(0, 10);
		const late = ulid.next(2000).slice(0, 10);
		expect(early < late).toBe(true);
	});

	it("shares a time prefix for the same instant", () => {
		const ulid = createSeededUlid("seed");
		expect(ulid.next(1000).slice(0, 10)).toBe(ulid.next(1000).slice(0, 10));
	});

	it("floors a fractional instant rather than producing a fractional digit", () => {
		const ulid = createSeededUlid("seed");
		expect(ulid.next(1000.9).slice(0, 10)).toBe(
			createSeededUlid("seed").next(1000).slice(0, 10),
		);
	});
});

describe("createSeededRandom", () => {
	it("is reproducible for the same seed", () => {
		const first = createSeededRandom("s");
		const second = createSeededRandom("s");
		expect([first(), first(), first()]).toEqual([second(), second(), second()]);
	});

	it("differs by seed", () => {
		expect(createSeededRandom("a")()).not.toBe(createSeededRandom("b")());
	});

	it("stays inside the unit interval", () => {
		const random = createSeededRandom("s");
		for (let index = 0; index < 200; index += 1) {
			const value = random();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	it("advances rather than repeating", () => {
		const random = createSeededRandom("s");
		expect(random()).not.toBe(random());
	});

	it("handles an empty seed", () => {
		expect(() => createSeededRandom("")()).not.toThrow();
	});
});

describe("createCaseContext", () => {
	it("carries the seed and case id and derives a per-case generator", () => {
		const context = createCaseContext("s", "case-1");
		expect(context.seed).toBe("s");
		expect(context.caseId).toBe("case-1");
		expect(context.random()).toBeTypeOf("number");
	});

	it("gives different cases different streams under one seed", () => {
		expect(createCaseContext("s", "a").random()).not.toBe(
			createCaseContext("s", "b").random(),
		);
	});

	it("reproduces the same stream for the same seed and case", () => {
		expect(createCaseContext("s", "a").random()).toBe(
			createCaseContext("s", "a").random(),
		);
	});
});

describe("helloBindleFold", () => {
	it("records a served greeting and advances the count", () => {
		const state = helloBindleFold(
			emptyGreetingReadModel(),
			event() as never,
			FOLD_CONTEXT,
		);
		expect(state.count).toBe(1);
		expect(state.served).toEqual([{ name: "a", message: "hello, a" }]);
	});

	it("tracks the per-stream seq for every event type", () => {
		const state = helloBindleFold(
			emptyGreetingReadModel(),
			event({ type: "greeting.Requested", seq: 7 }) as never,
			FOLD_CONTEXT,
		);
		expect(state.seq).toEqual({ "greeting:a": 7 });
		expect(state.count).toBe(0);
		expect(state.served).toEqual([]);
	});

	it("coerces a missing name or message to an empty string", () => {
		const state = helloBindleFold(
			emptyGreetingReadModel(),
			event({ data: {} }) as never,
			FOLD_CONTEXT,
		);
		expect(state.served).toEqual([{ name: "", message: "" }]);
	});

	it("does not mutate the state it was handed", () => {
		const initial = emptyGreetingReadModel();
		helloBindleFold(initial, event() as never, FOLD_CONTEXT);
		expect(initial.count).toBe(0);
		expect(initial.served).toEqual([]);
	});

	it("accumulates across several events", () => {
		let state = emptyGreetingReadModel();
		state = helloBindleFold(state, event() as never, FOLD_CONTEXT);
		state = helloBindleFold(
			state,
			event({
				streamId: "greeting:b",
				data: { name: "b", message: "hi" },
			}) as never,
			FOLD_CONTEXT,
		);
		expect(state.count).toBe(2);
		expect(Object.keys(state.seq).sort()).toEqual(["greeting:a", "greeting:b"]);
	});
});

describe("helloBindleUpcast", () => {
	it("lifts a v1 greeting.Served from text to message", () => {
		const lifted = helloBindleUpcast(
			event({ v: 1, data: { name: "a", text: "hello" } }) as never,
			FOLD_CONTEXT,
		);
		expect(lifted.v).toBe(2);
		expect(lifted.data).toEqual({ name: "a", message: "hello" });
	});

	it("treats a missing version as v1", () => {
		const lifted = helloBindleUpcast(
			event({ v: undefined, data: { name: "a", text: "hello" } }) as never,
			FOLD_CONTEXT,
		);
		expect(lifted.v).toBe(2);
	});

	it("leaves a v2 event untouched", () => {
		const original = event({ v: 2 });
		const lifted = helloBindleUpcast(original as never, FOLD_CONTEXT);
		expect(lifted).toBe(original);
	});

	it("leaves an unrelated event type untouched even at v1", () => {
		const original = event({ type: "greeting.Requested", v: 1 });
		expect(helloBindleUpcast(original as never, FOLD_CONTEXT)).toBe(original);
	});
});

describe("foldLive", () => {
	it("folds in arrival order and does not mutate the input events", () => {
		const events = [event({ v: 1, data: { name: "a", text: "hello" } })];
		const state = foldLive(events as never, helloBindleUpcast);
		expect(state.served).toEqual([{ name: "a", message: "hello" }]);
		expect(events[0]?.v).toBe(1);
		expect(events[0]?.data).toEqual({ name: "a", text: "hello" });
	});

	it("returns the empty model for no events", () => {
		expect(foldLive([], helloBindleUpcast)).toEqual(emptyGreetingReadModel());
	});
});

describe("buildReplayCorpus", () => {
	it("builds both cases with stable ids", () => {
		const corpora = buildReplayCorpus();
		expect(corpora.map((corpus) => corpus.id)).toEqual([
			"hello-bindle-greetings",
			"hello-bindle-greetings-upcast",
		]);
	});

	it("is byte-identical across regenerations", () => {
		expect(JSON.stringify(buildReplayCorpus())).toBe(
			JSON.stringify(buildReplayCorpus()),
		);
	});

	it("flags only the upcast case as requiring the upcaster", () => {
		// migration path. Both true would make the plain case's coverage a
		const [plain, upcast] = buildReplayCorpus();
		expect(plain?.requiresUpcaster).toBe(false);
		expect(upcast?.requiresUpcaster).toBe(true);
	});

	it("records a v1 body in the upcast case", () => {
		const upcast = buildReplayCorpus()[1];
		const served = upcast?.events.find(
			(candidate) => candidate.type === "greeting.Served",
		);
		expect(served?.v).toBe(1);
		expect((served?.data as { text?: string })?.text).toBe("hello, legacy");
	});

	it("gives every event a distinct id and a monotonic timestamp", () => {
		for (const corpus of buildReplayCorpus()) {
			const ids = corpus.events.map((candidate) => candidate.id);
			expect(new Set(ids).size).toBe(ids.length);
			const times = corpus.events.map((candidate) => Date.parse(candidate.ts));
			expect([...times].sort((a, b) => a - b)).toEqual(times);
		}
	});

	it("pins an expected digest that matches its own recorded state", () => {
		for (const corpus of buildReplayCorpus()) {
			expect(corpus.expected.stateDigest).toMatch(/^[a-f0-9]{64}$/u);
			expect(corpus.expected.state.count).toBeGreaterThan(0);
		}
	});

	it("freezes each corpus", () => {
		for (const corpus of buildReplayCorpus()) {
			expect(Object.isFrozen(corpus)).toBe(true);
		}
	});
});

describe("assertCorpusReplayEqualsLive", () => {
	it("passes for each committed case", () => {
		for (const corpus of buildReplayCorpus()) {
			const result = assertCorpusReplayEqualsLive(corpus);
			expect(result.digestMatches).toBe(true);
			expect(result.report.stateDigest).toBe(corpus.expected.stateDigest);
		}
	});

	it("throws when the committed digest no longer matches", () => {
		const corpus = buildReplayCorpus()[0];
		expect(() =>
			assertCorpusReplayEqualsLive({
				...(corpus as never),
				expected: { ...corpus?.expected, stateDigest: "0".repeat(64) },
			} as never),
		).toThrow(/live digest .* != committed/u);
	});

	it("throws when an event body has drifted from the recording", () => {
		const corpus = buildReplayCorpus()[0];
		const mutated = corpus?.events.map((candidate, index) =>
			index === 1
				? { ...candidate, data: { name: "tampered", message: "tampered" } }
				: candidate,
		);
		expect(() =>
			assertCorpusReplayEqualsLive({
				...(corpus as never),
				events: mutated,
			} as never),
		).toThrow();
	});
});

describe("parseReplayCorpus", () => {
	const RAW = {
		id: "c-1",
		description: "d",
		seed: "s",
		requiresUpcaster: true,
		events: [event()],
		expected: { state: emptyGreetingReadModel(), stateDigest: "a".repeat(64) },
	};

	it("lifts a well-formed blob and freezes it", () => {
		const parsed = parseReplayCorpus(RAW);
		expect(parsed.id).toBe("c-1");
		expect(parsed.requiresUpcaster).toBe(true);
		expect(Object.isFrozen(parsed)).toBe(true);
	});

	it("refuses a non-object", () => {
		for (const bad of [null, undefined, 7, "corpus"]) {
			expect(() => parseReplayCorpus(bad)).toThrow(/must be an object/u);
		}
	});

	it("refuses a missing or empty id", () => {
		expect(() => parseReplayCorpus({ ...RAW, id: "" })).toThrow(
			/id is required/u,
		);
		expect(() => parseReplayCorpus({ ...RAW, id: 7 })).toThrow(
			/id is required/u,
		);
	});

	it("refuses an empty or non-array event list", () => {
		expect(() => parseReplayCorpus({ ...RAW, events: [] })).toThrow(
			/must carry events/u,
		);
		expect(() => parseReplayCorpus({ ...RAW, events: {} })).toThrow(
			/must carry events/u,
		);
	});

	it("refuses a missing or empty expected digest", () => {
		for (const expected of [
			undefined,
			{},
			{ stateDigest: "" },
			{ stateDigest: 7 },
		]) {
			expect(() => parseReplayCorpus({ ...RAW, expected })).toThrow(
				/expected state digest/u,
			);
		}
	});

	it("defaults an absent description, seed and upcaster flag", () => {
		const parsed = parseReplayCorpus({
			id: "c",
			events: [event()],
			expected: { stateDigest: "a".repeat(64) },
		});
		expect(parsed.description).toBe("");
		expect(parsed.seed).toBe(REPLAY_CORPUS_SEED);
		expect(parsed.requiresUpcaster).toBe(false);
	});

	it("requires the upcaster flag to be exactly true", () => {
		expect(
			parseReplayCorpus({ ...RAW, requiresUpcaster: "yes" }).requiresUpcaster,
		).toBe(false);
	});

	it("round-trips a built corpus through JSON", () => {
		for (const corpus of buildReplayCorpus()) {
			const parsed = parseReplayCorpus(JSON.parse(JSON.stringify(corpus)));
			expect(parsed.expected.stateDigest).toBe(corpus.expected.stateDigest);
			expect(assertCorpusReplayEqualsLive(parsed).digestMatches).toBe(true);
		}
	});
});

describe("createAdapterRegistry", () => {
	const adapter = { id: "a" } as never;

	it("registers, retrieves and lists", () => {
		const registry = createAdapterRegistry();
		registry.register(adapter);
		expect(registry.get("a")).toBe(adapter);
		expect(registry.list()).toEqual([adapter]);
	});

	it("returns undefined for an unknown id", () => {
		expect(createAdapterRegistry().get("nope")).toBeUndefined();
	});

	it("refuses a duplicate id rather than replacing", () => {
		const registry = createAdapterRegistry();
		registry.register(adapter);
		expect(() => registry.register({ id: "a" } as never)).toThrow(
			/already registered: a/u,
		);
	});

	it("starts empty", () => {
		expect(createAdapterRegistry().list()).toEqual([]);
	});
});

describe("createConformanceSuiteRegistry", () => {
	const descriptor = { suiteId: "s1", checks: ["c2", "c1"] } as never;

	it("registers from the constructor and from register()", () => {
		expect(
			createConformanceSuiteRegistry([descriptor]).get("s1"),
		).toBeDefined();
		const registry = createConformanceSuiteRegistry();
		registry.register(descriptor);
		expect(registry.get("s1")).toBeDefined();
	});

	it("freezes each descriptor it stores", () => {
		const registry = createConformanceSuiteRegistry([descriptor]);
		expect(Object.isFrozen(registry.get("s1"))).toBe(true);
	});

	it("stores a copy, so mutating the input does not reach the registry", () => {
		const input = { suiteId: "s1", checks: ["c1"] };
		const registry = createConformanceSuiteRegistry([input as never]);
		input.suiteId = "changed";
		expect(registry.get("s1")).toBeDefined();
	});

	it("refuses a descriptor with no suiteId", () => {
		const registry = createConformanceSuiteRegistry();
		for (const bad of [undefined, null, {}, { suiteId: "" }]) {
			expect(() => registry.register(bad as never)).toThrow(/needs a suiteId/u);
		}
	});

	it("refuses a descriptor that declares no checks", () => {
		expect(() =>
			createConformanceSuiteRegistry().register({
				suiteId: "s",
				checks: [],
			} as never),
		).toThrow(/declares no checks/u);
	});

	it("refuses a duplicate suiteId", () => {
		const registry = createConformanceSuiteRegistry([descriptor]);
		expect(() => registry.register(descriptor)).toThrow(
			/already registered: s1/u,
		);
	});

	it("lists sorted by suiteId rather than by insertion order", () => {
		const registry = createConformanceSuiteRegistry([
			{ suiteId: "zebra", checks: ["c"] } as never,
			{ suiteId: "alpha", checks: ["c"] } as never,
		]);
		expect(registry.list().map((entry) => entry.suiteId)).toEqual([
			"alpha",
			"zebra",
		]);
	});

	it("returns a sorted, deduplicated union of every check", () => {
		const registry = createConformanceSuiteRegistry([
			{ suiteId: "a", checks: ["c2", "c1"] } as never,
			{ suiteId: "b", checks: ["c1", "c3"] } as never,
		]);
		expect(registry.checks()).toEqual(["c1", "c2", "c3"]);
	});

	it("returns undefined for an unknown suite and empty lists when empty", () => {
		const registry = createConformanceSuiteRegistry();
		expect(registry.get("nope")).toBeUndefined();
		expect(registry.list()).toEqual([]);
		expect(registry.checks()).toEqual([]);
	});
});

describe("createConformanceSuite", () => {
	const DEFINITION = {
		id: "suite-1",
		port: { wit: "hobo:kv/store", functions: ["get", "set"] },
		cases: [{ id: "c1", call: { function: "get" } }],
	};

	it("builds a frozen suite carrying the schema id", () => {
		const suite = createConformanceSuite(DEFINITION as never);
		expect(suite.id).toBe("suite-1");
		expect(Object.isFrozen(suite)).toBe(true);
		expect(Object.isFrozen(suite.port)).toBe(true);
		expect(Object.isFrozen(suite.coverage)).toBe(true);
	});

	it("refuses a missing or non-object definition", () => {
		for (const bad of [undefined, null, "suite", 7]) {
			expect(() => createConformanceSuite(bad as never)).toThrow(
				/definition is required/u,
			);
		}
	});

	it("refuses a missing id and a missing port.wit", () => {
		expect(() =>
			createConformanceSuite({ ...DEFINITION, id: "" } as never),
		).toThrow(/id is required/u);
		expect(() =>
			createConformanceSuite({
				...DEFINITION,
				port: { functions: ["get"] },
			} as never),
		).toThrow(/port.wit is required/u);
	});

	it("requires at least one port function", () => {
		// so its coverage report would be vacuously complete.
		for (const functions of [[], undefined, "get"]) {
			expect(() =>
				createConformanceSuite({
					...DEFINITION,
					port: { wit: "w", functions },
				} as never),
			).toThrow(/must name at least one function/u);
		}
	});

	it("requires at least one case", () => {
		for (const cases of [[], undefined, {}]) {
			expect(() =>
				createConformanceSuite({ ...DEFINITION, cases } as never),
			).toThrow(/must contain at least one case/u);
		}
	});

	it("deduplicates the port function list", () => {
		// A repeated function would be counted twice in coverage and make a
		const suite = createConformanceSuite({
			...DEFINITION,
			port: { wit: "w", functions: ["get", "get", "set"] },
		} as never);
		expect(suite.port.functions).toEqual(["get", "set"]);
	});

	it("defaults requiredFunctions to the full port surface", () => {
		// Conservative: a suite that does not narrow its coverage requirement is
		expect(
			createConformanceSuite(DEFINITION as never).coverage.requiredFunctions,
		).toEqual(["get", "set"]);
	});

	it("honours an explicit requiredFunctions, deduplicated", () => {
		const suite = createConformanceSuite({
			...DEFINITION,
			coverage: { requiredFunctions: ["get", "get"] },
		} as never);
		expect(suite.coverage.requiredFunctions).toEqual(["get"]);
	});

	it("defaults each case's tier to local and exercises to its own call", () => {
		// noticing the coverage drop.
		const suiteCase = createConformanceSuite(DEFINITION as never).cases[0];
		expect(suiteCase?.tier).toBe("local");
		expect(suiteCase?.exercises).toEqual(["get"]);
	});

	it("honours an explicit tier and exercises list", () => {
		const suite = createConformanceSuite({
			...DEFINITION,
			cases: [
				{
					id: "c1",
					tier: "live",
					exercises: ["get", "set"],
					call: { function: "get" },
				},
			],
		} as never);
		expect(suite.cases[0]?.tier).toBe("live");
		expect(suite.cases[0]?.exercises).toEqual(["get", "set"]);
	});

	it("deep-clones the cases, so the definition cannot be mutated through the suite", () => {
		const definition = {
			...DEFINITION,
			cases: [{ id: "c1", call: { function: "get", args: { key: "k" } } }],
		};
		const suite = createConformanceSuite(definition as never);
		expect(suite.cases[0]?.call).not.toBe(definition.cases[0]?.call);
		expect(suite.cases[0]?.call.args).toEqual({ key: "k" });
	});
});
