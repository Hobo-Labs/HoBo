/**
 * The EventStore's append-side parser.
 *
 * Everything written to the store crosses this boundary, and nothing past it
 * re-checks a field. That makes the parser the only place a malformed append can
 * be caught — and an append is the one operation that cannot be taken back. A
 * bad event in a stream is permanent: every later read replays it, every
 * projection folds it, and the fix is a compensating event rather than a
 * correction.
 *
 * Two properties carry the weight.
 *
 * **The expected sequence is the concurrency control.** It is what makes a
 * stream-head compare-and-swap possible (ADR-0135), so it has to be a real
 * non-negative integer. A `NaN` or a float would compare unequal to every stored
 * sequence and turn every append into a conflict — or, worse, compare *equal* by
 * coercion somewhere downstream and let two writers both believe they won.
 *
 * **Data and metadata are cloned, not referenced.** A caller that mutated the
 * object it appended after the call would otherwise change what the store
 * holds — a write that changes after it was made, which no reader could explain.
 */
import { describe, expect, it } from "vitest";

import {
	parseAppendContext,
	parseEventInput,
	parseEventInputs,
	parseExpectedSeq,
	parseStreamId,
} from "../src/eventstore/parse.js";

const ACTOR = { id: "user-1", kind: "user" };

const CONTEXT = {
	expectedSeq: 0,
	actor: ACTOR,
	tenant: "acme",
};

describe("parseStreamId", () => {
	it("accepts a non-empty string", () => {
		expect(parseStreamId("orders-1")).toBe("orders-1");
	});

	it("refuses an empty stream id", () => {
		// An empty id would append into a stream nothing can address, so the
		// events would be written and never read again.
		expect(() => parseStreamId("")).toThrow(TypeError);
	});

	it("refuses a non-string stream id", () => {
		for (const value of [undefined, null, 7, {}, [], Symbol("s")]) {
			expect(() => parseStreamId(value)).toThrow(/non-empty string/u);
		}
	});
});

describe("parseExpectedSeq", () => {
	it("accepts zero, which is how a stream is created", () => {
		// Zero means "I expect this stream not to exist yet". Refusing it would
		// make the first append to any stream impossible.
		expect(parseExpectedSeq(0)).toBe(0);
	});

	it("accepts a positive sequence", () => {
		expect(parseExpectedSeq(42)).toBe(42);
	});

	it("refuses a negative sequence", () => {
		// There is no position before the start of a stream, and a negative would
		// compare below every stored head — making the CAS always appear to
		// succeed against an empty stream.
		expect(() => parseExpectedSeq(-1)).toThrow(/non-negative safe integer/u);
	});

	it("refuses a fractional sequence", () => {
		// Sequences are positions, not measurements. A float would never equal a
		// stored integer, so every append would report a conflict that does not
		// exist.
		expect(() => parseExpectedSeq(1.5)).toThrow(TypeError);
	});

	it("refuses NaN and the infinities", () => {
		// The dangerous ones. `NaN` compares false against everything, so a
		// concurrency check written as `stored === expected` would reject
		// forever, and one written as `stored !== expected` would accept forever.
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(() => parseExpectedSeq(value)).toThrow(TypeError);
		}
	});

	it("refuses a value past the safe integer range", () => {
		// Beyond 2^53 an increment is a no-op, so two distinct positions would
		// compare equal and the CAS would stop distinguishing writers.
		expect(() => parseExpectedSeq(Number.MAX_SAFE_INTEGER + 1)).toThrow(
			TypeError,
		);
	});

	it("refuses a numeric string rather than coercing it", () => {
		// `"5"` is what arrives from a query string or a JSON body written by
		// hand. Coercing would work until a caller sent `"05"` or `" 5"`, and the
		// failure would be a phantom conflict rather than a parse error.
		for (const value of ["5", "", null, undefined, {}, 5n]) {
			expect(() => parseExpectedSeq(value)).toThrow(TypeError);
		}
	});

	it("names the field it was checking", () => {
		// The same parser guards several fields; a message naming only
		// "expectedSeq" would misdirect a reader debugging an append context.
		expect(() => parseExpectedSeq(-1, "appendOptions.expectedSeq")).toThrow(
			/appendOptions\.expectedSeq/u,
		);
	});
});

