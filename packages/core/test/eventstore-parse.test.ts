import { describe, expect, it } from "vitest";

import {
	eventPositionToText,
	FENCING_COMPAT,
	fenceTokenToText,
	OptimisticSequenceConflictError,
	parseEventPosition,
	parseFenceToken,
	StaleFenceError,
} from "../src/index.js";

describe("eventstore position/fence parse", () => {
	it("round-trips positions beyond MAX_SAFE_INTEGER", () => {
		const big = 9_007_199_254_740_993n;
		const pos = parseEventPosition(big);
		expect(pos).toBe(big);
		expect(eventPositionToText(pos)).toBe("9007199254740993");
		expect(parseEventPosition("9007199254740993")).toBe(big);
	});

	it("round-trips fence tokens as bigint", () => {
		const token = parseFenceToken(42);
		expect(token).toBe(42n);
		expect(fenceTokenToText(token)).toBe("42");
	});

	it("distinguishes stale fence from optimistic conflict codes", () => {
		const fence = new StaleFenceError("s", 1n, 2n);
		const conflict = new OptimisticSequenceConflictError("s", 0, 1);
		expect(fence.code).toBe("STALE_FENCE");
		expect(conflict.code).toBe("OPTIMISTIC_SEQUENCE_CONFLICT");
		expect(FENCING_COMPAT.UNFENCED_EPOCH).toBe(0n);
	});
});
