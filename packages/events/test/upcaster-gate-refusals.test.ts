/**
 * Each way the upcaster gate can refuse, and the codec underneath it.
 *
 * `upcaster-gate.test.ts` walks the promoted three-version proof end to end and
 * asserts the gate passes. That is the happy path, and it is the half that
 * cannot tell you anything: a gate that returned `ok: true` unconditionally
 * would pass it. This file drives the refusals instead — one test per reason
 * the gate can say no, so removing a check is a failure rather than a silently
 * wider door.
 *
 * The gate runs five independent checks, and each guards a different way a
 * shipped event body stops being readable:
 *
 * 1. **Coverage** — every shipped version has a pinned body. Without it, a
 *    version bump ships with nothing proving its bodies can still be read.
 * 2. **Append-only** — a baseline entry may never vanish or change digest.
 *    Editing a pinned body is how a real historical shape gets quietly replaced
 *    with one that happens to still parse.
 * 3. **Totality** — every version below current has exactly the next-step
 *    upcaster. A gap means events at that version are unreadable forever, and
 *    they are already on disk.
 * 4. **Purity** — the same input twice gives the same output. An upcaster that
 *    reads a clock or a counter makes replay non-deterministic, and replay is
 *    the only way old events ever become new ones.
 * 5. **Golden replay** — every pinned body actually lifts to current.
 *
 * The codec gets its own attention because it is hand-rolled protobuf. A
 * varint bug does not throw, it silently decodes a different number.
 */
import { describe, expect, it } from "vitest";

import {
	CORPUS_BASELINE_SCHEMA,
	CORPUS_ENTRY_SCHEMA,
	createCorpusBaseline,
	createCorpusEntry,
	decodeEventBody,
	type EventBody,
	type EventEvolutionContract,
	encodeEventBody,
	eventSchema,
	messageField,
	repeatedMessageField,
	runCanDeployUpcasterGate,
	stringField,
	u32Field,
	u64Field,
	validateEventBody,
} from "../src/upcaster.js";

const TYPE = "ticket.Opened";

const V1 = eventSchema(TYPE, 1, [
	stringField("ticketId", 1),
	stringField("summary", 2),
]);
const V2 = eventSchema(TYPE, 2, [
	stringField("ticketId", 1),
	stringField("title", 2),
]);

/** A healthy two-version contract; each test breaks exactly one thing. */
function contract(
	overrides: Partial<EventEvolutionContract> = {},
): EventEvolutionContract {
	return {
		type: TYPE,
		currentVersion: 2,
		schemas: [V1, V2],
		upcasters: [
			{
				type: TYPE,
				from: 1,
				to: 2,
				reason: "summary renamed to title",
				upcast: (body) => ({
					ticketId: body.ticketId,
					title: body.summary,
				}),
			},
		],
		goldenCorpus: [
			createCorpusEntry(V1, "first", { ticketId: "T-1", summary: "boom" }),
			createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
		],
		...overrides,
	};
}

function errorsOf(
	input: Parameters<typeof runCanDeployUpcasterGate>[0],
	options = {},
) {
	return runCanDeployUpcasterGate(input, options).errors.join(" | ");
}

describe("a healthy contract", () => {
	it("passes", () => {
		const report = runCanDeployUpcasterGate(contract());
		expect(report.ok).toBe(true);
		expect(report.errors).toEqual([]);
	});

	it("replays every pinned body", () => {
		expect(runCanDeployUpcasterGate(contract()).replays).toHaveLength(2);
	});

	it("lifts a v1 body all the way to current", () => {
		// The whole point: a body pinned two versions ago must come back as
		// something the current code can read.
		const report = runCanDeployUpcasterGate(contract());
		const lifted = report.replays.find((r) => r.sourceVersion === 1);
		expect(lifted?.currentVersion).toBe(2);
		expect(lifted?.currentBody).toEqual({ ticketId: "T-1", title: "boom" });
	});

	it("leaves a body already at current unchanged", () => {
		const report = runCanDeployUpcasterGate(contract());
		const current = report.replays.find((r) => r.sourceVersion === 2);
		expect(current?.currentBody).toEqual({ ticketId: "T-2", title: "bang" });
	});

	it("reports a digest of the re-encoded current body", () => {
		// Two bodies that lift to the same value must produce the same digest,
		// which is what lets a caller compare a replay against a live encoding.
		const report = runCanDeployUpcasterGate(contract());
		for (const replay of report.replays) {
			expect(replay.currentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		}
	});

	it("freezes the report", () => {
		const report = runCanDeployUpcasterGate(contract());
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.errors)).toBe(true);
	});
});

