import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createInMemoryActorHost,
	defineAggregate,
	UnpersistedQuarantineError,
} from "../src/index.js";

const context = {
	tenant: "workspace",
	actor: { kind: "user", id: "operator" } as const,
};

function aggregate(acceptPoison = false) {
	return defineAggregate<{ count: number }, "write" | "none">({
		name: "items",
		initialState: { count: 0 },
		evolve(state, event) {
			if (event.type === "item.Poison" && !acceptPoison)
				throw new Error("invalid item");
			return { count: state.count + 1 };
		},
		decide(_state, command, emit) {
			if (command === "write") {
				emit.emit("item.Poison", {});
				emit.emit("item.Added", {});
			}
		},
	});
}

it("quarantines failed events emitted by the current command after any older failures", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-new-quarantine-"));
	let store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Poison", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		const result = await aggregate().execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"write",
			context,
		);
		expect(result.seq).toBe(5);
		expect(result.state).toEqual({ count: 1 });
		expect(result.appended.map((event) => event.type)).toEqual([
			"aggregate.QuarantineRecorded",
			"item.Poison",
			"item.Added",
			"aggregate.QuarantineRecorded",
		]);
		expect(
			result.quarantined.map((record) => [
				record.offendingSeq,
				record.quarantineSeq,
			]),
		).toEqual([
			[1, 2],
			[3, 5],
		]);
		store.close();
		store = createRuntimeLocalEventStore({ dataDir: directory });
		expect(await aggregate(true).load(store, "items")).toEqual({
			state: { count: 1 },
			seq: 5,
		});
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("reports a failed quarantine write after the command event has been committed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-new-quarantine-failure-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		const unavailable = {
			...store,
			async append() {
				throw new Error("quarantine store unavailable");
			},
		};
		await expect(
			aggregate().execute(
				{ store: unavailable, actorHost: createInMemoryActorHost() },
				"items",
				"write",
				context,
			),
		).rejects.toThrow("quarantine store unavailable");
		const types: string[] = [];
		for await (const event of store.read("items")) types.push(event.type);
		expect(types).toEqual(["item.Poison", "item.Added"]);
		await expect(aggregate().load(store, "items")).rejects.toBeInstanceOf(
			UnpersistedQuarantineError,
		);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