describe("parseEventInput", () => {
	it("returns a frozen event", () => {
		// Held past the parser and written to storage. Freezing is what makes
		// "nothing past here re-checks this" safe to rely on.
		const parsed = parseEventInput({ type: "OrderPlaced" });
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.meta)).toBe(true);
	});

	it("defaults the version to 1", () => {
		// The first version of an event type does not have to say so. Defaulting
		// to 0 or undefined would make an unversioned event unroutable by a
		// consumer that dispatches on version.
		expect(parseEventInput({ type: "OrderPlaced" }).v).toBe(1);
	});

	it("carries an explicit version", () => {
		expect(parseEventInput({ type: "OrderPlaced", v: 3 }).v).toBe(3);
	});

	it("refuses a version that is not a positive integer", () => {
		// Zero is not a version — the first is 1 — and a float or a negative
		// cannot order two schemas of the same type.
		for (const v of [0, -1, 1.5, Number.NaN, "2"]) {
			expect(() => parseEventInput({ type: "T", v })).toThrow(
				/event\.v must be a positive safe integer/u,
			);
		}
	});

	it("treats an explicit null version as absent, not as invalid", () => {
		// `source.v ?? 1` is nullish coalescing, so `null` takes the default
		// rather than reaching the check. Pinned because it is the one falsy
		// value that does *not* fail: `0` is refused and `null` becomes 1.
		//
		// Defensible — null and undefined both mean "not stated" in JSON — but
		// worth recording, because a reader scanning the validation list would
		// reasonably expect an explicitly-null version to be a caller error.
		expect(parseEventInput({ type: "T", v: null }).v).toBe(1);
	});

	it("refuses an event with no type", () => {
		// The type is what every consumer dispatches on. An untyped event is
		// stored forever and handled by nothing.
		for (const type of [undefined, "", null, 7, {}]) {
			expect(() => parseEventInput({ type })).toThrow(/event\.type/u);
		}
	});

	it("refuses an event that is not an object, including an array", () => {
		// An array passes a naive `typeof === "object"` check and would then read
		// `undefined` for every field, producing a type error that pointed at the
		// wrong problem.
		for (const value of [undefined, null, "OrderPlaced", 7, [], true]) {
			expect(() => parseEventInput(value)).toThrow(/event must be an object/u);
		}
	});

	it("defaults data and meta to empty objects", () => {
		// Not undefined: every consumer reads these, and one of them would forget
		// the nullish guard.
		const parsed = parseEventInput({ type: "T" });
		expect(parsed.data).toEqual({});
		expect(parsed.meta).toEqual({});
	});

	it("clones data rather than holding the caller's object", () => {
		// The property that makes an append final. A caller mutating its payload
		// after the call would otherwise change what the store holds — a write
		// that changed after it was made.
		const data = { total: 100, nested: { currency: "USD" } };
		const parsed = parseEventInput({ type: "T", data });
		data.total = 999;
		data.nested.currency = "EUR";
		expect((parsed.data as typeof data).total).toBe(100);
		expect((parsed.data as typeof data).nested.currency).toBe("USD");
	});

	it("clones meta deeply too", () => {
		const meta = { trace: { id: "t-1" } };
		const parsed = parseEventInput({ type: "T", meta });
		meta.trace.id = "t-2";
		expect((parsed.meta.trace as { id: string }).id).toBe("t-1");
	});

	it("lifts an idempotency key out of the metadata", () => {
		// Promoted to a field because the store dedupes on it. Leaving it buried
		// in `meta` would make every writer agree on a magic key name, and one
		// would misspell it — silently disabling deduplication.
		expect(
			parseEventInput({ type: "T", meta: { idempotencyKey: "k-1" } })
				.idempotencyKey,
		).toBe("k-1");
	});

	it("leaves the idempotency key undefined when there is none", () => {
		expect(parseEventInput({ type: "T" }).idempotencyKey).toBeUndefined();
	});

	it("refuses an idempotency key that is present but unusable", () => {
		// An empty or non-string key cannot dedupe anything. Accepting one would
		// look like deduplication was requested and silently do nothing.
		for (const idempotencyKey of ["", 7, null, {}]) {
			expect(() =>
				parseEventInput({ type: "T", meta: { idempotencyKey } }),
			).toThrow(/event\.meta\.idempotencyKey/u);
		}
	});
});

