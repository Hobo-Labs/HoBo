// Orchestrator realizer (adapters/orchestrator.ts): only changed nodes
// reconcile, rollback re-applies the predecessor (C4), attestation fails
// closed (C3), departure keeps, crash resume is idempotent, fencing holds.
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import type { ActorLease, ActorLeaseHost, FenceToken } from "@hobo/core";
import { createFixtureHostAttestor } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { ReconcileStatus, SetOrigin } from "../../src/_generated/cd_pb.js";
import {
	createOrchestratorRealizer,
	diffGraph,
	ORCHESTRATOR_LEDGER,
} from "../../src/adapters/orchestrator.js";
import type { RealizeInput } from "../../src/ports.js";
import {
	asCamp,
	asReconciler,
	createClock,
	createFakeStore,
	ctxAt,
	resolvedFor,
	setFor,
} from "./fakes.js";

const CAMP = asCamp("camp-graph");

function countingIac() {
	const calls: string[] = [];
	const drift = new Set<string>();
	const iac: IacProvider = {
		id: "fake-iac",
		async preview(program: IacProgram) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			calls.push(`apply:${program.resourceId}`);
			return { endpoint: `https://${program.resourceId}.example` };
		},
		async destroy(program: IacProgram) {
			calls.push(`destroy:${program.resourceId}`);
		},
		async refresh(program: IacProgram) {
			return { drift: drift.has(program.resourceId), observed: {} };
		},
	};
	return { iac, calls, drift };
}

function actorHost(): ActorLeaseHost {
	const held = new Map<string, { holderId: string; fence: bigint }>();
	return {
		acquire(key, request): ActorLease {
			const current = held.get(key);
			if (current) throw new Error(`lease conflict on ${key}`);
			const fence = 1n;
			held.set(key, { holderId: request.holderId, fence });
			return {
				key,
				holderId: request.holderId,
				fenceToken: fence,
				expiresAt: new Date(0).toISOString(),
				release: () => held.delete(key),
			};
		},
	};
}

function harness(opts: { badAttestor?: boolean } = {}) {
	const clock = createClock();
	const store = createFakeStore(clock);
	const { iac, calls, drift } = countingIac();
	const attestor = createFixtureHostAttestor({ hostId: "host-a" });
	const realizer = createOrchestratorRealizer({
		store,
		tenant: "acme",
		actorHost: actorHost(),
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
		attestor: opts.badAttestor
			? { createDocument: attestor.createDocument, publicKeys: () => [] }
			: attestor,
		hostId: "host-a",
		refresh: iac,
		now: clock.now,
	});
	const input = (
		resources: Parameters<typeof resolvedFor>[1],
		n: number,
		extra: Partial<RealizeInput> & { keep?: readonly string[] } = {},
		origin = SetOrigin.PROMOTION,
	): RealizeInput => {
		const resolved = resolvedFor(CAMP, resources);
		return {
			campId: CAMP,
			desired: setFor(CAMP, resolved, n, origin),
			resolved,
			reconcilerId: asReconciler("r1"),
			fence: 1n as FenceToken,
			signal: new AbortController().signal,
			...extra,
		};
	};
	return { clock, store, realizer, calls, drift, input, ctx: ctxAt(clock) };
}

const API_V1 = { name: "api", port: "compute", version: "1", deps: ["db"] };
const DB_V1 = { name: "db", port: "database", version: "1" };

