import { describe, expect, it } from "vitest";

import { createInMemoryActorHost } from "../src/actor-host.js";
import {
	AggregateConflictError,
	AggregateInvariantError,
	AggregateStaleFenceError,
	defineAggregate,
} from "../src/index.js";
import { freshStore } from "./helpers.js";

interface Counter {
	readonly total: number;
}

interface Add {
	readonly amount: number;
}

function counter(
	overrides: Partial<Parameters<typeof defineAggregate<Counter, Add>>[0]> = {},
) {
	return defineAggregate<Counter, Add>({
		name: "counter",
		initialState: { total: 0 },
		evolve: (state, event) => {
			if (event.type !== "counter.Added") return state;
			const data = event.data as { amount?: number };
			return { total: state.total + (data.amount ?? 0) };
		},
		decide: (state, command, emit) => {
			if (command.amount < 0) {
				throw new AggregateInvariantError(
					"counter",
					"amount must not be negative",
				);
			}
			if (command.amount === 0) return;
			void state;
			emit.emit("counter.Added", { amount: command.amount });
		},
		...overrides,
	});
}

function deps() {
	return { store: freshStore(), actorHost: createInMemoryActorHost() };
}

const context = {
	tenant: "acme",
	actor: { kind: "user", id: "u1" } as const,
};

describe("defining an aggregate", () => {
	it("requires a name", () => {
		expect(() =>
			defineAggregate({
				name: "",
				initialState: {},
				evolve: (s) => s,
				decide: () => {},
			}),
		).toThrow(/name is required/u);
	});

	it("exposes its name", () => {
		expect(counter().name).toBe("counter");
	});
});

describe("loading state", () => {
	it("starts from the initial state for an empty stream", async () => {
		const { store } = deps();
		try {
			const loaded = await counter().load(store, "c1");
			expect(loaded).toEqual({ state: { total: 0 }, seq: 0 });
		} finally {
			store.close();
		}
	});

	it("folds the events that exist", async () => {
		const d = deps();
		try {
			await counter().execute(d, "c1", { amount: 3 }, context);
			await counter().execute(d, "c1", { amount: 4 }, context);
			expect((await counter().load(d.store, "c1")).state.total).toBe(7);
		} finally {
			d.store.close();
		}
	});

	it("reports the sequence the fold reached", async () => {
		const d = deps();
		try {
			await counter().execute(d, "c1", { amount: 1 }, context);
			expect((await counter().load(d.store, "c1")).seq).toBe(1);
		} finally {
			d.store.close();
		}
	});
});

describe("executing a command", () => {
	it("appends the emitted fact and returns the new state", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 5 }, context);
			expect(result.appended).toHaveLength(1);
			expect(result.state.total).toBe(5);
			expect(result.seq).toBe(1);
		} finally {
			d.store.close();
		}
	});

	it("folds the appended facts onto the returned state", async () => {
		const d = deps();
		try {
			await counter().execute(d, "c1", { amount: 2 }, context);
			const second = await counter().execute(d, "c1", { amount: 3 }, context);
			expect(second.state.total).toBe(5);
		} finally {
			d.store.close();
		}
	});

	it("advances the sequence across commands", async () => {
		const d = deps();
		try {
			const first = await counter().execute(d, "c1", { amount: 1 }, context);
			const second = await counter().execute(d, "c1", { amount: 1 }, context);
			expect(second.seq).toBe(first.seq + 1);
		} finally {
			d.store.close();
		}
	});

	it("keeps separate streams separate", async () => {
		const d = deps();
		try {
			await counter().execute(d, "a", { amount: 5 }, context);
			const other = await counter().execute(d, "b", { amount: 1 }, context);
			expect(other.state.total).toBe(1);
		} finally {
			d.store.close();
		}
	});

	it("carries the fence token it wrote under", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 1 }, context);
			expect(result.fenceToken).toBeTypeOf("bigint");
		} finally {
			d.store.close();
		}
	});
});

