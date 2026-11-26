import { bench, describe } from "vitest";

import {
	createInMemoryActorHost,
	createManualClock,
} from "../src/actor-host-runtime-port.ts";

type CounterState = { value: number };

function counterFold(state: CounterState, event: { type: string; amount?: number }): CounterState {
	if (event.type === "counter.Added") {
		return { value: state.value + (event.amount ?? 0) };
	}
	return state;
}

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("actor-host runtime port hot path", () => {
	bench("acquire + fenced append + release", () => {
		const host = createInMemoryActorHost({
			clock: createManualClock("2026-06-25T12:00:00.000Z"),
			leaseTtlMs: 30_000,
		});
		const state = host.state("actor:bench", { initialState: { value: 0 }, fold: counterFold });
		const lease = host.acquire("actor:bench", { holderId: "bench-worker" });
		state.append(lease, { type: "counter.Added", amount: 1 });
		lease.release();
	});

	bench("read = snapshotless fold over a 100-event stream", () => {
		const host = createInMemoryActorHost({
			clock: createManualClock("2026-06-25T12:00:00.000Z"),
			leaseTtlMs: 30_000,
		});
		const state = host.state("actor:bench", { initialState: { value: 0 }, fold: counterFold });
		const lease = host.acquire("actor:bench", { holderId: "bench-worker" });
		for (let i = 0; i < 100; i += 1) {
			state.append(lease, { type: "counter.Added", amount: 1 });
		}
		state.read();
	});
});
