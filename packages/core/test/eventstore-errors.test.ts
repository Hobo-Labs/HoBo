/**
 * EventStore parse refusals, typed errors and the cross-store predicates.
 *
 * The predicates are the interesting part. `isOptimisticConflict` and
 * `isStaleFence` exist because the same conflict can arrive as an instance
 * from `@hobo/core`, as a structurally-similar error from a driver that was
 * loaded from a second copy of the package (so `instanceof` is false), or as a
 * bare `{ code }` from a worker that lost the prototype crossing a
 * `postMessage` boundary. A retry loop that misses any of those three shapes
 * turns a routine concurrency conflict into a failed command — which is the
 * defect this file is here to prevent.
 */
import { describe, expect, it } from "vitest";

import {
	CheckpointRegressionError,
	EVENTSTORE_LIMITS,
	EventStoreError,
	EventStoreParseError,
	eventPositionToText,
	FENCING_COMPAT,
	fenceTokenToText,
	isOptimisticConflict,
	isStaleFence,
	MissingFenceError,
	OptimisticSequenceConflictError,
	PersistenceUnavailableError,
	parseEventPosition,
	parseFenceToken,
	parsePartitionId,
	parseSubscriptionId,
	SnapshotAheadError,
	SqliteBusyError,
	StaleFenceError,
	StorageWorkerTerminatedError,
	UnsupportedSchemaVersionError,
} from "../src/ports/eventstore.js";

describe("parseEventPosition / parseFenceToken", () => {
	const parsers = [
		["parseEventPosition", parseEventPosition, "position"],
		["parseFenceToken", parseFenceToken, "fenceToken"],
	] as const;

	for (const [label, parse, defaultPath] of parsers) {
		describe(label, () => {
			it("accepts a bigint unchanged", () => {
				expect(parse(7n)).toBe(7n);
			});

			it("accepts zero in every accepted representation", () => {
				// Zero is the legitimate starting position and the unfenced epoch,
				// so a `> 0` check anywhere here would reject a fresh stream.
				expect(parse(0n)).toBe(0n);
				expect(parse(0)).toBe(0n);
				expect(parse("0")).toBe(0n);
			});

			it("widens a safe-integer number to bigint", () => {
				// Numbers arrive from JSON. Widening at the boundary is what keeps
				// the rest of the code free to assume bigint and never risk the
				// precision loss that a late `Number` coercion would introduce.
				expect(parse(42)).toBe(42n);
				expect(parse(42)).toBeTypeOf("bigint");
			});

			it("parses a decimal string beyond MAX_SAFE_INTEGER", () => {
				// The reason strings are accepted at all: a 64-bit position cannot
				// survive JSON as a number, so drivers send it as text.
				expect(parse("9007199254740993")).toBe(9_007_199_254_740_993n);
			});

			it("refuses a negative bigint, naming what it wanted", () => {
				try {
					parse(-1n);
					expect.unreachable("a negative bigint must be refused");
				} catch (error) {
					// SAFETY: parse(-1n) above establishes the parser error type.
					const parseError = error as EventStoreParseError;
					// The bigint branch has its own message, because "non-negative
					// bigint" tells the caller the type was fine and the value was not.
					expect(parseError.expected).toBe("non-negative bigint");
					expect(parseError.path).toBe(defaultPath);
					expect(parseError.code).toBe("HOBO_CORE_EVENTSTORE_PARSE");
				}
			});

			it("refuses a negative number and a negative string", () => {
				expect(() => parse(-1)).toThrow(EventStoreParseError);
				expect(() => parse("-1")).toThrow(EventStoreParseError);
			});

			it("refuses a fractional or unsafe number", () => {
				// `Number.isSafeInteger` rather than `Number.isInteger`: 2**53 is an
				// integer but no longer round-trips, so widening it to bigint would
				// silently produce a position adjacent to the real one.
				for (const bad of [
					1.5,
					Number.NaN,
					Number.POSITIVE_INFINITY,
					2 ** 53,
				]) {
					expect(() => parse(bad)).toThrow(EventStoreParseError);
				}
			});

			it("refuses a string with a leading zero", () => {
				// The regex is `^(0|[1-9]\d*)$`, so "007" is refused rather than
				// normalized. Two spellings of the same position would otherwise
				// compare unequal as strings while comparing equal as bigints —
				// the kind of split that breaks a dedupe keyed on the text form.
				expect(() => parse("007")).toThrow(EventStoreParseError);
				expect(() => parse("0x10")).toThrow(EventStoreParseError);
				expect(() => parse("1e3")).toThrow(EventStoreParseError);
				expect(() => parse("")).toThrow(EventStoreParseError);
				expect(() => parse(" 1")).toThrow(EventStoreParseError);
			});

			it("refuses every other type", () => {
				for (const bad of [null, undefined, {}, [], true, Symbol("x")]) {
					expect(() => parse(bad)).toThrow(EventStoreParseError);
				}
			});

			it("reports the caller's path when one is given", () => {
				// Positions appear in nested request shapes; a refusal that always
				// said "position" would not say *which* one.
				try {
					parse(-1, "commit.after");
					expect.unreachable("expected a refusal");
				} catch (error) {
					// SAFETY: parse(-1, ...) above establishes the parser error type.
					expect((error as EventStoreParseError).path).toBe("commit.after");
				}
			});
		});
	}
});

