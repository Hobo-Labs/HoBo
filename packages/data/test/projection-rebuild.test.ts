import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableEventStore, EventInput, EventStore } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../src/json.js";
import { createProjectionRebuild } from "../src/projection-rebuild.js";

type TicketRow = JsonObject & { count: number; status: string };

const actor = { kind: "service", id: "rebuild" } as const;
const tenant = "work";
const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

function parseTicket(value: JsonValue): TicketRow {
	if (
		!isJsonObject(value) ||
		!isJsonNumber(value.count) ||
		!isJsonString(value.status)
	)
		throw new TypeError("invalid ticket row");
	return { count: value.count, status: value.status };
}

function fixture(batchSize = 2, shardCount = 3) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-rebuild-"));
	const sourceDir = join(directory, "source");
	const journalDir = join(directory, "journal");
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	function open() {
		const source = createRuntimeLocalEventStore({ dataDir: sourceDir });
		const journal = createRuntimeLocalEventStore({ dataDir: journalDir });
		let closed = false;
		function close() {
			if (closed) return;
			closed = true;
			source.close();
			journal.close();
		}
		cleanup.push(close);
		return { source, journal, close };
	}
	const stores = open();
	function options(current = stores) {
		return {
			...current,
			sourceId: "tickets-source",
			journalPrefix: "rebuild:tickets:v2",
			cutoverStreamId: "active:tickets",
			projection: "tickets",
			migrationId: "tickets-v2-migration",
			schemaVersion: "v2",
			targetSinkId: "green",
			tenant,
			actor,
			clock: () => "2026-01-02T03:04:05.000Z",
			shardCount,
			batchSize,
			eventTypes: ["ticket.Opened", "ticket.Commented", "ticket.Closed"],
			mode: "deterministic" as const,
			determinism: "deterministic" as const,
			key: (event: { streamId: string }) => event.streamId,
			apply(row: TicketRow | undefined, event: { type: string }): TicketRow {
				if (event.type === "ticket.Opened") return { count: 0, status: "open" };
				if (!row) throw new Error("ticket was not opened");
				if (event.type === "ticket.Commented")
					return { ...row, count: row.count + 1 };
				return { ...row, status: "closed" };
			},
			parseRow: parseTicket,
		};
	}
	return { ...stores, open, options };
}

async function append(
	store: ReturnType<typeof createRuntimeLocalEventStore>,
	streamId: string,
	events: EventInput[],
	expectedSeq = 0,
) {
	const result = await store.append(streamId, events, {
		actor,
		tenant,
		expectedSeq,
	});
	if (result.lastPosition === undefined)
		throw new Error("missing source position");
	return result.lastPosition;
}

async function catchUp(
	runtime: ReturnType<typeof createProjectionRebuild<TicketRow>>,
) {
	for (let attempt = 0; attempt < 100; attempt += 1)
		if ((await runtime.runBatch()).every((shard) => shard.caughtUp)) return;
	throw new Error("rebuild did not catch up");
}