describe("check 1: corpus coverage", () => {
	it("refuses a shipped version with no pinned body", () => {
		// A version bump that ships without a corpus entry has nothing proving
		// its bodies can still be read — which is the entire purpose of the gate.
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
		);
		expect(errors).toContain(`missing golden corpus entry for ${TYPE}@v1`);
	});

	it("refuses an entirely empty corpus", () => {
		const errors = errorsOf(contract({ goldenCorpus: [] }));
		expect(errors).toContain("@v1");
		expect(errors).toContain("@v2");
	});

	it("names the version that is missing", () => {
		// With a dozen versions, "coverage failed" alone is not actionable.
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					createCorpusEntry(V1, "first", { ticketId: "T-1", summary: "boom" }),
				],
			}),
		);
		expect(errors).toContain("@v2");
		expect(errors).not.toContain("@v1");
	});

	it("does not count another event type's entry as coverage", () => {
		// Corpus entries carry their own type. Matching on version alone would
		// let one event's pinned body satisfy another's coverage.
		const otherSchema = eventSchema("other.Thing", 1, [stringField("id", 1)]);
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					createCorpusEntry(otherSchema, "x", { id: "1" }),
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
		);
		expect(errors).toContain(`missing golden corpus entry for ${TYPE}@v1`);
	});
});

describe("check 2: the corpus is append-only", () => {
	it("passes when the baseline is unchanged", () => {
		const healthy = contract();
		const baseline = createCorpusBaseline(healthy.goldenCorpus);
		expect(
			runCanDeployUpcasterGate(healthy, { baselineCorpus: baseline }).ok,
		).toBe(true);
	});

	it("refuses a deleted entry", () => {
		// A pinned body is evidence about a shape that really shipped. Deleting
		// it removes the only proof that shape is still readable.
		const baseline = createCorpusBaseline(contract().goldenCorpus);
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					createCorpusEntry(V1, "first", { ticketId: "T-1", summary: "boom" }),
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				].slice(0, 1),
			}),
			{ baselineCorpus: baseline },
		);
		expect(errors).toContain("append-only corpus deletion detected");
	});

	it("refuses an edited entry", () => {
		// The subtler half. Editing a pinned body quietly replaces a real
		// historical shape with one that happens to still parse — and the gate
		// then proves nothing about the bodies actually on disk.
		const baseline = createCorpusBaseline(contract().goldenCorpus);
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					createCorpusEntry(V1, "first", {
						ticketId: "T-1",
						summary: "edited",
					}),
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
			{ baselineCorpus: baseline },
		);
		expect(errors).toContain("append-only corpus digest changed");
	});

	it("names the entry that changed", () => {
		const baseline = createCorpusBaseline(contract().goldenCorpus);
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					createCorpusEntry(V1, "first", {
						ticketId: "T-1",
						summary: "edited",
					}),
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
			{ baselineCorpus: baseline },
		);
		expect(errors).toContain(`${TYPE}@v1#first`);
	});

	it("permits adding an entry", () => {
		// Append-only means append is allowed. Refusing new entries would make
		// the gate impossible to satisfy after any version bump.
		const baseline = createCorpusBaseline(contract().goldenCorpus);
		const widened = contract({
			goldenCorpus: [
				...contract().goldenCorpus,
				createCorpusEntry(V2, "third", { ticketId: "T-3", title: "extra" }),
			],
		});
		expect(
			runCanDeployUpcasterGate(widened, { baselineCorpus: baseline }).ok,
		).toBe(true);
	});

	it("skips the check entirely when no baseline is supplied", () => {
		// A first run has nothing to compare against, and treating that as a
		// deletion would fail every contract on the day it was introduced.
		expect(runCanDeployUpcasterGate(contract()).ok).toBe(true);
	});

	it("builds a baseline keyed by type, version and id", () => {
		const baseline = createCorpusBaseline(contract().goldenCorpus);
		expect(baseline.schema).toBe(CORPUS_BASELINE_SCHEMA);
		expect(baseline.entries.map((e) => e.key)).toEqual([
			`${TYPE}@v1#first`,
			`${TYPE}@v2#second`,
		]);
	});

	it("freezes the baseline it builds", () => {
		const baseline = createCorpusBaseline(contract().goldenCorpus);
		expect(Object.isFrozen(baseline)).toBe(true);
		expect(Object.isFrozen(baseline.entries)).toBe(true);
	});
});