describe("parseSubscriptionId / parsePartitionId", () => {
	it("accept non-empty strings", () => {
		expect(parseSubscriptionId("projector-1")).toBe("projector-1");
		expect(parsePartitionId("p0")).toBe("p0");
	});

	it("refuse empty strings and non-strings, each naming its own field", () => {
		// These two identify the lease a subscription holds. An empty one would
		// collide across every subscription that also got it wrong, so two
		// projectors would fight over one lease believing they were separate.
		for (const bad of ["", null, undefined, 7, {}]) {
			try {
				parseSubscriptionId(bad);
				expect.unreachable("expected a refusal");
			} catch (error) {
				// SAFETY: parseSubscriptionId(bad) above establishes the parser error type.
				expect((error as EventStoreParseError).path).toBe("subscriptionId");
			}
			try {
				parsePartitionId(bad);
				expect.unreachable("expected a refusal");
			} catch (error) {
				// SAFETY: parsePartitionId(bad) above establishes the parser error type.
				expect((error as EventStoreParseError).path).toBe("partitionId");
			}
		}
	});

	it("do not trim, so a padded id stays padded", () => {
		// Pinned rather than changed: these ids are storage keys, and silently
		// rewriting one would make a lookup miss a lease that already exists.
		expect(parsePartitionId(" p0 ")).toBe(" p0 ");
	});
});

describe("fenceTokenToText / eventPositionToText", () => {
	it("render base ten without a bigint suffix", () => {
		// Explicitly `toString(10)`. The default `String(1n)` also gives "1", but
		// these values are written into SQL and JSON where a stray "n" would be
		// a corrupt row rather than a type error.
		expect(fenceTokenToText(42n)).toBe("42");
		expect(eventPositionToText(0n)).toBe("0");
		expect(eventPositionToText(9_007_199_254_740_993n)).toBe(
			"9007199254740993",
		);
	});

	it("round-trip through their parsers", () => {
		const big = 18_446_744_073_709_551_615n;
		expect(parseEventPosition(eventPositionToText(big))).toBe(big);
		expect(parseFenceToken(fenceTokenToText(big))).toBe(big);
	});
});