describe("durable projection rebuild", () => {
	it("resumes interrupted shards and cuts over only after the supplied source barrier", async () => {
		const f = fixture();
		const first = await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			{ type: "ticket.Commented" },
			{ type: "ticket.Commented" },
		]);
		const barrier = await append(f.source, "ticket:b", [
			{ type: "ticket.Opened" },
			{ type: "ticket.Closed" },
		]);
		expect(barrier > first).toBe(true);
		const runtime = createProjectionRebuild(f.options());
		await runtime.runBatch();
		await expect(runtime.cutover("blue", barrier)).rejects.toThrow(
			/not reached/,
		);
		f.close();
		const reopened = f.open();
		const resumed = createProjectionRebuild(f.options(reopened));
		await catchUp(resumed);
		expect(await resumed.read()).toEqual({
			rows: {
				"ticket:a": { count: 2, status: "open" },
				"ticket:b": { count: 0, status: "closed" },
			},
			positions: [barrier.toString(), barrier.toString(), barrier.toString()],
		});
		const audit = [];
		for await (const event of reopened.journal.read("rebuild:tickets:v2/audit"))
			audit.push(event);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			type: "migration.PhaseApplied",
			v: 2,
			data: {
				migrationId: "tickets-v2-migration",
				phase: "backfill",
				backfillKind: "deterministic-replay",
				strategy: "rebuild-from-zero",
				checkpointed: true,
				appliedAt: "2026-01-02T03:04:05.000Z",
				sourcePosition: barrier.toString(),
			},
		});
		expect(await resumed.cutover("blue", barrier)).toBe("green");
		expect(await resumed.activeSink()).toBe("green");
		expect(await resumed.cutover("blue", barrier)).toBe("green");
		const cutovers = [];
		for await (const event of reopened.journal.read("active:tickets"))
			cutovers.push(event);
		expect(cutovers.map((event) => event.type)).toEqual([
			"migration.CutOver",
			"projection.SinkRebound",
		]);
		expect(cutovers[0]).toMatchObject({
			v: 2,
			data: {
				migrationId: "tickets-v2-migration",
				cutover: "blue-green",
				logPosition: barrier.toString(),
			},
		});
		expect(cutovers[1]).toMatchObject({
			type: "projection.SinkRebound",
			data: {
				projection: "tickets",
				fromSinkId: "blue",
				toSinkId: "green",
				verifiedPosition: barrier.toString(),
				migrationId: "tickets-v2-migration",
			},
		});
		expect(
			(await resumed.runBatch()).every((shard) => shard.scanned === 0),
		).toBe(true);
	});

	it("rebuilds a larger history through bounded batches", async () => {
		const f = fixture(50, 4);
		await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			...Array.from({ length: 250 }, () => ({ type: "ticket.Commented" })),
			{ type: "ticket.Closed" },
		]);
		const runtime = createProjectionRebuild(f.options());
		await catchUp(runtime);
		expect((await runtime.read()).rows["ticket:a"]).toEqual({
			count: 250,
			status: "closed",
		});
	});

	it("retries competing workers without applying an event twice", async () => {
		const f = fixture(2, 1);
		await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			{ type: "ticket.Commented" },
			{ type: "ticket.Commented" },
		]);
		const left = createProjectionRebuild(f.options());
		const right = createProjectionRebuild(f.options(f.open()));
		await Promise.all([left.runBatch(), right.runBatch()]);
		await catchUp(left);
		expect((await right.read()).rows).toEqual({
			"ticket:a": { count: 2, status: "open" },
		});
	});

	it("retries a failed backfill audit without applying rows twice", async () => {
		const f = fixture(3, 1);
		await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			{ type: "ticket.Commented" },
		]);
		let fail = true;
		const journal: EventStore = {
			...f.journal,
			async append(streamId, events, options) {
				if (streamId === "rebuild:tickets:v2/audit" && fail) {
					fail = false;
					throw new Error("audit write failed");
				}
				return f.journal.append(streamId, events, options);
			},
		};
		const runtime = createProjectionRebuild({ ...f.options(), journal });
		await expect(runtime.runBatch()).rejects.toThrow("audit write failed");
		await catchUp(runtime);
		expect((await runtime.read()).rows["ticket:a"]).toEqual({
			count: 1,
			status: "open",
		});
		const facts = [];
		for await (const event of f.journal.read("rebuild:tickets:v2/audit"))
			facts.push(event);
		expect(facts.map((event) => event.type)).toEqual([
			"migration.PhaseApplied",
		]);
	});

	it("does not report caught up when the source advances during the check", async () => {
		const f = fixture(3, 1);
		const position = await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
		]);
		let injected = false;
		const source: DurableEventStore = {
			...f.source,
			async *readAll(options) {
				if (!injected && options?.after === position) {
					injected = true;
					await append(f.source, "ticket:a", [{ type: "ticket.Commented" }], 1);
				}
				yield* f.source.readAll(options);
			},
		};
		const runtime = createProjectionRebuild({ ...f.options(), source });
		expect((await runtime.runBatch())[0]?.caughtUp).toBe(false);
		await catchUp(runtime);
		expect((await runtime.read()).rows["ticket:a"]).toEqual({
			count: 1,
			status: "open",
		});
	});

	it("refuses a cutover barrier when the source has advanced beyond it", async () => {
		const f = fixture(3, 1);
		const oldPosition = await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
		]);
		const runtime = createProjectionRebuild(f.options());
		await catchUp(runtime);
		const currentPosition = await append(
			f.source,
			"ticket:a",
			[{ type: "ticket.Commented" }],
			1,
		);
		await expect(runtime.cutover("blue", oldPosition)).rejects.toThrow(
			/source advanced/,
		);
		expect(await runtime.activeSink()).toBeUndefined();
		await catchUp(runtime);
		expect(await runtime.cutover("blue", currentPosition)).toBe("green");
		const laterPosition = await append(
			f.source,
			"ticket:a",
			[{ type: "ticket.Commented" }],
			2,
		);
		expect(await runtime.cutover("blue", currentPosition)).toBe("green");
		await expect(runtime.cutover("blue", laterPosition)).rejects.toThrow(
			/different cutover/,
		);
	});

	it("retries a failed cutover without leaving partial audit facts", async () => {
		const f = fixture(3, 1);
		const position = await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
		]);
		let fail = true;
		const journal: EventStore = {
			...f.journal,
			async append(streamId, events, options) {
				if (streamId === "active:tickets" && fail) {
					fail = false;
					throw new Error("cutover write failed");
				}
				return f.journal.append(streamId, events, options);
			},
		};
		const runtime = createProjectionRebuild({ ...f.options(), journal });
		await catchUp(runtime);
		await expect(runtime.cutover("blue", position)).rejects.toThrow(
			"cutover write failed",
		);
		expect(await runtime.activeSink()).toBeUndefined();
		expect(await runtime.cutover("blue", position)).toBe("green");
		const events = [];
		for await (const event of f.journal.read("active:tickets"))
			events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"migration.CutOver",
			"projection.SinkRebound",
		]);
	});

	it("rejects an incomplete cutover audit", async () => {
		const f = fixture(3, 1);
		await f.journal.append(
			"active:tickets",
			[
				{
					type: "migration.CutOver",
					v: 2,
					data: {
						migrationId: "tickets-v2-migration",
						cutOverAt: "2026-01-02T03:04:05.000Z",
						projection: "tickets",
						fromSinkId: "blue",
						toSinkId: "green",
						cutover: "blue-green",
						logPosition: "1",
					},
				},
			],
			{ actor, tenant, expectedSeq: 0 },
		);
		await expect(
			createProjectionRebuild(f.options()).activeSink(),
		).rejects.toThrow(/incomplete rebuild audit/);
	});

	it("continues from a durable snapshot and folds only its tail", async () => {
		const f = fixture(3, 2);
		const position = await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			{ type: "ticket.Commented" },
		]);
		const tailPosition = await append(
			f.source,
			"ticket:a",
			[{ type: "ticket.Commented" }],
			2,
		);
		const seeded = createProjectionRebuild({
			...f.options(),
			seed: { position, rows: { "ticket:a": { count: 1, status: "open" } } },
		});
		await catchUp(seeded);
		f.close();
		const reopened = f.open();
		const resumed = createProjectionRebuild(f.options(reopened));
		expect((await resumed.read()).rows).toEqual({
			"ticket:a": { count: 2, status: "open" },
		});
		expect(
			(await resumed.runBatch()).every((shard) => shard.scanned === 0),
		).toBe(true);
		await resumed.cutover("blue", tailPosition);
		const audit = [];
		for await (const event of reopened.journal.read("rebuild:tickets:v2/audit"))
			audit.push(event);
		expect(audit[0]).toMatchObject({ data: { strategy: "snapshot-tail" } });
	});

	it("restores the seed after initialization fails on one shard", async () => {
		const f = fixture(3, 2);
		const position = await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			{ type: "ticket.Commented" },
		]);
		await append(f.source, "ticket:a", [{ type: "ticket.Commented" }], 2);
		let fail = true;
		const journal: EventStore = {
			...f.journal,
			async append(streamId, events, options) {
				if (streamId.endsWith("/shard/1") && fail) {
					fail = false;
					throw new Error("shard unavailable");
				}
				return f.journal.append(streamId, events, options);
			},
		};
		const interrupted = createProjectionRebuild({
			...f.options(),
			journal,
			seed: { position, rows: { "ticket:a": { count: 1, status: "open" } } },
		});
		await expect(interrupted.runBatch()).rejects.toThrow("shard unavailable");
		const resumed = createProjectionRebuild(f.options());
		await catchUp(resumed);
		expect((await resumed.read()).rows["ticket:a"]).toEqual({
			count: 2,
			status: "open",
		});
		const different = createProjectionRebuild({
			...f.options(),
			seed: { position, rows: { "ticket:a": { count: 9, status: "open" } } },
		});
		await expect(different.read()).rejects.toThrow(/snapshot does not match/);
	});

	it("rejects an oversized seed without leaving a partial configuration", async () => {
		const f = fixture(3, 1);
		const rows = Object.fromEntries(
			Array.from({ length: 256 }, (_, index) => [
				`ticket:${index}`,
				{ count: 0, status: "open" },
			]),
		);
		const oversized = createProjectionRebuild({
			...f.options(),
			seed: { position: 0n, rows },
		});
		await expect(oversized.read()).rejects.toThrow(/atomic seed limit/);
		expect(await createProjectionRebuild(f.options()).read()).toEqual({
			rows: {},
			positions: ["0"],
		});
	});

	it("does not persist partial batches when a fold fails", async () => {
		const f = fixture(3, 1);
		await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			{ type: "ticket.Commented" },
		]);
		const base = f.options();
		let fail = true;
		const runtime = createProjectionRebuild({
			...base,
			apply(row, event) {
				if (event.type === "ticket.Commented" && fail)
					throw new Error("fold failed");
				return base.apply(row, event);
			},
		});
		await expect(runtime.runBatch()).rejects.toThrow("fold failed");
		expect(await runtime.read()).toEqual({ rows: {}, positions: ["0"] });
		fail = false;
		await catchUp(runtime);
		expect((await runtime.read()).rows["ticket:a"]).toEqual({
			count: 1,
			status: "open",
		});
	});

	it("rejects non-finite row values before checkpointing", async () => {
		const f = fixture(3, 1);
		await append(f.source, "ticket:a", [{ type: "ticket.Opened" }]);
		const runtime = createProjectionRebuild({
			...f.options(),
			apply: () => ({ count: Number.NaN, status: "open" }),
		});
		await expect(runtime.runBatch()).rejects.toThrow(/finite JSON/);
		expect(await runtime.read()).toEqual({ rows: {}, positions: ["0"] });
	});

	it("rejects a parser that produces non-finite snapshot values", async () => {
		const f = fixture(3, 1);
		const runtime = createProjectionRebuild({
			...f.options(),
			seed: {
				position: 0n,
				rows: { "ticket:a": { count: 1, status: "open" } },
			},
			parseRow: (value) => ({ ...parseTicket(value), count: Number.NaN }),
		});
		await expect(runtime.read()).rejects.toThrow(/finite JSON/);
		expect(await createProjectionRebuild(f.options()).read()).toEqual({
			rows: {},
			positions: ["0"],
		});
	});

	it("requires recorded output for nondeterministic projections", async () => {
		const f = fixture(3, 1);
		const options = {
			...f.options(),
			determinism: "nondeterministic" as const,
		};
		expect(() => createProjectionRebuild(options)).toThrow(/recorded-output/);
		const barrier = await append(f.source, "ticket:a", [
			{ type: "ticket.Opened" },
			{ type: "embed.OutputRecorded" },
		]);
		const runtime = createProjectionRebuild({
			...options,
			mode: "recorded-output",
			eventTypes: ["embed.OutputRecorded"],
			apply(_row, event) {
				if (event.type !== "embed.OutputRecorded")
					throw new Error("unexpected computation");
				return { count: 1, status: "recorded" };
			},
		});
		await catchUp(runtime);
		expect((await runtime.read()).rows["ticket:a"]).toEqual({
			count: 1,
			status: "recorded",
		});
		await runtime.cutover("blue", barrier);
		const events = [];
		for await (const event of f.journal.read("rebuild:tickets:v2/audit"))
			events.push(event);
		expect(events[0]).toMatchObject({
			data: {
				backfillKind: "recorded-output",
				strategy: "recorded-output-backfill",
			},
		});
	});

	it("rejects reopening a checkpoint under a different schema", async () => {
		const f = fixture(3, 1);
		await append(f.source, "ticket:a", [{ type: "ticket.Opened" }]);
		await catchUp(createProjectionRebuild(f.options()));
		const changed = createProjectionRebuild({
			...f.options(),
			schemaVersion: "v3",
		});
		await expect(changed.read()).rejects.toThrow(/invalid rebuild/);
	});
});
