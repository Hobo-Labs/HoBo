import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventInput } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrossCampProjection, defineProjection } from "../src/index.js";

const actor = { kind: "user", id: "operator" } as const;
const append = { actor, tenant: "workspace", expectedSeq: 0 };
const projection = defineProjection<{ count: number }>({
	name: "tickets",
	key: (event) => event.streamId,
	on: { "ticket.Opened": (row) => ({ count: (row?.count ?? 0) + 1 }) },
});

const resources: Array<() => void> = [];
afterEach(() => {
	for (const close of resources.splice(0).reverse()) close();
});

function fixture(maxBatchEvents = 2) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-cross-camp-"));
	resources.push(() => rmSync(directory, { recursive: true, force: true }));
	const owner = createRuntimeLocalEventStore({
		dataDir: join(directory, "owner"),
	});
	const replica = createRuntimeLocalEventStore({
		dataDir: join(directory, "replica"),
	});
	resources.push(
		() => owner.close(),
		() => replica.close(),
	);
	let now = 1_000;
	const lagged: unknown[] = [];
	const options = {
		projection,
		owner,
		replica,
		ownerCampId: "camp-east",
		replicaCampId: "camp-west",
		replicaStreamId: "replica:tickets",
		tenant: "workspace",
		actor,
		maxStalenessMs: 100,
		maxBatchEvents,
		nowMs: () => now,
		onLag: async (event: EventInput) => {
			await replica.append("lag:tickets", [event], {
				...append,
				expectedSeq: lagged.length,
			});
			lagged.push(event);
		},
	};
	return {
		owner,
		replica,
		options,
		lagged,
		setNow(value: number) {
			now = value;
		},
	};
}

