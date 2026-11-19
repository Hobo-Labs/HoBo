import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
} from "../src/index.js";

const actor = { kind: "user", id: "operator" } as const;
const context = { actor, tenant: "workspace" };

it("retries a transient aggregate fold failure without persisting quarantine", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-transient-aggregate-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Added", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		const failure = new Error("temporary fold dependency failure");
		let available = false;
		const classified: string[] = [];
		const aggregate = defineAggregate<{ count: number }, "noop">({
			name: "items",
			initialState: { count: 0 },
			evolve(state) {
				if (!available) throw failure;
				return { count: state.count + 1 };
			},
			classifyFailure(error, event) {
				classified.push(`${error.message}:${event.type}`);
				return "transient";
			},
			decide() {},
		});
		const deps = { store, actorHost: createInMemoryActorHost() };
		await expect(
			aggregate.execute(deps, "items", "noop", context),
		).rejects.toBe(failure);
		const before = [];
		for await (const event of store.read("items")) before.push(event.type);
		expect(before).toEqual(["item.Added"]);
		expect(classified).toEqual([
			"temporary fold dependency failure:item.Added",
		]);
		available = true;
		const retried = await aggregate.execute(deps, "items", "noop", context);
		expect(retried.state).toEqual({ count: 1 });
		expect(retried.quarantined).toEqual([]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("retries a transient projection fold failure without recording a poison event", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-transient-projection-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Added", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		const failure = new Error("temporary projection dependency failure");
		let available = false;
		const projection = defineProjection({
			name: "items",
			key: (event) => event.streamId,
			on: {
				"item.Added": (row: { count: number } | undefined) => {
					if (!available) throw failure;
					return { count: (row?.count ?? 0) + 1 };
				},
			},
			classifyFailure: () => "transient",
		});
		const options = {
			quarantineStore: store,
			quarantineStreamId: "projection-quarantines",
			...context,
		};
		await expect(
			projection.rebuildWithQuarantine(store, "items", options),
		).rejects.toBe(failure);
		const recorded = [];
		for await (const event of store.read("projection-quarantines"))
			recorded.push(event);
		expect(recorded).toEqual([]);
		available = true;
		const retried = await projection.rebuildWithQuarantine(
			store,
			"items",
			options,
		);
		expect(retried.snapshot.rows.items).toEqual({ count: 1 });
		expect(retried.quarantined).toEqual([]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
