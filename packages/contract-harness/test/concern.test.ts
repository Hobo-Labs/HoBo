/**
 * The harness needs its own tests, and it did not have any.
 *
 * Everything below is a way `describeConcern` could pass while checking
 * nothing, which is the only failure mode that matters in a test harness: a
 * broken assertion library reports green and takes every suite built on it with
 * it. The three pieces are exercised directly — `assertCase` is split out of
 * the runner precisely so the assertions can be falsified here rather than only
 * by running a nested suite, which is what let two of them ship inert.
 */
import { describe, expect, it } from "vitest";

import {
	assertCase,
	callableMembers,
	parseConcernCases,
} from "../src/concern.js";

const row = (extra: string) => `{"method":"f",${extra}}`;

describe("parseConcernCases", () => {
	it("reads rows, skipping blanks and # comments", () => {
		const cases = parseConcernCases(
			`# a note\n\n${row('"expect":1')}\n${row('"expect":2')}\n`,
		);
		expect(cases).toHaveLength(2);
	});

	it.each([
		["an unknown key", row('"expcet":1'), /unknown key "expcet"/u],
		["no method", '{"expect":1}', /non-empty "method"/u],
		["an empty method", '{"method":"","expect":1}', /non-empty "method"/u],
		["nothing asserted", row('"name":"x"'), /asserts nothing/u],
		["a throw and a value", row('"throws":"x","expect":1'), /both a throw/u],
		[
			"a throwsSubset and a value",
			row('"throwsSubset":{"name":"E"},"subset":{}'),
			/both a throw/u,
		],
		["malformed JSON", "{not json", /is not JSON/u],
		["no cases at all", "# only a comment\n", /declares no cases/u],
	])("refuses %s", (_label, text, expected) => {
		expect(() => parseConcernCases(text, "cases")).toThrow(expected);
	});

	it("names the line so a bad row is findable in a long file", () => {
		expect(() =>
			parseConcernCases(`${row('"expect":1')}\n{"expcet":2}\n`, "f.jsonl"),
		).toThrow(/f\.jsonl:2/u);
	});
});

describe("callableMembers", () => {
	it("finds inherited methods, not just own ones", () => {
		class Base {
			inherited() {}
		}
		class Derived extends Base {
			own() {}
		}
		expect(callableMembers(new Derived())).toEqual(["inherited", "own"]);
	});

	it("counts a getter without invoking it", () => {
		let reads = 0;
		const subject = {
			get computed() {
				reads += 1;
				return 1;
			},
		};
		expect(callableMembers(subject)).toEqual(["computed"]);
		// Listing must not run it: a getter with a side effect would otherwise
		// fire once per suite just by being enumerated.
		expect(reads).toBe(0);
	});

	it("ignores plain data on an object", () => {
		expect(callableMembers({ value: 1, method() {} })).toEqual(["method"]);
	});

	it("treats a module namespace as functions only", () => {
		// Every export of an ES module is a getter, so without this a plain
		// constant would be demanded as a member needing its own cases.
		const namespace = Object.create(null, {
			[Symbol.toStringTag]: { value: "Module" },
			CONSTANT: { get: () => "x", enumerable: true },
			fn: { get: () => () => undefined, enumerable: true },
		}) as object;
		expect(callableMembers(namespace)).toEqual(["fn"]);
	});
});

describe("assertCase", () => {
	const returned = (value: unknown) => ({ returned: value });
	const threw = (error: unknown) => ({ threw: error });

	// Every row here is a *different* assertion inside `assertCase`, and the
	// bare `.toThrow()` this replaced could not distinguish them: an
	// `assertCase` that rejected every row for one wrong reason — an unparsed
	// field, a thrown TypeError on a shape it did not expect — would have gone
	// green on all eight. This is the harness every PACT suite in the repo
	// delegates to, so a false green here is a false green everywhere.
	it.each([
		[
			"a throws case that returned instead",
			{ method: "f", throws: "not found" },
			returned("not found"),
			'expected a throw matching not found, got "not found"',
		],
		[
			"a throwsSubset case that returned instead",
			{ method: "f", throwsSubset: { code: "E" } },
			returned({ code: "E" }),
			'expected a throw matching {"code":"E"}, got {"code":"E"}',
		],
		[
			"a subset the result does not contain",
			{ method: "f", subset: { a: 1, b: 2 } },
			returned({ a: 1, b: 3 }),
			'result mismatch at $.b — got {"a":1,"b":3}',
		],
		[
			"a subset against a missing key",
			{ method: "f", subset: { a: 1 } },
			returned({}),
			"result mismatch at $.a — got {}",
		],
		[
			"an expect that differs",
			{ method: "f", expect: 1 },
			returned(2),
			"expected 2 to deeply equal 1",
		],
		[
			"a match that misses",
			{ method: "f", match: "^ok$" },
			returned("nope"),
			"expected 'nope' to match /^ok$/u",
		],
		[
			"a throw whose message misses",
			{ method: "f", throws: "not found" },
			threw(new Error("boom")),
			"expected 'boom' to match /not found/u",
		],
		[
			"a throw whose fields miss",
			{ method: "f", throwsSubset: { code: "A" } },
			threw(Object.assign(new Error("boom"), { code: "B" })),
			"thrown error mismatch at $.code — got Error: boom",
		],
	])("fails %s", (_label, row, outcome, message) => {
		expect(() => assertCase(row, outcome)).toThrow(message);
	});

	it.each([
		[
			"a subset the result contains",
			{ method: "f", subset: { a: 1 } },
			returned({ a: 1, b: 2 }),
		],
		["an exact expect", { method: "f", expect: [1, 2] }, returned([1, 2])],
		[
			"a match on a stringified object",
			{ method: "f", match: "needle" },
			returned({ errors: ["a needle"] }),
		],
		[
			"a throw whose message matches",
			{ method: "f", throws: "boom" },
			threw(new Error("kaboom")),
		],
		[
			"a throw whose fields match",
			{ method: "f", throwsSubset: { name: "PackError", code: "A" } },
			threw(Object.assign(new Error("x"), { name: "PackError", code: "A" })),
		],
	])("passes %s", (_label, row, outcome) => {
		expect(() => assertCase(row, outcome)).not.toThrow();
	});

	it("rethrows an unexpected throw rather than swallowing it", () => {
		// A case asserting a value must not absorb a crash in the subject:
		// that would turn every broken method into a green "no assertion ran".
		expect(() =>
			assertCase(
				{ method: "f", expect: 1 },
				threw(new Error("subject blew up")),
			),
		).toThrow(/subject blew up/u);
	});
});