describe("check 3: the upcaster chain is total", () => {
	it("refuses a missing step", () => {
		// Events at that version are already on disk. A gap means they are
		// unreadable forever, and nothing else in the system would notice until
		// somebody replayed one.
		const errors = errorsOf(contract({ upcasters: [] }));
		expect(errors).toContain("non-total upcaster chain");
		expect(errors).toContain("missing 1->2");
	});

	it("refuses an upcaster that skips a version", () => {
		// A 1->3 upcaster leaves v2 bodies with no path. Accepting it because
		// "there is an upcaster from 1" would silently strand a whole version.
		const V3 = eventSchema(TYPE, 3, [
			stringField("ticketId", 1),
			stringField("title", 2),
		]);
		const errors = errorsOf(
			contract({
				currentVersion: 3,
				schemas: [V1, V2, V3],
				upcasters: [
					{
						type: TYPE,
						from: 1,
						to: 3,
						reason: "skips v2",
						upcast: (body) => ({
							ticketId: body.ticketId,
							title: body.summary,
						}),
					},
				],
				goldenCorpus: [
					createCorpusEntry(V1, "first", { ticketId: "T-1", summary: "boom" }),
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
					createCorpusEntry(V3, "third", { ticketId: "T-3", title: "pow" }),
				],
			}),
		);
		expect(errors).toContain("missing 1->2");
	});

	it("does not require an upcaster from the current version", () => {
		// There is nothing above current to lift to. Demanding one would make
		// every contract permanently unsatisfiable.
		expect(runCanDeployUpcasterGate(contract()).ok).toBe(true);
	});

	it("names the version the chain breaks at", () => {
		const errors = errorsOf(contract({ upcasters: [] }));
		expect(errors).toContain(`${TYPE}@v1`);
	});
});

describe("check 4: upcasters are pure", () => {
	it("refuses one whose output varies between calls", () => {
		// Replay is the only way an old event ever becomes a new one. An
		// upcaster that reads a clock or a counter makes that non-deterministic,
		// so two replays of one event produce two different current bodies.
		let counter = 0;
		const errors = errorsOf(
			contract({
				upcasters: [
					{
						type: TYPE,
						from: 1,
						to: 2,
						reason: "impure",
						upcast: (body) => {
							counter += 1;
							return { ticketId: body.ticketId, title: `${counter}` };
						},
					},
				],
			}),
		);
		expect(errors).toContain("impure upcaster");
	});

	it("refuses one that throws", () => {
		const errors = errorsOf(
			contract({
				upcasters: [
					{
						type: TYPE,
						from: 1,
						to: 2,
						reason: "throws",
						upcast: () => {
							throw new Error("nope");
						},
					},
				],
			}),
		);
		expect(errors).toContain("purity check threw");
		expect(errors).toContain("nope");
	});

	it("refuses one that mutates its input", () => {
		// The input is deep-frozen before the call, so an upcaster reaching for
		// its argument throws in strict mode. Catching that here is what stops a
		// shared body being corrupted mid-replay.
		const errors = errorsOf(
			contract({
				upcasters: [
					{
						type: TYPE,
						from: 1,
						to: 2,
						reason: "mutates",
						upcast: (body) => {
							// SAFETY: the test intentionally mutates the frozen EventBody contract.
							(body as EventBody).summary = "clobbered";
							return { ticketId: body.ticketId, title: body.summary };
						},
					},
				],
			}),
		);
		expect(errors).toContain("purity check threw");
	});

	it("refuses one whose output does not validate against the target", () => {
		// A pure upcaster producing the wrong shape is still a broken upcaster.
		// Without this, the failure would only surface at the replay step, and
		// only for versions that happen to have a pinned body.
		const errors = errorsOf(
			contract({
				upcasters: [
					{
						type: TYPE,
						from: 1,
						to: 2,
						reason: "wrong shape",
						upcast: (body) => ({ ticketId: body.ticketId }),
					},
				],
			}),
		);
		expect(errors).toContain("produced invalid v2 body");
	});

	it("names the failing field in the shape error", () => {
		const errors = errorsOf(
			contract({
				upcasters: [
					{
						type: TYPE,
						from: 1,
						to: 2,
						reason: "wrong shape",
						upcast: (body) => ({ ticketId: body.ticketId }),
					},
				],
			}),
		);
		expect(errors).toContain("title must be a string");
	});
});

