import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { FreightSubject, PolicyMode } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { PROMOTION_REASON } from "../../src/promotion/index.js";
import { SAGA_FACT } from "../../src/promotion/state.js";
import { pipelineNode } from "./doubles.js";
import { harness } from "./harness.js";
import { camp, fid } from "./store.js";

type Fault = "before" | "after" | "once";

async function railFixture(suffix = "") {
	const h = harness();
	h.pipelines.define(
		"rollback-fence-rail",
		[
			pipelineNode("inform", {
				campIds: ["dev-1"],
				policyMode: PolicyMode.INFORM,
			}),
		],
		FreightSubject.RAIL,
	);
	h.freight.add("r1", { subject: FreightSubject.RAIL });
	h.pipelines.makeAvailable("rollback-fence-rail", "inform", "r1");
	const request = {
		campId: camp("dev-1"),
		reason: "restore",
		idempotencyKey: `rollback-fence-${suffix}`,
	};
	return { h, request };
}

async function promoteRail(h: ReturnType<typeof harness>, service = h.service) {
	const result = await service.promote(
		{
			freightId: fid("r1"),
			targets: [camp("dev-1")],
			idempotencyKey: "rail-fence-promotion",
			pipeline: "rollback-fence-rail",
			node: "inform",
		},
		h.ctx(),
	);
	expect(result.ok).toBe(true);
}

async function faultHistory(mode: Fault, suffix = "") {
	const { h, request } = await railFixture(suffix);
	await promoteRail(h);
	const effect = vi.spyOn(h.campPolicy, "restore");
	const append = h.store.append.bind(h.store);
	let failures = 0;
	const faulty = vi
		.spyOn(h.store, "append")
		.mockImplementation(async (stream, events, opts) => {
			if (
				events.some(
					(event) => event.meta?.idempotencyKey === "rollback:execution",
				)
			) {
				failures++;
				if (mode === "before") throw new Error("claim did not commit");
				const written = await append(stream, events, opts);
				if (mode === "after" || failures === 1)
					throw new Error("claim acknowledgement lost");
				return written;
			}
			return append(stream, events, opts);
		});
	try {
		const first = await h.service.rollback(request, h.ctx());
		if (mode === "once") {
			expect(first.ok).toBe(true);
			expect(effect).toHaveBeenCalledTimes(1);
		} else {
			expect(first.ok).toBe(false);
			expect(effect).not.toHaveBeenCalled();
		}
		faulty.mockRestore();
		const retry = await h.restart().rollback(request, h.ctx());
		if (mode === "after") {
			expect(retry.ok).toBe(false);
			if (!retry.ok)
				expect(retry.reasons[0]?.code).toBe(PROMOTION_REASON.journalConflict);
			expect(effect).not.toHaveBeenCalled();
		} else {
			expect(retry.ok).toBe(true);
			expect(effect).toHaveBeenCalledTimes(1);
		}
	} finally {
		faulty.mockRestore();
		effect.mockRestore();
	}
}

it.each([
	"before",
	"after",
	"once",
] as const)("handles a %s execution-claim acknowledgement", async (mode) => {
	await faultHistory(mode);
});

it("does not execute on an acknowledgement without a stored claim", async () => {
	const { h, request } = await railFixture("forged");
	await promoteRail(h);
	const effect = vi.spyOn(h.campPolicy, "restore");
	const append = h.store.append.bind(h.store);
	const forged = vi
		.spyOn(h.store, "append")
		.mockImplementation(async (stream, events, opts) => {
			const input = events.find(
				(event) => event.meta?.idempotencyKey === "rollback:execution",
			);
			if (!input) return append(stream, events, opts);
			if (!input.meta) throw new Error("expected execution claim metadata");
			const event: EventEnvelope = {
				id: "forged-claim",
				type: input.type,
				v: input.v ?? 1,
				streamId: stream,
				seq: 2,
				ts: new Date(h.clock.now()).toISOString(),
				actor: opts.actor,
				tenant: opts.tenant,
				data: input.data,
				meta: input.meta,
			};
			return { streamId: stream, appended: [event], deduped: [] };
		});
	try {
		const result = await h.service.rollback(request, h.ctx());
		expect(result.ok).toBe(false);
		expect(effect).not.toHaveBeenCalled();
	} finally {
		forged.mockRestore();
		effect.mockRestore();
	}
});

it.each([
	"rollbackExecutionToken",
	"rollbackExecutionProtocol",
	"rollbackRequestFingerprint",
	"rollbackBaseSetId",
	"idempotencyKey",
] as const)("refuses a returned claim with a changed %s", async (field) => {
	const { h, request } = await railFixture(`bad-ack-${field}`);
	await promoteRail(h);
	const effect = vi.spyOn(h.campPolicy, "restore");
	const append = h.store.append.bind(h.store);
	const altered = vi
		.spyOn(h.store, "append")
		.mockImplementation(async (stream, events, opts) => {
			const result = await append(stream, events, opts);
			if (
				!events.some(
					(event) => event.meta?.idempotencyKey === "rollback:execution",
				)
			)
				return result;
			const event = result.appended[0] ?? result.deduped[0];
			if (!event?.meta) throw new Error("expected stored execution claim");
			return {
				...result,
				appended: [{ ...event, meta: { ...event.meta, [field]: "changed" } }],
				deduped: [],
			};
		});
	try {
		const result = await h.service.rollback(request, h.ctx());
		expect(result.ok).toBe(false);
		expect(effect).not.toHaveBeenCalled();
	} finally {
		altered.mockRestore();
		effect.mockRestore();
	}
});