describe("parseEventInputs", () => {
	it("parses each event in a batch", () => {
		const parsed = parseEventInputs([{ type: "A" }, { type: "B", v: 2 }]);
		expect(parsed.map((event) => event.type)).toEqual(["A", "B"]);
		expect(parsed[1]?.v).toBe(2);
	});

	it("refuses an empty batch", () => {
		// An append of nothing would still take the stream lock and bump nothing.
		// Refusing makes the caller's mistake visible where they made it.
		expect(() => parseEventInputs([])).toThrow(/non-empty array/u);
	});

	it("refuses a value that is not an array", () => {
		for (const value of [undefined, null, { type: "A" }, "A", 7]) {
			expect(() => parseEventInputs(value)).toThrow(/non-empty array/u);
		}
	});

	it("refuses the whole batch when any event is malformed", () => {
		// All-or-nothing, and correctly so: an append is atomic, so partially
		// accepting a batch would write a stream that is missing an event its
		// neighbours refer to.
		expect(() => parseEventInputs([{ type: "A" }, { type: "" }])).toThrow(
			TypeError,
		);
	});
});

describe("parseAppendContext", () => {
	it("returns a frozen context", () => {
		expect(Object.isFrozen(parseAppendContext("orders-1", CONTEXT))).toBe(true);
	});

	it("carries the stream, sequence, actor, and tenant", () => {
		const parsed = parseAppendContext("orders-1", CONTEXT);
		expect(parsed.streamId).toBe("orders-1");
		expect(parsed.expectedSeq).toBe(0);
		expect(parsed.actor).toEqual(ACTOR);
		expect(parsed.tenant).toBe("acme");
	});

	it("refuses options that are not an object, including an array", () => {
		for (const value of [undefined, null, [], "acme", 7]) {
			expect(() => parseAppendContext("orders-1", value)).toThrow(
				/appendOptions must be an object/u,
			);
		}
	});

	it("refuses a missing or malformed actor", () => {
		// The actor is who the write is attributed to. An append with no actor is
		// unattributable forever, since the event is immutable once written.
		for (const actor of [undefined, null, [], "user-1", 7]) {
			expect(() =>
				parseAppendContext("orders-1", { ...CONTEXT, actor }),
			).toThrow(/appendOptions\.actor must be an object/u);
		}
	});

	it("refuses a missing tenant", () => {
		// The tenant scopes the stream. An empty one would write into a shared
		// namespace where another tenant could read it.
		for (const tenant of [undefined, "", null, 7]) {
			expect(() =>
				parseAppendContext("orders-1", { ...CONTEXT, tenant }),
			).toThrow(/appendOptions\.tenant/u);
		}
	});

	it("leaves the optional correlation fields undefined when absent", () => {
		// Absent rather than empty strings, so a reader can tell "no correlation
		// id" from "an empty one", which are different facts about a trace.
		const parsed = parseAppendContext("orders-1", CONTEXT);
		expect(parsed.project).toBeUndefined();
		expect(parsed.causationId).toBeUndefined();
		expect(parsed.correlationId).toBeUndefined();
		expect(parsed.lane).toBeUndefined();
	});

	it("carries the optional correlation fields when supplied", () => {
		const parsed = parseAppendContext("orders-1", {
			...CONTEXT,
			project: "shop",
			causationId: "c-1",
			correlationId: "r-1",
			lane: "primary",
		});
		expect(parsed.project).toBe("shop");
		expect(parsed.causationId).toBe("c-1");
		expect(parsed.correlationId).toBe("r-1");
		expect(parsed.lane).toBe("primary");
	});

	it("refuses an optional field that is present but empty", () => {
		// Present-and-empty is a caller mistake, not an omission. Accepting it
		// would write a correlation id that joins to nothing and looks like one
		// that should.
		for (const field of [
			"project",
			"causationId",
			"correlationId",
			"lane",
		] as const) {
			expect(() =>
				parseAppendContext("orders-1", { ...CONTEXT, [field]: "" }),
			).toThrow(new RegExp(`appendOptions\\.${field}`, "u"));
		}
	});
});

