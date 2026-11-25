import type { EventEnvelope } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createUpcasterRegistry, foldEvents } from "../src/index.js";
import { parseTotalCents } from "./helpers.js";

interface TotalState {
	totalCents: number;
}

interface CountState {
	count: number;
}

interface SeenState {
	seen: number[];
}

// Minimal envelope factory for pure fold/upcast unit tests.
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

describe("upcaster registry", () => {
	it("chains vN -> vN+1 forward-only and reports the latest version", () => {
		const registry = createUpcasterRegistry();
		registry
			.register("order.Placed", 1, (data: { cents: number }) => ({
				totalCents: data.cents,
			}))
			.register("order.Placed", 2, (data: { totalCents: number }) => ({
				totalCents: data.totalCents,
				currency: "USD",
			}));

		expect(registry.latestVersion("order.Placed")).toBe(3);

		const upcast = registry.upcast(
			evt({ type: "order.Placed", seq: 1, v: 1, data: { cents: 4200 } }),
		);
		expect(upcast.v).toBe(3);
		expect(upcast.data).toEqual({ totalCents: 4200, currency: "USD" });
	});

	it("round-trips: a v1 event folds identically to its current-version form", () => {
		const registry = createUpcasterRegistry();
		registry.register("order.Placed", 1, (data: { cents: number }) => ({
			totalCents: data.cents,
		}));

		const spec = {
			initialState: { totalCents: 0 } satisfies TotalState,
			evolve: (state: TotalState, event: EventEnvelope) =>
				event.type === "order.Placed"
					? { totalCents: parseTotalCents(event.data) }
					: state,
			upcasters: registry,
		};

		const foldedFromV1 = foldEvents(
			[evt({ type: "order.Placed", seq: 1, v: 1, data: { cents: 4200 } })],
			spec,
		);
		const foldedFromV2 = foldEvents(
			[evt({ type: "order.Placed", seq: 1, v: 2, data: { totalCents: 4200 } })],
			spec,
		);

		expect(foldedFromV1.state).toEqual({ totalCents: 4200 });
		expect(JSON.stringify(foldedFromV1.state)).toBe(
			JSON.stringify(foldedFromV2.state),
		);
	});
});

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
				quarantineSeq: 3,
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

		// seq 2 is skipped on replay; the quarantine fact itself is never folded.
		expect(outcome.state).toEqual({ seen: [1] });
		expect(outcome.seq).toBe(3);
	});
});