describe("cross-camp projection replication", () => {
	it("records an empty but fully observed source and restores its freshness after restart", async () => {
		const f = fixture();
		const runtime = createCrossCampProjection(f.options);
		const result = await runtime.replicate();
		expect(result).toMatchObject({
			copied: 0,
			caughtUp: true,
			view: { sourcePosition: "0", staleness: { status: "within-bound" } },
		});
		expect(await createCrossCampProjection(f.options).read()).toEqual(
			result.view,
		);
	});

	it("copies only the selected source stream when a stream is specified", async () => {
		const f = fixture();
		const runtime = createCrossCampProjection({
			...f.options,
			sourceStreamId: "selected",
		});
		await runtime.append(
			"camp-west",
			"selected",
			[{ type: "ticket.Opened", data: {} }],
			append,
		);
		await f.owner.append(
			"other",
			[{ type: "ticket.Opened", data: {} }],
			append,
		);
		const result = await runtime.replicate();
		expect(result.caughtUp).toBe(true);
		expect(result.view.snapshot.rows).toEqual({ selected: { count: 1 } });
		expect(result.view.snapshot).toEqual(await runtime.readOwner());
		await expect(
			runtime.append(
				"camp-west",
				"other",
				[{ type: "ticket.Opened", data: {} }],
				append,
			),
		).rejects.toThrow("outside the projection source");
	});

	it("resumes from the replica journal after both stores reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-replica-reopen-"));
		const ownerDir = join(directory, "owner");
		const replicaDir = join(directory, "replica");
		let owner = createRuntimeLocalEventStore({ dataDir: ownerDir });
		let replica = createRuntimeLocalEventStore({ dataDir: replicaDir });
		const settings = {
			projection,
			ownerCampId: "east",
			replicaCampId: "west",
			replicaStreamId: "replica",
			tenant: "workspace",
			actor,
			maxStalenessMs: 100,
			nowMs: () => 1_000,
		};
		try {
			let runtime = createCrossCampProjection({ ...settings, owner, replica });
			await runtime.append(
				"east",
				"tickets",
				[{ type: "ticket.Opened", data: {} }],
				append,
			);
			await runtime.replicate();
			owner.close();
			replica.close();
			owner = createRuntimeLocalEventStore({ dataDir: ownerDir });
			replica = createRuntimeLocalEventStore({ dataDir: replicaDir });
			runtime = createCrossCampProjection({ ...settings, owner, replica });
			expect((await runtime.read()).snapshot.rows.tickets).toEqual({
				count: 1,
			});
			await runtime.append(
				"west",
				"tickets",
				[{ type: "ticket.Opened", data: {} }],
				{ ...append, expectedSeq: 1 },
			);
			expect((await runtime.replicate()).view.snapshot.rows.tickets).toEqual({
				count: 2,
			});
		} finally {
			owner.close();
			replica.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("routes writes to the owner and rebuilds the same fold from durable replica batches", async () => {
		const f = fixture();
		const runtime = createCrossCampProjection(f.options);
		await runtime.append(
			"camp-west",
			"tickets:a",
			[
				{ type: "ticket.Opened", data: { id: "a" } },
				{ type: "ticket.Opened", data: { id: "b" } },
			],
			append,
		);
		await runtime.append(
			"camp-east",
			"tickets:b",
			[{ type: "ticket.Opened", data: { id: "c" } }],
			append,
		);
		expect((await runtime.read()).staleness.status).toBe("unknown");
		const first = await runtime.replicate();
		expect(first.copied).toBe(2);
		expect(first.caughtUp).toBe(false);
		expect(first.view.staleness.status).toBe("unknown");
		const second = await runtime.replicate();
		expect(second.copied).toBe(1);
		expect(second.caughtUp).toBe(true);
		expect(second.view.snapshot).toEqual(await runtime.readOwner());
		expect(second.view.snapshot.rows).toEqual({
			"tickets:a": { count: 2 },
			"tickets:b": { count: 1 },
		});
		expect(second.view.staleness.status).toBe("within-bound");
		const reopened = createCrossCampProjection(f.options);
		expect(await reopened.read()).toEqual(second.view);
		expect((await reopened.replicate()).copied).toBe(0);
	});

	it("retains the last completed watermark across partial pulls and emits actual lag facts", async () => {
		const f = fixture(1);
		const runtime = createCrossCampProjection(f.options);
		await runtime.append(
			"camp-east",
			"tickets",
			[{ type: "ticket.Opened", data: {} }],
			append,
		);
		await runtime.replicate();
		f.setNow(1_200);
		await runtime.append(
			"camp-west",
			"tickets",
			[
				{ type: "ticket.Opened", data: {} },
				{ type: "ticket.Opened", data: {} },
			],
			{ ...append, expectedSeq: 1 },
		);
		const partial = await runtime.replicate();
		expect(partial.caughtUp).toBe(false);
		expect(partial.view.staleness).toMatchObject({
			status: "exceeds-bound",
			checkedAtMs: 1_000,
			observedLagMs: 200,
		});
		expect(f.lagged).toEqual([
			{
				type: "projection.ReplicaLagged",
				data: {
					projection: "tickets",
					ownerCampId: "camp-east",
					replicaCampId: "camp-west",
					sourcePosition: "2",
					boundMs: "100",
					observedLagMs: "200",
				},
			},
		]);
		const storedLag = [];
		for await (const event of f.replica.read("lag:tickets"))
			storedLag.push(event);
		expect(storedLag).toHaveLength(1);
		expect(storedLag[0]).toMatchObject(f.lagged[0]);
		const completed = await runtime.replicate();
		expect(completed.caughtUp).toBe(true);
		expect(completed.view.staleness.status).toBe("within-bound");
	});

	it("stores replica and lag records accepted by their CUE contracts", async () => {
		const f = fixture();
		const runtime = createCrossCampProjection(f.options);
		await runtime.append(
			"camp-east",
			"tickets",
			[{ type: "ticket.Opened", data: {} }],
			append,
		);
		await runtime.replicate();
		f.setNow(1_200);
		await runtime.read();
		const directory = mkdtempSync(join(tmpdir(), "hobo-replica-cue-"));
		try {
			const schema = fileURLToPath(
				new URL("../data-models/data.cue", import.meta.url),
			);
			const cue =
				process.env.HOBO_CUE_BIN ||
				fileURLToPath(
					new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
				);
			const records = [];
			for await (const event of f.replica.read("replica:tickets"))
				records.push(event);
			for await (const event of f.replica.read("lag:tickets"))
				records.push(event);
			expect(records).toHaveLength(3);
			for (const record of records) {
				const definition =
					record.type === "projection.EventReplicated"
						? "#ProjectionReplicatedEventData"
						: record.type === "projection.ReplicationChecked"
							? "#ProjectionReplicationCheckedData"
							: "#CrossCampProjectionLaggedData";
				const path = join(directory, "record.json");
				writeFileSync(path, JSON.stringify(record.data));
				execFileSync(cue, ["vet", schema, path, "-d", definition]);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("delivers replica snapshots to subscribers after replication", async () => {
		const f = fixture();
		const runtime = createCrossCampProjection(f.options);
		const received: string[] = [];
		const subscription = runtime.subscribe((view) => {
			received.push(view.sourcePosition);
		});
		await subscription.ready;
		await runtime.append(
			"camp-east",
			"tickets",
			[{ type: "ticket.Opened", data: {} }],
			append,
		);
		await runtime.replicate();
		await vi.waitFor(() => expect(received).toEqual(["1"]));
		await subscription.drain();
		subscription.unsubscribe();
	});

	it("surfaces subscriber failures through drain", async () => {
		const f = fixture();
		const runtime = createCrossCampProjection(f.options);
		let invoked = false;
		const subscription = runtime.subscribe(() => {
			invoked = true;
			throw new Error("subscriber unavailable");
		});
		await subscription.ready;
		await runtime.replicate();
		await vi.waitFor(() => expect(invoked).toBe(true));
		await expect(subscription.drain()).rejects.toThrow(
			"subscriber unavailable",
		);
		subscription.unsubscribe();
	});

	it("retries competing replicas without duplicating source events", async () => {
		const f = fixture();
		const one = createCrossCampProjection(f.options);
		const two = createCrossCampProjection(f.options);
		await one.append(
			"camp-east",
			"tickets",
			[
				{ type: "ticket.Opened", data: {} },
				{ type: "ticket.Opened", data: {} },
			],
			append,
		);
		await Promise.all([one.replicate(), two.replicate()]);
		expect((await one.read()).snapshot.rows.tickets).toEqual({ count: 2 });
		expect((await one.read()).sourcePosition).toBe("2");
	});

	it("refuses to mark a missing owner history as fresh", async () => {
		const f = fixture();
		const runtime = createCrossCampProjection(f.options);
		await runtime.append(
			"camp-east",
			"tickets",
			[{ type: "ticket.Opened", data: {} }],
			append,
		);
		await runtime.replicate();
		const directory = mkdtempSync(join(tmpdir(), "hobo-other-owner-"));
		const empty = createRuntimeLocalEventStore({ dataDir: directory });
		resources.push(
			() => rmSync(directory, { recursive: true, force: true }),
			() => empty.close(),
		);
		const disconnected = createCrossCampProjection({
			...f.options,
			owner: empty,
		});
		await expect(disconnected.replicate()).rejects.toThrow(
			"source stream no longer matches",
		);
	});
});