describe("fence tokens", () => {
	it("leaves an absent fence token undefined", () => {
		// Fencing is optional. Defaulting to zero would make an unfenced append
		// look like one holding the lowest possible fence, which a writer holding
		// a real fence would then beat.
		expect(parseAppendContext("orders-1", CONTEXT).fenceToken).toBeUndefined();
	});

	it("accepts a bigint fence token", () => {
		expect(
			parseAppendContext("orders-1", { ...CONTEXT, fenceToken: 7n }).fenceToken,
		).toBe(7n);
	});

	it("accepts zero, the lowest valid fence", () => {
		expect(
			parseAppendContext("orders-1", { ...CONTEXT, fenceToken: 0n }).fenceToken,
		).toBe(0n);
	});

	it("widens a safe-integer number to a bigint", () => {
		// Callers reading a fence out of JSON get a number. Keeping it a number
		// would lose precision above 2^53 — exactly where two fences stop being
		// distinguishable, which is the one thing a fence must never do.
		const parsed = parseAppendContext("orders-1", {
			...CONTEXT,
			fenceToken: 42,
		});
		expect(parsed.fenceToken).toBe(42n);
		expect(typeof parsed.fenceToken).toBe("bigint");
	});

	it("parses a decimal string fence token", () => {
		// The lossless JSON representation: a fence past 2^53 has to travel as a
		// string, so the string form is the *precise* one, not a fallback.
		expect(
			parseAppendContext("orders-1", {
				...CONTEXT,
				fenceToken: "9007199254740993",
			}).fenceToken,
		).toBe(9007199254740993n);
	});

	it("refuses a negative fence token in either representation", () => {
		for (const fenceToken of [-1n, -1]) {
			expect(() =>
				parseAppendContext("orders-1", { ...CONTEXT, fenceToken }),
			).toThrow(/fenceToken/u);
		}
	});

	it("refuses a string fence token that is not a canonical integer", () => {
		// `^(0|[1-9]\d*)$` — no leading zeros, no sign, no whitespace, no
		// decimal point. Two spellings of one fence would compare unequal as
		// strings and let a stale writer past a check that looked correct.
		for (const fenceToken of [
			"007",
			"-1",
			" 1",
			"1 ",
			"1.0",
			"1e3",
			"",
			"0x10",
			"+1",
		]) {
			expect(() =>
				parseAppendContext("orders-1", { ...CONTEXT, fenceToken }),
			).toThrow(/fenceToken/u);
		}
	});

	it("accepts a plain zero string but not a padded one", () => {
		expect(
			parseAppendContext("orders-1", { ...CONTEXT, fenceToken: "0" })
				.fenceToken,
		).toBe(0n);
		expect(() =>
			parseAppendContext("orders-1", { ...CONTEXT, fenceToken: "00" }),
		).toThrow(/fenceToken/u);
	});

	it("refuses a fractional or unsafe number fence token", () => {
		for (const fenceToken of [
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(() =>
				parseAppendContext("orders-1", { ...CONTEXT, fenceToken }),
			).toThrow(/fenceToken/u);
		}
	});

	it("refuses a fence token of an unrelated type", () => {
		for (const fenceToken of [null, {}, [], true]) {
			expect(() =>
				parseAppendContext("orders-1", { ...CONTEXT, fenceToken }),
			).toThrow(/fenceToken/u);
		}
	});
});