describe("typed errors", () => {
	it("OptimisticSequenceConflictError states both sequences", () => {
		// Both numbers, because the gap between them is what tells a caller
		// whether to retry once or to re-read the stream from scratch.
		const error = new OptimisticSequenceConflictError("stream-1", 3, 7);
		expect(error.code).toBe("OPTIMISTIC_SEQUENCE_CONFLICT");
		expect(error.name).toBe("OptimisticSequenceConflictError");
		expect(error.streamId).toBe("stream-1");
		expect(error.expectedSeq).toBe(3);
		expect(error.actualSeq).toBe(7);
		expect(error.message).toBe(
			"stale expectedSeq for stream-1: expected 3, actual 7",
		);
	});

	it("StaleFenceError states provided and stored epochs", () => {
		const error = new StaleFenceError("stream-1", 1n, 2n);
		expect(error.code).toBe("STALE_FENCE");
		expect(error.provided).toBe(1n);
		expect(error.stored).toBe(2n);
		expect(error.message).toBe(
			"stale fence for stream-1: provided 1, stored 2",
		);
	});

	it("MissingFenceError reports the stored epoch that made fencing required", () => {
		// The stored epoch is the actionable part: it says the stream has already
		// entered fenced mode, so the fix is to acquire a fence, not to retry.
		const error = new MissingFenceError("stream-1", 5n);
		expect(error.code).toBe("MISSING_FENCE");
		expect(error.stored).toBe(5n);
		expect(error.message).toContain("owner_epoch=5");
	});

	it("SnapshotAheadError names the snapshot and head sequences", () => {
		const error = new SnapshotAheadError("stream-1", 10, 4);
		expect(error.code).toBe("SNAPSHOT_AHEAD");
		expect(error.snapshotSeq).toBe(10);
		expect(error.headSeq).toBe(4);
		expect(error.message).toBe("snapshot seq 10 is ahead of stream-1@4");
	});

	it("CheckpointRegressionError names the subscription, partition and both positions", () => {
		// A regression means a projector tried to move its checkpoint backwards,
		// which would replay events downstream consumers already saw. All four
		// values are needed to tell an accidental restart from a deliberate reset.
		const error = new CheckpointRegressionError("proj", "p0", 5n, 9n);
		expect(error.code).toBe("CHECKPOINT_REGRESSION");
		expect(error.subscriptionId).toBe("proj");
		expect(error.partitionId).toBe("p0");
		expect(error.attempted).toBe(5n);
		expect(error.current).toBe(9n);
		expect(error.message).toContain("proj/p0");
	});

	it("UnsupportedSchemaVersionError names found and supported", () => {
		const error = new UnsupportedSchemaVersionError(9, 4);
		expect(error.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
		expect(error.found).toBe(9);
		expect(error.supported).toBe(4);
		expect(error.message).toContain("max supported is 4");
	});

	it("PersistenceUnavailableError carries the caller's message", () => {
		const error = new PersistenceUnavailableError("disk full");
		expect(error.code).toBe("PERSISTENCE_UNAVAILABLE");
		expect(error.message).toBe("disk full");
	});

	it("SqliteBusyError and StorageWorkerTerminatedError default their messages", () => {
		// Both take an optional message. The defaults are checked because a
		// default that regressed to "" would produce an error nobody can read in
		// a log, and both are thrown from paths that usually pass nothing.
		expect(new SqliteBusyError().message).toBe("sqlite busy / timeout");
		expect(new SqliteBusyError("locked 5s").message).toBe("locked 5s");
		expect(new StorageWorkerTerminatedError().message).toBe(
			"storage worker terminated",
		);
		expect(new StorageWorkerTerminatedError("oom").message).toBe("oom");
	});

	it("all descend from EventStoreError with the shared name overridden", () => {
		const errors = [
			new OptimisticSequenceConflictError("s", 0, 1),
			new StaleFenceError("s", 0n, 1n),
			new MissingFenceError("s", 1n),
			new SnapshotAheadError("s", 2, 1),
			new CheckpointRegressionError("a", "b", 1n, 2n),
			new UnsupportedSchemaVersionError(2, 1),
			new PersistenceUnavailableError("x"),
			new SqliteBusyError(),
			new StorageWorkerTerminatedError(),
		];
		for (const error of errors) {
			// `instanceof EventStoreError` is what lets a driver-agnostic handler
			// catch the whole family; the per-class `name` is what a log reader
			// sees. Both have to hold.
			expect(error).toBeInstanceOf(EventStoreError);
			expect(error).toBeInstanceOf(Error);
			expect(error.name).not.toBe("EventStoreError");
		}
	});

	it("EventStoreError itself keeps its own name and code", () => {
		const error = new EventStoreError("INVALID_INPUT", "bad request");
		expect(error.name).toBe("EventStoreError");
		expect(error.code).toBe("INVALID_INPUT");
	});
});

describe("isOptimisticConflict", () => {
	it("recognises the instance", () => {
		expect(
			isOptimisticConflict(new OptimisticSequenceConflictError("s", 0, 1)),
		).toBe(true);
	});

	it("recognises a structurally-similar error from another package copy", () => {
		// The case `instanceof` cannot handle: two resolved copies of
		// `@hobo/core` produce two distinct classes. Matching on `name` is what
		// keeps a retry loop working across that boundary.
		expect(
			isOptimisticConflict({ name: "OptimisticSequenceConflictError" }),
		).toBe(true);
	});

	it("recognises the legacy StaleSequenceError name", () => {
		// Deliberate back-compatibility with the pre-rename error. Dropping it
		// would make an older driver's conflicts look like hard failures.
		expect(isOptimisticConflict({ name: "StaleSequenceError" })).toBe(true);
	});

	it("recognises a bare code, as arrives across a worker boundary", () => {
		// `postMessage` strips the prototype, so a worker-sourced conflict is a
		// plain object with a code and no usable name.
		expect(isOptimisticConflict({ code: "OPTIMISTIC_SEQUENCE_CONFLICT" })).toBe(
			true,
		);
	});

	it("rejects an unrelated error", () => {
		expect(isOptimisticConflict(new Error("boom"))).toBe(false);
		expect(isOptimisticConflict(new StaleFenceError("s", 0n, 1n))).toBe(false);
		expect(isOptimisticConflict({ code: "STALE_FENCE" })).toBe(false);
	});

	it("survives null, undefined and primitives", () => {
		// The optional chaining is load-bearing: this runs inside a `catch`, and
		// a predicate that threw on a thrown string would replace the original
		// failure with a TypeError from the error handler.
		expect(isOptimisticConflict(null)).toBe(false);
		expect(isOptimisticConflict(undefined)).toBe(false);
		expect(isOptimisticConflict("OPTIMISTIC_SEQUENCE_CONFLICT")).toBe(false);
		expect(isOptimisticConflict(0)).toBe(false);
	});
});

describe("isStaleFence", () => {
	it("recognises the instance, the name and the code", () => {
		expect(isStaleFence(new StaleFenceError("s", 0n, 1n))).toBe(true);
		expect(isStaleFence({ name: "StaleFenceError" })).toBe(true);
		expect(isStaleFence({ code: "STALE_FENCE" })).toBe(true);
	});

	it("does not treat a missing fence as a stale one", () => {
		// They demand opposite responses: a stale fence means another writer took
		// ownership and this one must stop, while a missing fence means this
		// writer should acquire one and proceed. Conflating them would have a
		// superseded writer keep writing.
		expect(isStaleFence(new MissingFenceError("s", 1n))).toBe(false);
		expect(isStaleFence({ code: "MISSING_FENCE" })).toBe(false);
	});

	it("rejects unrelated and non-object values", () => {
		expect(isStaleFence(new Error("boom"))).toBe(false);
		expect(isStaleFence(null)).toBe(false);
		expect(isStaleFence(undefined)).toBe(false);
		expect(isStaleFence(42)).toBe(false);
	});
});

describe("constants", () => {
	it("EVENTSTORE_LIMITS is frozen and states every bound", () => {
		// Frozen because these are read on every append; a caller that raised
		// `maxBatchEvents` at runtime would defeat the bound for the whole
		// process rather than for its own call.
		expect(Object.isFrozen(EVENTSTORE_LIMITS)).toBe(true);
		expect(EVENTSTORE_LIMITS.maxBatchEvents).toBe(256);
		expect(EVENTSTORE_LIMITS.maxReadPage).toBe(1000);
		expect(EVENTSTORE_LIMITS.maxPayloadBytes).toBe(1_048_576);
		expect(EVENTSTORE_LIMITS.maxMetadataBytes).toBe(65_536);
		expect(EVENTSTORE_LIMITS.defaultBusyTimeoutMs).toBe(5_000);
	});

	it("FENCING_COMPAT pins the unfenced epoch as a bigint zero", () => {
		// A `0` here instead of `0n` would compare false against every stored
		// epoch and put every legacy stream into fenced mode on first read.
		expect(FENCING_COMPAT.UNFENCED_EPOCH).toBe(0n);
		expect(FENCING_COMPAT.UNFENCED_EPOCH).toBeTypeOf("bigint");
		expect(Object.isFrozen(FENCING_COMPAT)).toBe(true);
	});
});
