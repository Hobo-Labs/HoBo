import { describe, expect, it } from "vitest";
// Reuse @hobo/runtime-local's durable ActorHost (lease + fencing). It is a
// test-only adapter injected into the authoring surface — never a src-level dep.
// Imported relatively from the sibling package's built dist (pretest builds it):
// declaring even a devDependency would close the package cycle
// conformance -> runtime -> runtime-local -> conformance, which turbo rejects.
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

		// Writer A activates the grain and holds the single-writer lease.
		const a = activateActor(host, Cart, "cart-1", { holderId: "worker-A" });
		expect(a.fenceToken).toBe(1n);

		// Contended activation while A holds the lease is denied outright.
		expect(() =>
			activateActor(host, Cart, "cart-1", { holderId: "worker-B" }),
		).toThrow(/lease conflict/i);

		// A is the writer; its append lands.
		await a.send({ type: "addItem", item: "apple" });
		expect(a.state().items).toEqual(["apple"]);

		// The lease expires; a new holder B supersedes A with a higher fence.
		clock.advance(2000);
		const b = activateActor(host, Cart, "cart-1", { holderId: "worker-B" });
		expect(b.fenceToken).toBe(2n);
		// B folds A's committed state from the shared stream.
		expect(b.state().items).toEqual(["apple"]);

		// A's stale-fence write is rejected — exactly-one-writer.
		await expect(a.send({ type: "addItem", item: "banana" })).rejects.toThrow(
			/stale fence|expired/i,
		);

		// Only B can write now.
		await b.send({ type: "addItem", item: "banana" });
		expect(b.state().items).toEqual(["apple", "banana"]);
	});
});
