/**
 * The ephemeral-state port's parse boundary and helper preconditions.
 *
 * Behaviour against real bindings (in-memory, RESP, REST) is the conformance
 * suite in `@hobo/kv-redis-compatible`; this file covers what core owns
 * alone: the refined types and the inputs the lock and ring helpers refuse
 * before touching a port.
 */

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
	EphemeralRingEntrySchema,
	EphemeralRingReadSchema,
} from "../src/_generated/ephemeral_state_pb.js";
import {
	acquireEphemeralLock,
	createEphemeralRing,
	EPHEMERAL_STATE_COMMAND_COST,
	EPHEMERAL_STATE_MAX_TTL_MS,
	EphemeralStateParseError,
	type EphemeralStatePort,
	parseEphemeralKey,
	parseEphemeralTtlMs,
	parseEphemeralVersion,
	parseIncrementBy,
} from "../src/index.js";

// SAFETY: every property read throws, so no member of the empty target is ever used as a port method.
const untouched: EphemeralStatePort = new Proxy({} as EphemeralStatePort, {
	get() {
		throw new Error("the helper reached the port before refusing its input");
	},
});

describe("ephemeral-state parse boundary", () => {
	it("accepts printable ASCII keys up to 512 characters, including ring hash tags", () => {
		expect(parseEphemeralKey("ring:{relay}:e:1")).toBe("ring:{relay}:e:1");
		expect(parseEphemeralKey("k".repeat(512))).toHaveLength(512);
		for (const bad of ["", "a b", "tab\tkey", "ünïcode", "k".repeat(513)]) {
			expect(() => parseEphemeralKey(bad)).toThrow(EphemeralStateParseError);
		}
	});

	it("bounds TTLs to whole milliseconds within thirty days", () => {
		expect(parseEphemeralTtlMs(1)).toBe(1);
		expect(parseEphemeralTtlMs(EPHEMERAL_STATE_MAX_TTL_MS)).toBe(
			EPHEMERAL_STATE_MAX_TTL_MS,
		);
		for (const bad of [
			0,
			-1,
			1.5,
			Number.NaN,
			EPHEMERAL_STATE_MAX_TTL_MS + 1,
		]) {
			expect(() => parseEphemeralTtlMs(bad)).toThrow(EphemeralStateParseError);
		}
	});

	it("keeps versions opaque but bounded, and steps integral", () => {
		expect(parseEphemeralVersion("inc:1")).toBe("inc:1");
		expect(() => parseEphemeralVersion("")).toThrow(EphemeralStateParseError);
		expect(() => parseEphemeralVersion("v".repeat(129))).toThrow(
			EphemeralStateParseError,
		);
		expect(parseIncrementBy(-3)).toBe(-3);
		expect(() => parseIncrementBy(0.5)).toThrow(EphemeralStateParseError);
		expect(() => parseIncrementBy(2 ** 53)).toThrow(EphemeralStateParseError);
	});

	it("refuses an empty lock owner and malformed rings before any command", async () => {
		const ttl = parseEphemeralTtlMs(1_000);
		await expect(
			acquireEphemeralLock(untouched, parseEphemeralKey("lock"), "", ttl),
		).rejects.toThrow(EphemeralStateParseError);
		expect(() =>
			createEphemeralRing(untouched, { name: "a{b}", capacity: 1, ttlMs: ttl }),
		).toThrow(EphemeralStateParseError);
		expect(() =>
			createEphemeralRing(untouched, { name: "ok", capacity: 0, ttlMs: ttl }),
		).toThrow(EphemeralStateParseError);
		const ring = createEphemeralRing(untouched, {
			name: "ok",
			capacity: 4,
			ttlMs: ttl,
		});
		expect(ring.keys.seq).toBe("ring:{ok}:seq");
		expect(ring.keys.entry(7)).toBe("ring:{ok}:e:7");
		await expect(ring.read(-1)).rejects.toThrow(EphemeralStateParseError);
	});

	it("freezes the documented command cost", () => {
		expect(Object.isFrozen(EPHEMERAL_STATE_COMMAND_COST)).toBe(true);
		expect(
			Math.max(...Object.values(EPHEMERAL_STATE_COMMAND_COST)),
		).toBeLessThanOrEqual(3);
	});

	it("round-trips a ring read through its generated wire form", () => {
		const record = create(EphemeralRingReadSchema, {
			entries: [
				create(EphemeralRingEntrySchema, { ring: "mcp", seq: 3n, value: "{}" }),
			],
			head: 3n,
			next: 3n,
			gaps: [2n],
			reset: false,
		});
		const decoded = fromBinary(
			EphemeralRingReadSchema,
			toBinary(EphemeralRingReadSchema, record),
		);
		expect(decoded.entries[0]?.seq).toBe(3n);
		expect(decoded.gaps).toEqual([2n]);
	});
});
