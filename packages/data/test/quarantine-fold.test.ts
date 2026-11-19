import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { foldEvents } from "../src/index.js";

interface CountState {
	count: number;
}

interface SeenState {
	seen: number[];
}

function evt(
	partial: Pick<EventEnvelope, "type" | "seq" | "v" | "data">,
): EventEnvelope {
	return {
		id: `evt-${partial.seq}`,
		streamId: "order:1",
		ts: "2026-06-26T00:00:00.000Z",
		actor: { kind: "user", id: "u1" },
		tenant: "tenant-a",
		type: partial.type,
		seq: partial.seq,
		v: partial.v,
		data: partial.data,
	};
}

describe("poison-event quarantine", () => {
	it("records a quarantine when an evolve throws and keeps folding", () => {
		const spec = {
			initialState: { count: 0 } satisfies CountState,
			evolve: (state: CountState, event: EventEnvelope) => {
				if (event.type === "order.Poison") throw new Error("decode-error");
				return { count: state.count + 1 };
			},
		};

		const outcome = foldEvents(
			[
				evt({ type: "order.Placed", seq: 1, v: 1, data: {} }),
				evt({ type: "order.Poison", seq: 2, v: 1, data: { raw: "{bad" } }),
				evt({ type: "order.Placed", seq: 3, v: 1, data: {} }),
			],
			spec,
		);

		expect(outcome.state).toEqual({ count: 2 });
		expect(outcome.seq).toBe(3);
		expect(outcome.quarantined).toEqual([
			{
				offendingSeq: 2,
				quarantineSeq: 4,
				type: "order.Quarantined",
				reason: "decode-error",
			},
		]);
	});

	it("deterministically skips a seq already neutralized by a persisted *.Quarantined fact", () => {
		const spec = {
			initialState: { seen: [] } satisfies SeenState,
			evolve: (state: SeenState, event: EventEnvelope) => ({
				seen: [...state.seen, event.seq],
			}),
		};

		const outcome = foldEvents(
			[
				evt({ type: "order.Placed", seq: 1, v: 1, data: {} }),
				evt({ type: "order.Placed", seq: 2, v: 1, data: {} }),
				evt({
					type: "order.Quarantined",
					seq: 3,
					v: 1,
					data: { offendingSeq: 2, reason: "decode-error" },
				}),
			],
			spec,
		);

		expect(outcome.state).toEqual({ seen: [1] });
		expect(outcome.seq).toBe(3);
	});
});