it("refuses an unfinished legacy claim without an execution protocol", async () => {
	const { h, request } = await railFixture("legacy");
	await promoteRail(h);
	const effect = vi.spyOn(h.campPolicy, "restore");
	const append = h.store.append.bind(h.store);
	const faulty = vi
		.spyOn(h.store, "append")
		.mockImplementation(async (stream, events, opts) => {
			if (
				events.some(
					(event) => event.meta?.idempotencyKey === "rollback:execution",
				)
			)
				throw new Error("no execution claim");
			return append(stream, events, opts);
		});
	try {
		expect((await h.service.rollback(request, h.ctx())).ok).toBe(false);
		faulty.mockRestore();
		const started = h.store
			.events(SAGA_FACT.started)
			.find((event) => event.meta?.idempotencyKey === "rollback:started");
		if (!started?.meta) throw new Error("fixture rollback claim missing");
		delete started.meta.rollbackExecutionProtocol;
		const retry = await h.restart().rollback(request, h.ctx());
		expect(retry.ok).toBe(false);
		if (!retry.ok)
			expect(retry.reasons[0]?.message).toContain("predates execution fencing");
		expect(effect).not.toHaveBeenCalled();
	} finally {
		faulty.mockRestore();
		effect.mockRestore();
	}
});

it("fences competing attempts using two SQLite connections", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cd-rollback-race-"));
	const { h, request } = await railFixture("sqlite-race");
	const firstStore = createRuntimeLocalEventStore({ dataDir: dir });
	const secondStore = createRuntimeLocalEventStore({ dataDir: dir });
	let release!: () => void;
	let entered!: () => void;
	let duplicate!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const duplicateStarted = new Promise<void>((resolve) => {
		duplicate = resolve;
	});
	const restore = h.campPolicy.restore.bind(h.campPolicy);
	let calls = 0;
	const effect = vi
		.spyOn(h.campPolicy, "restore")
		.mockImplementation(async (input) => {
			calls++;
			if (calls === 1) {
				entered();
				await held;
			} else duplicate();
			return restore(input);
		});
	try {
		await promoteRail(h, h.withStore(firstStore));
		const first = h.withStore(firstStore).rollback(request, h.ctx());
		const second = h.withStore(secondStore).rollback(request, h.ctx());
		await started;
		await Promise.race([
			first.then(() => undefined),
			second.then(() => undefined),
			duplicateStarted,
		]);
		release();
		const results = await Promise.all([first, second]);
		expect(effect).toHaveBeenCalledTimes(1);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		const conflict = results.find((result) => !result.ok);
		if (!conflict || conflict.ok)
			throw new Error("expected competing rollback conflict");
		expect(conflict.reasons[0]?.code).toBe(PROMOTION_REASON.journalConflict);
	} finally {
		release();
		effect.mockRestore();
		firstStore.close();
		secondStore.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("keeps a claimed Rail rollback fenced across SQLite reopen after result loss", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cd-rollback-fence-"));
	const { h, request } = await railFixture("sqlite");
	let store = createRuntimeLocalEventStore({ dataDir: dir });
	const effect = vi.spyOn(h.campPolicy, "restore");
	try {
		await promoteRail(h, h.withStore(store));
		const faulty = {
			...store,
			append: async (...args: Parameters<typeof store.append>) => {
				const [stream, events, opts] = args;
				if (
					events.some((event) => event.type === CD_EVENTS.EnvPromoteRolledBack)
				)
					throw new Error("result unavailable");
				return store.append(stream, events, opts);
			},
		};
		const first = await h.withStore(faulty).rollback(request, h.ctx());
		expect(first.ok).toBe(false);
		expect(effect).toHaveBeenCalledTimes(1);
		store.close();
		store = createRuntimeLocalEventStore({ dataDir: dir });
		const retry = await h.withStore(store).rollback(request, h.ctx());
		expect(retry.ok).toBe(false);
		if (!retry.ok)
			expect(retry.reasons[0]?.code).toBe(PROMOTION_REASON.journalConflict);
		expect(effect).toHaveBeenCalledTimes(1);
	} finally {
		effect.mockRestore();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("preserves the execution fence across generated lost acknowledgements", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.constantFrom<Fault>("before", "after", "once"),
			fc.string({ maxLength: 8 }),
			async (mode, suffix) => {
				await faultHistory(mode, Buffer.from(suffix).toString("hex"));
			},
		),
		{ seed: 614603, numRuns: 30 },
	);
});