describe("check 5: golden replay", () => {
	it("refuses a corpus entry whose digest does not match its bytes", () => {
		// The digest is what makes an entry tamper-evident. A body edited without
		// updating it is caught here even when no baseline was supplied.
		const good = createCorpusEntry(V1, "first", {
			ticketId: "T-1",
			summary: "boom",
		});
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					{ ...good, bodyDigest: `sha256:${"0".repeat(64)}` },
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
		);
		expect(errors).toContain("digest mismatch");
	});

	it("refuses an entry at a version with no registered schema", () => {
		const orphan = createCorpusEntry(
			eventSchema(TYPE, 9, [stringField("ticketId", 1)]),
			"orphan",
			{ ticketId: "T-9" },
		);
		const errors = errorsOf(
			contract({ goldenCorpus: [...contract().goldenCorpus, orphan] }),
		);
		expect(errors).toContain("no schema registered for v9");
	});

	it("refuses an unsupported encoding", () => {
		// The encoding names how to read the bytes. Guessing would decode a body
		// from a future format as garbage that might still validate.
		const good = createCorpusEntry(V1, "first", {
			ticketId: "T-1",
			summary: "boom",
		});
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					// SAFETY: the test injects an unsupported encoding to exercise rejection.
					{ ...good, encoding: "cbor" as never },
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
		);
		expect(errors).toContain("unsupported corpus encoding cbor");
	});

	it("reports which entry failed", () => {
		const good = createCorpusEntry(V1, "first", {
			ticketId: "T-1",
			summary: "boom",
		});
		const errors = errorsOf(
			contract({
				goldenCorpus: [
					{ ...good, bodyDigest: `sha256:${"0".repeat(64)}` },
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
		);
		expect(errors).toContain(`${TYPE}@v1#first replay failed`);
	});

	it("keeps replaying after one entry fails", () => {
		// A gate that stopped at the first failure would report one problem per
		// run, and a corpus with three broken entries would take three CI cycles
		// to fix.
		const good = createCorpusEntry(V1, "first", {
			ticketId: "T-1",
			summary: "boom",
		});
		const report = runCanDeployUpcasterGate(
			contract({
				goldenCorpus: [
					{ ...good, bodyDigest: `sha256:${"0".repeat(64)}` },
					createCorpusEntry(V2, "second", { ticketId: "T-2", title: "bang" }),
				],
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.replays).toHaveLength(1);
	});
});

describe("validating a body against its schema", () => {
	it("accepts a well-formed body", () => {
		expect(validateEventBody(V1, { ticketId: "T", summary: "s" }).ok).toBe(
			true,
		);
	});

	it("refuses something that is not an object", () => {
		expect(validateEventBody(V1, "nope").ok).toBe(false);
		expect(validateEventBody(V1, null).ok).toBe(false);
	});

	it("refuses an array, which is an object but not a body", () => {
		expect(validateEventBody(V1, []).ok).toBe(false);
	});

	it("refuses a field of the wrong type", () => {
		const result = validateEventBody(V1, { ticketId: 1, summary: "s" });
		expect(result.errors.join()).toContain("ticketId must be a string");
	});

	it("refuses an undeclared field", () => {
		// An extra field is a body from a version this schema does not describe.
		// Ignoring it would let a v2 body validate as v1 and then lose data on
		// re-encode.
		const result = validateEventBody(V1, {
			ticketId: "T",
			summary: "s",
			extra: "x",
		});
		expect(result.errors.join()).toContain("extra is not declared");
	});

	it("refuses a negative u32", () => {
		const schema = eventSchema("t", 1, [u32Field("count", 1)]);
		expect(validateEventBody(schema, { count: -1 }).ok).toBe(false);
	});

	it("refuses a fractional u32", () => {
		// The wire format is a varint. A fraction would encode as something else
		// entirely and decode back as a different number.
		const schema = eventSchema("t", 1, [u32Field("count", 1)]);
		expect(validateEventBody(schema, { count: 1.5 }).ok).toBe(false);
	});

	it("accepts zero as a u32", () => {
		const schema = eventSchema("t", 1, [u32Field("count", 1)]);
		expect(validateEventBody(schema, { count: 0 }).ok).toBe(true);
	});

	it("permits an omitted optional field", () => {
		const schema = eventSchema("t", 1, [
			stringField("id", 1),
			stringField("note", 2, { required: false }),
		]);
		expect(validateEventBody(schema, { id: "x" }).ok).toBe(true);
	});

	it("still type-checks an optional field that is present", () => {
		// Optional means "may be absent", not "may be anything".
		const schema = eventSchema("t", 1, [
			stringField("id", 1),
			stringField("note", 2, { required: false }),
		]);
		expect(validateEventBody(schema, { id: "x", note: 7 }).ok).toBe(false);
	});

	it("reports every problem at once", () => {
		const result = validateEventBody(V1, { ticketId: 1, extra: "x" });
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
	});
});

describe("the wire codec", () => {
	function roundTrip(schema: typeof V1, body: EventBody): EventBody {
		return decodeEventBody(schema, encodeEventBody(schema, body));
	}

	it("round-trips a string body", () => {
		expect(roundTrip(V1, { ticketId: "T-1", summary: "boom" })).toEqual({
			ticketId: "T-1",
			summary: "boom",
		});
	});

	it("round-trips multi-byte text", () => {
		// The length prefix counts bytes, not characters. Counting characters
		// would truncate every non-ASCII body mid-sequence.
		const body = { ticketId: "T-1", summary: "héllo · 漢字 · 🔑" };
		expect(roundTrip(V1, body)).toEqual(body);
	});

	it("round-trips an empty string", () => {
		expect(roundTrip(V1, { ticketId: "", summary: "" })).toEqual({
			ticketId: "",
			summary: "",
		});
	});

	it("round-trips a u32 across the varint boundary", () => {
		// 127 fits one byte, 128 needs two. This is where a hand-rolled varint
		// goes wrong, and it goes wrong silently — the value decodes as a
		// different number rather than failing.
		const schema = eventSchema("t", 1, [u32Field("count", 1)]);
		for (const count of [0, 1, 127, 128, 129, 16_383, 16_384, 2 ** 31]) {
			// SAFETY: roundTrip is intentionally given a schema-shaped test double.
			expect(roundTrip(schema as never, { count })).toEqual({ count });
		}
	});

	it("round-trips uint64 without losing precision", () => {
		const schema = eventSchema("t", 1, [u64Field("sequence", 1)]);
		for (const sequence of [0n, 127n, 128n, 2n ** 53n, 2n ** 64n - 1n]) {
			// SAFETY: the shared roundTrip helper accepts the narrower V1 test shape.
			expect(roundTrip(schema as never, { sequence })).toEqual({ sequence });
		}
		expect(validateEventBody(schema, { sequence: -1n }).ok).toBe(false);
		expect(validateEventBody(schema, { sequence: 2n ** 64n }).ok).toBe(false);
	});

	it("round-trips nested and repeated nested message bytes", () => {
		const schema = eventSchema("t", 1, [
			messageField("message", 1),
			repeatedMessageField("messages", 2),
		]);
		const body = {
			message: Uint8Array.from([8, 1]),
			messages: [Uint8Array.from([8, 2]), Uint8Array.from([8, 3])],
		};
		// SAFETY: the shared roundTrip helper accepts the narrower V1 test shape.
		expect(roundTrip(schema as never, body)).toEqual(body);
		expect(
			validateEventBody(schema, { message: "not bytes", messages: [] }).ok,
		).toBe(false);
		expect(
			validateEventBody(schema, {
				message: Uint8Array.from([8, 1]),
				messages: ["not bytes"],
			}).ok,
		).toBe(false);
	});

	it("encodes fields in tag order regardless of key order", () => {
		// The digest is taken over the bytes. If key order leaked into the
		// encoding, the same body would hash two ways and the append-only check
		// would fire on an unchanged entry.
		const a = encodeEventBody(V1, { ticketId: "T", summary: "s" });
		const b = encodeEventBody(V1, { summary: "s", ticketId: "T" });
		expect(a.equals(b)).toBe(true);
	});

	it("omits an absent optional field rather than encoding a placeholder", () => {
		const schema = eventSchema("t", 1, [
			stringField("id", 1),
			stringField("note", 2, { required: false }),
		]);
		const withNote = encodeEventBody(schema, { id: "x", note: "n" });
		const without = encodeEventBody(schema, { id: "x" });
		expect(without.length).toBeLessThan(withNote.length);
		expect(decodeEventBody(schema, without)).toEqual({ id: "x" });
	});

	it("refuses to encode a body that does not validate", () => {
		// Encoding an invalid body would pin it into the corpus as evidence of a
		// shape that was never legal.
		// SAFETY: the test intentionally passes an invalid body to exercise validation.
		expect(() => encodeEventBody(V1, { ticketId: 1 } as never)).toThrow(
			/must be a string/u,
		);
	});

	it("refuses an unknown field tag on decode", () => {
		// A tag this schema does not declare is a body from another version.
		// Skipping it would decode a partial body that then validates.
		const other = eventSchema(TYPE, 1, [
			stringField("ticketId", 1),
			stringField("summary", 2),
			stringField("extra", 9),
		]);
		const bytes = encodeEventBody(other, {
			ticketId: "T",
			summary: "s",
			extra: "x",
		});
		expect(() => decodeEventBody(V1, bytes)).toThrow(
			/unknown protobuf field tag 9/u,
		);
	});

	it("refuses a wire type that contradicts the field", () => {
		// A u32 arriving where a string is declared means the schemas disagree
		// about what tag 2 is. Reading it anyway produces a plausible wrong value.
		const asNumber = eventSchema(TYPE, 1, [
			stringField("ticketId", 1),
			u32Field("summary", 2),
		]);
		const bytes = encodeEventBody(asNumber, { ticketId: "T", summary: 5 });
		expect(() => decodeEventBody(V1, bytes)).toThrow(/wire type/u);
	});

	it("refuses an unterminated varint", () => {
		// A truncated file ends mid-varint. Returning the partial value would
		// decode a smaller number and carry on as if nothing happened.
		const schema = eventSchema("t", 1, [u32Field("count", 1)]);
		const bytes = encodeEventBody(schema, { count: 300 });
		expect(() =>
			decodeEventBody(schema, bytes.subarray(0, bytes.length - 1)),
		).toThrow(/unterminated protobuf varint/u);
	});

	it("decodes an empty buffer as an empty body", () => {
		// A body with every field optional and none set encodes to nothing.
		const schema = eventSchema("t", 1, [
			stringField("note", 1, { required: false }),
		]);
		expect(decodeEventBody(schema, Buffer.alloc(0))).toEqual({});
	});
});

describe("pinning a corpus entry", () => {
	it("stamps the schema, type and version", () => {
		const entry = createCorpusEntry(V1, "first", {
			ticketId: "T-1",
			summary: "boom",
		});
		expect(entry.schema).toBe(CORPUS_ENTRY_SCHEMA);
		expect(entry.type).toBe(TYPE);
		expect(entry.version).toBe(1);
	});

	it("digests the encoded bytes, not the object", () => {
		// Digesting the object would make the pin sensitive to key order and
		// blind to an encoding change — the opposite of what it is for.
		const a = createCorpusEntry(V1, "x", { ticketId: "T", summary: "s" });
		const b = createCorpusEntry(V1, "x", { summary: "s", ticketId: "T" });
		expect(a.bodyDigest).toBe(b.bodyDigest);
	});

	it("gives different bodies different digests", () => {
		const a = createCorpusEntry(V1, "x", { ticketId: "T", summary: "s" });
		const b = createCorpusEntry(V1, "x", { ticketId: "T", summary: "t" });
		expect(a.bodyDigest).not.toBe(b.bodyDigest);
	});

	it("refuses to pin a body that does not validate", () => {
		expect(() =>
			// SAFETY: the test intentionally passes an invalid body to exercise validation.
			createCorpusEntry(V1, "bad", { ticketId: "T" } as never),
		).toThrow(/must be a string/u);
	});

	it("freezes the entry", () => {
		const entry = createCorpusEntry(V1, "first", {
			ticketId: "T-1",
			summary: "boom",
		});
		expect(Object.isFrozen(entry)).toBe(true);
	});
});

describe("schema and field builders", () => {
	it("freezes a schema and its field list", () => {
		expect(Object.isFrozen(V1)).toBe(true);
		expect(Object.isFrozen(V1.fields)).toBe(true);
	});

	it("copies the field list rather than sharing the caller's array", () => {
		// A shared array would let a caller add a field to a schema after other
		// code had already validated bodies against it.
		const fields = [stringField("id", 1)];
		const schema = eventSchema("t", 1, fields);
		fields.push(stringField("extra", 2));
		expect(schema.fields).toHaveLength(1);
	});

	it("makes fields required by default", () => {
		expect(stringField("id", 1).required).toBe(true);
		expect(u32Field("n", 1).required).toBe(true);
	});

	it("treats only an explicit false as optional", () => {
		// `required: undefined` from a partially-built options object must not
		// silently make a field optional.
		expect(stringField("id", 1, {}).required).toBe(true);
		expect(stringField("id", 1, { required: false }).required).toBe(false);
	});
});
