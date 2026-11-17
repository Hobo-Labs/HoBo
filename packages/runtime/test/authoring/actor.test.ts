import { describe, expect, it } from "vitest";
import {
	createInMemoryActorHost,
	createManualActorClock,
} from "../../../runtimes/runtime-local/dist/actor-host/in-memory.js";
import { activateActor, defineActor } from "../../src/actor.js";
import { isJsonString } from "../../src/json.js";
import type { FoldEvent } from "../../src/ports.js";

interface CartState {
	items: string[];
}

const Cart = defineActor<CartState>({
	name: "Cart",
	initialState: () => ({ items: [] }),
	fold: (state, event) => {
		if (event.type === "addItem" && isJsonString(event.item)) {
			return { items: [...state.items, event.item] };
		}
		return state;
	},
	handlers: {
		addItem: (ctx, message: FoldEvent) => {
			ctx.emit({ type: "addItem", item: message.item });
		},
	},
});

describe("actor single-writer via ActorHost lease + fencing", () => {
	it("denies contended activation and rejects a superseded writer's append", async () => {
		const clock = createManualActorClock();
		const host = createInMemoryActorHost({ clock, leaseTtlMs: 1000 });

		const a = activateActor(host, Cart, "cart-1", { holderId: "worker-A" });
		expect(a.fenceToken).toBe(1n);

		expect(() =>
			activateActor(host, Cart, "cart-1", { holderId: "worker-B" }),
		).toThrow(/lease conflict/i);

		await a.send({ type: "addItem", item: "apple" });
		expect(a.state().items).toEqual(["apple"]);

		clock.advance(2000);
		const b = activateActor(host, Cart, "cart-1", { holderId: "worker-B" });
		expect(b.fenceToken).toBe(2n);
		expect(b.state().items).toEqual(["apple"]);

		await expect(a.send({ type: "addItem", item: "banana" })).rejects.toThrow(
			/stale fence|expired/i,
		);

		await b.send({ type: "addItem", item: "banana" });
		expect(b.state().items).toEqual(["apple", "banana"]);
	});
});