describe("a command that emits nothing", () => {
	it("returns without appending", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 0 }, context);
			expect(result.appended).toEqual([]);
		} finally {
			d.store.close();
		}
	});

	it("reports the sequence unchanged", async () => {
		const d = deps();
		try {
			await counter().execute(d, "c1", { amount: 1 }, context);
			const noop = await counter().execute(d, "c1", { amount: 0 }, context);
			expect(noop.seq).toBe(1);
		} finally {
			d.store.close();
		}
	});

	it("returns the state it folded rather than the initial state", async () => {
		const d = deps();
		try {
			await counter().execute(d, "c1", { amount: 9 }, context);
			const noop = await counter().execute(d, "c1", { amount: 0 }, context);
			expect(noop.state.total).toBe(9);
		} finally {
			d.store.close();
		}
	});

	it("still releases the lease", async () => {
		const d = deps();
		try {
			await counter().execute(d, "c1", { amount: 0 }, context);
			await expect(
				counter().execute(d, "c1", { amount: 1 }, context),
			).resolves.toBeDefined();
		} finally {
			d.store.close();
		}
	});
});

describe("the emit contract", () => {
	function emitting(type: string | number) {
		return defineAggregate<Counter, Add>({
			name: "counter",
			initialState: { total: 0 },
			evolve: (s) => s,
			decide: (_state, _command, emit) => {
				(emit.emit as (t: string | number) => void)(type);
			},
		});
	}

	it("refuses a type with no aggregate prefix", async () => {
		const d = deps();
		try {
			await expect(
				emitting("Added").execute(d, "c1", { amount: 1 }, context),
			).rejects.toThrow(/must be "aggregate.PastTenseFact"/u);
		} finally {
			d.store.close();
		}
	});

	it("refuses a non-string type", async () => {
		const d = deps();
		try {
			await expect(
				emitting(42).execute(d, "c1", { amount: 1 }, context),
			).rejects.toThrow(/must be "aggregate.PastTenseFact"/u);
		} finally {
			d.store.close();
		}
	});

	it("names the offending value", async () => {
		const d = deps();
		try {
			await expect(
				emitting("Added").execute(d, "c1", { amount: 1 }, context),
			).rejects.toThrow(/Added/u);
		} finally {
			d.store.close();
		}
	});

	it("defaults an omitted payload to an empty object", async () => {
		const d = deps();
		const marker = defineAggregate<Counter, Add>({
			name: "counter",
			initialState: { total: 0 },
			evolve: (s) => s,
			decide: (_s, _c, emit) => emit.emit("counter.Marked"),
		});
		try {
			const result = await marker.execute(d, "c1", { amount: 1 }, context);
			expect(result.appended[0]?.data).toEqual({});
		} finally {
			d.store.close();
		}
	});

	it("defaults the fact version to 1", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 1 }, context);
			expect(result.appended[0]?.v).toBe(1);
		} finally {
			d.store.close();
		}
	});

	it("honours an explicit fact version", async () => {
		const d = deps();
		const v2 = defineAggregate<Counter, Add>({
			name: "counter",
			initialState: { total: 0 },
			evolve: (s) => s,
			decide: (_s, _c, emit) => emit.emit("counter.Added", {}, { v: 2 }),
		});
		try {
			const result = await v2.execute(d, "c1", { amount: 1 }, context);
			expect(result.appended[0]?.v).toBe(2);
		} finally {
			d.store.close();
		}
	});

	it("appends several facts from one command in order", async () => {
		const d = deps();
		const twice = defineAggregate<Counter, Add>({
			name: "counter",
			initialState: { total: 0 },
			evolve: (state, event) => {
				const data = event.data as { amount?: number };
				return { total: state.total + (data.amount ?? 0) };
			},
			decide: (_s, _c, emit) => {
				emit.emit("counter.Added", { amount: 1 });
				emit.emit("counter.Added", { amount: 2 });
			},
		});
		try {
			const result = await twice.execute(d, "c1", { amount: 0 }, context);
			expect(result.appended).toHaveLength(2);
			expect(result.state.total).toBe(3);
			expect(result.seq).toBe(2);
		} finally {
			d.store.close();
		}
	});
});