describe("createOrchestratorRealizer", () => {
	it("only changed nodes reconcile", async () => {
		const h = harness();
		const first = await h.realizer.converge(h.input([DB_V1, API_V1], 1), h.ctx);
		expect(first.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.calls.sort()).toEqual(["apply:api", "apply:db"]);
		h.calls.length = 0;
		const second = await h.realizer.converge(
			h.input([DB_V1, { ...API_V1, version: "2" }], 2),
			h.ctx,
		);
		expect(second.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.calls).toEqual(["apply:api"]);
		expect(second.setId).toBe(
			h.input([DB_V1, { ...API_V1, version: "2" }], 2).desired.setId,
		);
	});

	it("C4: a rollback Set re-applies the predecessor's changed nodes", async () => {
		const h = harness();
		await h.realizer.converge(h.input([DB_V1, API_V1], 1), h.ctx);
		await h.realizer.converge(
			h.input([DB_V1, { ...API_V1, version: "2" }], 2),
			h.ctx,
		);
		h.calls.length = 0;
		const back = await h.realizer.converge(
			h.input([DB_V1, API_V1], 3, {}, SetOrigin.ROLLBACK),
			h.ctx,
		);
		expect(back.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.calls).toEqual(["apply:api"]);
	});

	it("C3: an unattestable apply worker blocks with a typed reason and applies nothing", async () => {
		const h = harness({ badAttestor: true });
		const obs = await h.realizer.converge(h.input([DB_V1], 1), h.ctx);
		expect(obs.status).toBe(ReconcileStatus.BLOCKED);
		expect(obs.reasons[0]?.code).toBe("attestation-refused");
		expect(h.calls).toEqual([]);
	});

	it("I1: a resolved set that does not match the Set's content hash is refused", async () => {
		const h = harness();
		const input = h.input([DB_V1], 1);
		const other = resolvedFor(CAMP, [{ ...DB_V1, version: "9" }]);
		const obs = await h.realizer.converge({ ...input, resolved: other }, h.ctx);
		expect(obs.reasons[0]?.code).toBe("resolved-set-mismatch");
		expect(h.calls).toEqual([]);
	});

	it("removed nodes are destroyed; nodes the reconciler keeps on departure are not", async () => {
		const h = harness();
		await h.realizer.converge(
			h.input([DB_V1, { ...API_V1, deps: [] }], 1),
			h.ctx,
		);
		h.calls.length = 0;
		const depart = await h.realizer.converge(
			h.input([], 2, { keep: ["db"] }, SetOrigin.DEPARTURE),
			h.ctx,
		);
		expect(h.calls).toEqual(["destroy:api"]);
		expect(depart.resources.map((r) => r.resource)).toEqual(["db"]);
	});

	it("a crash between execute and the ledger write resumes without repeating the apply", async () => {
		const h = harness();
		let crash = true;
		h.store.beforeAppend = (stream) => {
			if (crash && stream === ORCHESTRATOR_LEDGER.stream(CAMP)) {
				crash = false;
				throw new Error("process crashed");
			}
		};
		await expect(
			h.realizer.converge(h.input([DB_V1], 1), h.ctx),
		).rejects.toThrow("process crashed");
		expect(h.calls).toEqual(["apply:db"]);
		const resumed = await h.realizer.converge(h.input([DB_V1], 1), h.ctx);
		expect(resumed.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.calls).toEqual(["apply:db"]);
	});

	it("I4: a stale fence stops before mutating and cannot record realized state", async () => {
		const h = harness();
		await h.realizer.converge(
			h.input([DB_V1], 1, { fence: 2n as FenceToken }),
			h.ctx,
		);
		h.calls.length = 0;
		const stale = await h.realizer.converge(
			h.input([{ ...DB_V1, version: "2" }], 2, { fence: 1n as FenceToken }),
			h.ctx,
		);
		expect(stale.status).toBe(ReconcileStatus.BLOCKED);
		expect(stale.reasons[0]?.code).toBe("stale-fence");
		expect(h.calls).toEqual([]);
	});

	it("observe reports drift from a provider refresh without mutating", async () => {
		const h = harness();
		await h.realizer.converge(h.input([DB_V1], 1), h.ctx);
		h.calls.length = 0;
		h.drift.add("db");
		const obs = await h.realizer.observe(h.input([DB_V1], 1), h.ctx);
		expect(obs.status).toBe(ReconcileStatus.DRIFTED);
		expect(obs.resources[0]?.driftKind).toBe("modified");
		expect(obs.resources[0]?.kind).toBe("database");
		expect(h.calls).toEqual([]);
	});

	it("diffGraph is pure over the ledger and the resolved set", () => {
		const resolved = resolvedFor(CAMP, [DB_V1]);
		const diff = diffGraph({ resources: {} }, resolved);
		expect(diff.changed.map((r) => r.name)).toEqual(["db"]);
		expect(diff.removed).toEqual([]);
	});
});
