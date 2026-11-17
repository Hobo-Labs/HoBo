import { describe, expect, it } from "vitest";

import { ReplayDivergenceError } from "../../src/replay/divergence.js";
import { assertReplayEqualsLive } from "../../src/replay/equivalence.js";
import type { EventEnvelope } from "../../src/replay/types.js";

describe("ReplayDivergenceError", () => {
	it("carries live/replay orders and parsed divergence digests", () => {
		const events: EventEnvelope[] = [
			{ id: "b-1", streamId: "ticket-b", seq: 1, type: "x", data: {} },
			{ id: "a-1", streamId: "ticket-a", seq: 1, type: "x", data: {} },
		];

		try {
			assertReplayEqualsLive({
				events,
				initialState: { seen: [] as string[] },
				fold: (state, currentEvent) => ({
					seen: [...state.seen, `${currentEvent.streamId}:${currentEvent.seq}`],
				}),
				runId: "divergence-case",
			});
			expect.fail("expected divergence");
		} catch (error) {
			expect(error).toBeInstanceOf(ReplayDivergenceError);
			const divergence = (error as ReplayDivergenceError).divergence;
			expect(divergence.runId).toBe("divergence-case");
			expect((error as ReplayDivergenceError).liveOrder.length).toBeGreaterThan(
				0,
			);
			expect(
				(error as ReplayDivergenceError).replayOrder.length,
			).toBeGreaterThan(0);
			expect(divergence.liveStateDigest).not.toBe(divergence.replayStateDigest);
			expect(divergence.liveStateDigest).toMatch(/^[0-9a-f]{64}$/);
			expect(divergence.replayStateDigest).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});