describe("the lifecycle trail", () => {
	it("records activation and passivation for a successful command", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 1 }, context);
			expect(result.lifecycle.map((f) => f.type)).toEqual([
				"actor.Activated",
				"actor.StateAppended",
				"actor.Passivated",
			]);
		} finally {
			d.store.close();
		}
	});

	it("omits the state-appended fact for a no-op", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 0 }, context);
			expect(result.lifecycle.map((f) => f.type)).toEqual([
				"actor.Activated",
				"actor.Passivated",
			]);
		} finally {
			d.store.close();
		}
	});

	it("carries the fence token on activation", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 1 }, context);
			const activated = result.lifecycle[0];
			expect(activated.data?.fenceToken).toBeDefined();
		} finally {
			d.store.close();
		}
	});

	it("passivates at the sequence it actually reached", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 1 }, context);
			const passivated = result.lifecycle.at(-1);
			expect(passivated.data?.seq).toBe(1);
		} finally {
			d.store.close();
		}
	});
});

describe("releasing the lease when a command fails", () => {
	it("propagates an invariant violation", async () => {
		const d = deps();
		try {
			await expect(
				counter().execute(d, "c1", { amount: -1 }, context),
			).rejects.toThrow(AggregateInvariantError);
		} finally {
			d.store.close();
		}
	});

	it("releases the lease so the stream is not wedged", async () => {
		const d = deps();
		try {
			await expect(
				counter().execute(d, "c1", { amount: -1 }, context),
			).rejects.toThrow();
			const after = await counter().execute(d, "c1", { amount: 2 }, context);
			expect(after.state.total).toBe(2);
		} finally {
			d.store.close();
		}
	});

	it("does not append anything for a rejected command", async () => {
		const d = deps();
		try {
			await expect(
				counter().execute(d, "c1", { amount: -1 }, context),
			).rejects.toThrow();
			expect((await counter().load(d.store, "c1")).seq).toBe(0);
		} finally {
			d.store.close();
		}
	});

	it("releases the lease when the emit contract is violated too", async () => {
		const d = deps();
		const bad = defineAggregate<Counter, Add>({
			name: "counter",
			initialState: { total: 0 },
			evolve: (s) => s,
			decide: (_s, _c, emit) => emit.emit("no-prefix"),
		});
		try {
			await expect(
				bad.execute(d, "c1", { amount: 1 }, context),
			).rejects.toThrow();
			await expect(
				counter().execute(d, "c1", { amount: 1 }, context),
			).resolves.toBeDefined();
		} finally {
			d.store.close();
		}
	});
});

describe("translating store failures", () => {
	function storeRejectingAppendsAndCommits(error: Error) {
		const store = freshStore();
		const fail = async () => {
			throw error;
		};
		const delegate = {
			...store,
			read: store.read.bind(store),
			append: fail,
			commit: fail,
		};
		return { store: delegate, close: () => store.close() };
	}

	it("turns an optimistic conflict into an aggregate conflict", async () => {
		const failing = storeRejectingAppendsAndCommits(
			Object.assign(new Error("seq moved"), {
				name: "OptimisticSequenceConflictError",
				code: "OPTIMISTIC_CONFLICT",
			}),
		);
		try {
			await expect(
				counter().execute(
					{ store: failing.store, actorHost: createInMemoryActorHost() },
					"c1",
					{ amount: 1 },
					context,
				),
			).rejects.toThrow(AggregateConflictError);
		} finally {
			failing.close();
		}
	});

	it("turns a stale fence into a stale-fence error, not a conflict", async () => {
		const failing = storeRejectingAppendsAndCommits(
			Object.assign(new Error("fenced out"), { name: "StaleFenceError" }),
		);
		try {
			await expect(
				counter().execute(
					{ store: failing.store, actorHost: createInMemoryActorHost() },
					"c1",
					{ amount: 1 },
					context,
				),
			).rejects.toThrow(AggregateStaleFenceError);
		} finally {
			failing.close();
		}
	});

	it("recognises a stale fence by code as well as by name", async () => {
		const failing = storeRejectingAppendsAndCommits(
			Object.assign(new Error("fenced out"), { code: "STALE_FENCE" }),
		);
		try {
			await expect(
				counter().execute(
					{ store: failing.store, actorHost: createInMemoryActorHost() },
					"c1",
					{ amount: 1 },
					context,
				),
			).rejects.toThrow(AggregateStaleFenceError);
		} finally {
			failing.close();
		}
	});

	it("rethrows an error it does not recognise", async () => {
		const failing = storeRejectingAppendsAndCommits(new Error("disk on fire"));
		try {
			await expect(
				counter().execute(
					{ store: failing.store, actorHost: createInMemoryActorHost() },
					"c1",
					{ amount: 1 },
					context,
				),
			).rejects.toThrow(/disk on fire/u);
		} finally {
			failing.close();
		}
	});

	it("names the stream in the conflict", async () => {
		const failing = storeRejectingAppendsAndCommits(
			Object.assign(new Error("seq moved"), {
				name: "OptimisticSequenceConflictError",
				code: "OPTIMISTIC_CONFLICT",
			}),
		);
		try {
			await expect(
				counter().execute(
					{ store: failing.store, actorHost: createInMemoryActorHost() },
					"orders-7",
					{ amount: 1 },
					context,
				),
			).rejects.toThrow(/orders-7/u);
		} finally {
			failing.close();
		}
	});

	it("still releases the lease after a translated failure", async () => {
		const store = freshStore();
		const actorHost = createInMemoryActorHost();
		let fail = true;
		const conflictOnce = <T>(run: () => Promise<T>): Promise<T> => {
			if (fail) {
				fail = false;
				return Promise.reject(
					Object.assign(new Error("seq moved"), {
						name: "OptimisticSequenceConflictError",
						code: "OPTIMISTIC_CONFLICT",
					}),
				);
			}
			return run();
		};
		const durable = store;
		const flaky = {
			...store,
			read: store.read.bind(store),
			append: (...args: Parameters<typeof store.append>) =>
				conflictOnce(() => store.append(...args)),
			commit: (...args: Parameters<typeof store.commit>) =>
				conflictOnce(() => durable.commit(...args)),
		} satisfies typeof store;
		try {
			await expect(
				counter().execute(
					{ store: flaky, actorHost },
					"c1",
					{ amount: 1 },
					context,
				),
			).rejects.toThrow(AggregateConflictError);
			await expect(
				counter().execute(
					{ store: flaky, actorHost },
					"c1",
					{ amount: 1 },
					context,
				),
			).resolves.toBeDefined();
		} finally {
			store.close();
		}
	});
});

describe("the command context", () => {
	it("carries the tenant onto the appended event", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 1 }, context);
			expect(result.appended[0]?.tenant).toBe("acme");
		} finally {
			d.store.close();
		}
	});

	it("carries the correlation id when one is given", async () => {
		const d = deps();
		try {
			const result = await counter().execute(
				d,
				"c1",
				{ amount: 1 },
				{
					...context,
					correlationId: "trace-9",
				},
			);
			expect(result.appended[0]?.correlationId).toBe("trace-9");
		} finally {
			d.store.close();
		}
	});

	it("omits optional fields rather than writing undefined", async () => {
		const d = deps();
		try {
			const result = await counter().execute(d, "c1", { amount: 1 }, context);
			expect(result.appended[0]?.correlationId ?? null).toBeNull();
		} finally {
			d.store.close();
		}
	});

	it("uses a derived holder id when none is given", async () => {
		const d = deps();
		try {
			await expect(
				counter().execute(d, "c1", { amount: 1 }, context),
			).resolves.toBeDefined();
		} finally {
			d.store.close();
		}
	});

	it("honours an explicit holder id", async () => {
		const d = deps();
		try {
			const result = await counter().execute(
				d,
				"c1",
				{ amount: 1 },
				{
					...context,
					holderId: "worker-3",
				},
			);
			const activated = result.lifecycle[0];
			expect(activated.data?.holderId).toBe("worker-3");
		} finally {
			d.store.close();
		}
	});
});
