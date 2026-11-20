import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type IacRouteController, runIacRoute } from "../src/iac-route.js";
import {
	type IacRouteRecoveryDependencies,
	type IacRouteRecoveryStore,
	normalizeIacRouteRecoveryClaim,
	recoverIacRoute,
	recoveryClaimDigest,
} from "../src/iac-route-recovery.js";
import { createSqliteIacRouteRecoveryStore } from "../src/iac-route-recovery-sqlite.js";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";

interface MutableRecoveryDependencies {
	store: IacRouteRecoveryStore;
	authorize: IacRouteRecoveryDependencies["authorize"];
	verifyProvider: IacRouteRecoveryDependencies["verifyProvider"];
	verifyFinancial: IacRouteRecoveryDependencies["verifyFinancial"];
	verifyFence: IacRouteRecoveryDependencies["verifyFence"];
}

const inventoryHash = `sha256:${"a".repeat(64)}`;
const operationId = `sha256:${"c".repeat(64)}`;
function evidence() {
	const establishedAt = Date.now() - 2000;
	return {
		fence: { ref: "fence:evidence", establishedAt },
		provider: {
			ref: "provider:evidence",
			afterFence: "fence:evidence",
			observedAt: establishedAt + 1000,
		},
		financial: {
			ref: "finance:evidence",
			afterFence: "fence:evidence",
			observedAt: establishedAt + 1000,
		},
	};
}
const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-route-recovery-"));
	directories.push(directory);
	const path = join(directory, "route.sqlite");
	const authority = createSqliteIacRouteAuthority({
		path,
		verifyOperation: (input) =>
			input.tenantId === "tenant" &&
			input.authorization === `signed:${input.requestId}`,
	});
	closers.push(() => authority.close());
	const store = createSqliteIacRouteRecoveryStore({ path });
	closers.push(() => store.close());
	const identity = {
		tenantId: "tenant",
		requestId: "request",
		operationId,
		authorization: "signed:request",
	};
	const deps: MutableRecoveryDependencies = {
		store,
		authorize: async () => true,
		verifyProvider: async () => true,
		verifyFinancial: async () => true,
		verifyFence: async () => true,
	};
	return { authority, store, path, identity, deps };
}

async function started() {
	const f = fixture();
	const owner = await f.authority.claim(f.identity);
	if (owner.status !== "claimed") throw new Error("claim missing");
	const permit = await f.authority.beginAttempt({
		...f.identity,
		claimToken: owner.claimToken,
		targetId: "yard-a",
		inventoryHash,
	});
	const snapshot = await f.store.inspect(f.identity);
	if (snapshot === undefined) throw new Error("route missing");
	const claim = {
		...f.identity,
		operatorId: "operator",
		expectedVersion: snapshot.version,
		expiresAt: Date.now() + 60_000,
		evidence: evidence(),
		outcome: {
			kind: "no-effect" as const,
			successorRequestId: "retry-1",
			reservations: [],
		},
	};
	return { ...f, owner, permit, snapshot, claim };
}

describe("verified durable IaC route recovery", () => {
	it("closes a verified no-effect route, fences old capabilities and allocates one successor", async () => {
		const f = await started();
		const result = await recoverIacRoute(f.deps, f.claim);
		expect(result).toMatchObject({
			status: "recovered",
			outcome: { kind: "no-effect", successorRequestId: "retry-1" },
		});
		expect(await f.authority.verifyAttempt(f.permit)).toBe(false);
		await expect(async () =>
			f.authority.beginAttempt({
				...f.identity,
				claimToken: f.owner.claimToken,
				targetId: "other",
				inventoryHash,
			}),
		).rejects.toThrow();
		expect(await f.authority.claim(f.identity)).toMatchObject({
			status: "existing",
			phase: "finished",
			outcome: { status: "denied" },
		});
		expect(
			await f.authority.claim({
				tenantId: "tenant",
				requestId: "retry-1",
				operationId,
				authorization: "signed:retry-1",
			}),
		).toMatchObject({ status: "claimed" });
		const replay = await recoverIacRoute(f.deps, f.claim);
		expect(replay.status).toBe("replay");
	});

	it("recovers a lost initial claim with no attempt while fencing its old owner", async () => {
		const f = fixture();
		const owner = await f.authority.claim(f.identity);
		if (owner.status !== "claimed") throw new Error("claim missing");
		const snapshot = await f.store.inspect(f.identity);
		if (!snapshot) throw new Error("snapshot missing");
		let verifiedAttempts = -1;
		f.deps.verifyFence = async (input) => {
			verifiedAttempts = input.snapshot.attempts.length;
			return true;
		};
		const result = await recoverIacRoute(f.deps, {
			...f.identity,
			operatorId: "operator",
			expectedVersion: snapshot.version,
			expiresAt: Date.now() + 60_000,
			evidence: evidence(),
			outcome: {
				kind: "no-effect",
				successorRequestId: "retry-1",
				reservations: [],
			},
		});
		expect(result.status).toBe("recovered");
		expect(verifiedAttempts).toBe(0);
		await expect(async () =>
			f.authority.beginAttempt({
				...f.identity,
				claimToken: owner.claimToken,
				targetId: "x",
				inventoryHash,
			}),
		).rejects.toThrow();
	});

	it("records verified already-applied work as selected without allocating a retry", async () => {
		const f = await started();
		const result = await recoverIacRoute(f.deps, {
			...f.claim,
			outcome: {
				kind: "selected",
				targetId: "yard-a",
				inventoryHash,
				financial: { disposition: "held", reservationId: "iac:request" },
			},
		});
		expect(result).toMatchObject({
			status: "recovered",
			outcome: { kind: "selected", targetId: "yard-a" },
		});
		expect(await f.authority.claim(f.identity)).toMatchObject({
			phase: "finished",
			outcome: { status: "selected", targetId: "yard-a" },
		});
		expect(await f.authority.verifyAttempt(f.permit)).toBe(false);
	});

	it.each([
		"authorization",
		"provider",
		"financial",
		"fence",
		"version",
		"tenant",
		"request",
	] as const)("rejects forged or unverified %s without changing the route", async (kind) => {
		const f = await started();
		if (kind === "authorization") f.deps.authorize = async () => false;
		if (kind === "provider") f.deps.verifyProvider = async () => false;
		if (kind === "financial") f.deps.verifyFinancial = async () => false;
		if (kind === "fence") f.deps.verifyFence = async () => false;
		const claim = { ...f.claim };
		if (kind === "version") claim.expectedVersion = `sha256:${"b".repeat(64)}`;
		if (kind === "tenant") claim.tenantId = "other";
		if (kind === "request") claim.requestId = "other";
		const result = await recoverIacRoute(f.deps, claim);
		expect(result.status).toBe("denied");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		expect(await f.store.get(f.identity)).toBeUndefined();
	});

	it("rejects evidence for another selected target or inventory", async () => {
		const f = await started();
		for (const outcome of [
			{
				kind: "selected" as const,
				targetId: "other",
				inventoryHash,
				financial: {
					disposition: "held" as const,
					reservationId: "iac:request",
				},
			},
			{
				kind: "selected" as const,
				targetId: "yard-a",
				inventoryHash: `sha256:${"b".repeat(64)}`,
				financial: {
					disposition: "held" as const,
					reservationId: "iac:request",
				},
			},
		]) {
			expect(
				(await recoverIacRoute(f.deps, { ...f.claim, outcome })).status,
			).toBe("denied");
			expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		}
	});

	it("refuses when an attempt changes after verification began", async () => {
		const f = fixture();
		const owner = await f.authority.claim(f.identity);
		if (owner.status !== "claimed") throw new Error("claim missing");
		const snapshot = await f.store.inspect(f.identity);
		if (!snapshot) throw new Error("snapshot missing");
		f.deps.verifyProvider = async () => {
			await f.authority.beginAttempt({
				...f.identity,
				claimToken: owner.claimToken,
				targetId: "a",
				inventoryHash,
			});
			return true;
		};
		const result = await recoverIacRoute(f.deps, {
			...f.identity,
			operatorId: "operator",
			expectedVersion: snapshot.version,
			expiresAt: Date.now() + 60_000,
			evidence: evidence(),
			outcome: {
				kind: "no-effect",
				successorRequestId: "retry-1",
				reservations: [],
			},
		});
		expect(result.status).toBe("uncertain");
		expect(await f.store.get(f.identity)).toBeUndefined();
		expect((await f.authority.inspect(f.identity))?.phase).toBe("running");
	});

	it("recognizes recovery committed before a lost acknowledgement", async () => {
		const f = await started();
		const broken: IacRouteRecoveryStore = {
			...f.store,
			commit: async (request) => {
				await f.store.commit(request);
				throw new Error("lost ack");
			},
		};
		const result = await recoverIacRoute({ ...f.deps, store: broken }, f.claim);
		expect(result.status).toBe("replay");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(false);
	});

	it("rejects a fabricated successful receipt without a durable recovery", async () => {
		const f = await started();
		const broken = {
			...f.store,
			commit: async () => ({ status: "committed" as const }),
		};
		// @ts-expect-error The test deliberately supplies a fabricated JavaScript receipt.
		const result = await recoverIacRoute({ ...f.deps, store: broken }, f.claim);
		expect(result.status).toBe("uncertain");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("does not disclose route or attempt capabilities in the verification snapshot", async () => {
		const f = await started();
		const encoded = JSON.stringify(f.snapshot);
		expect(encoded).not.toContain(f.owner.claimToken);
		expect(encoded).not.toContain(f.permit.attemptId);
	});
});

describe("recovery authority boundaries", () => {
	it("permanently fences before requesting provider and financial observations", async () => {
		const f = await started();
		const calls: string[] = [];
		const result = await recoverIacRoute(
			{
				...f.deps,
				verifyFence: async () => {
					calls.push("fence");
					return true;
				},
				verifyProvider: async ({ claim, snapshot }) => {
					calls.push("provider");
					return (
						claim.evidence.fence.ref === "fence:evidence" &&
						snapshot.version === f.snapshot.version
					);
				},
				verifyFinancial: async ({ claim, snapshot }) => {
					calls.push("financial");
					const attempt = snapshot.attempts[0];
					const expected = f.snapshot.attempts[0];
					return (
						claim.evidence.fence.ref === "fence:evidence" &&
						attempt !== undefined &&
						expected !== undefined &&
						attempt.attemptRef === expected.attemptRef
					);
				},
			},
			f.claim,
		);
		expect(result.status).toBe("recovered");
		expect(calls).toEqual(["fence", "provider", "financial"]);
	});

	it("rejects evidence not authenticated for the exact claim and route history", async () => {
		const f = await started();
		const result = await recoverIacRoute(
			{
				...f.deps,
				verifyFence: async ({ claim, snapshot }) =>
					claim.evidence.fence.ref === "trusted-proof" &&
					snapshot.tenantId === "tenant" &&
					snapshot.version === claim.expectedVersion,
			},
			f.claim,
		);
		expect(result.status).toBe("denied");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("rechecks operator authorization after verification", async () => {
		const f = await started();
		let calls = 0;
		const result = await recoverIacRoute(
			{ ...f.deps, authorize: async () => ++calls === 1 },
			f.claim,
		);
		expect(result.status).toBe("denied");
		expect(calls).toBe(2);
		expect(await f.store.get(f.identity)).toBeUndefined();
	});

	it("refuses a changed consume bit even when all other route fields are unchanged", async () => {
		const f = await started();
		const result = await recoverIacRoute(
			{
				...f.deps,
				verifyProvider: async () => {
					expect(await f.authority.consumeAttempt(f.permit)).toBe(true);
					return true;
				},
			},
			f.claim,
		);
		expect(result.status).toBe("uncertain");
		expect(await f.store.get(f.identity)).toBeUndefined();
	});

	it("commits at most one of two competing recoveries", async () => {
		const f = await started();
		const competing = {
			...f.claim,
			outcome: { ...f.claim.outcome, successorRequestId: "retry-2" },
		};
		const results = await Promise.all([
			recoverIacRoute(f.deps, f.claim),
			recoverIacRoute(f.deps, competing),
		]);
		expect(
			results.filter((result) => result.status === "recovered"),
		).toHaveLength(1);
		expect(
			results.filter(
				(result) => result.status === "denied" || result.status === "uncertain",
			),
		).toHaveLength(1);
		const record = await f.store.get(f.identity);
		expect(record?.claim.outcome.kind).toBe("no-effect");
		if (record?.claim.outcome.kind !== "no-effect")
			throw new Error("missing recovery");
		expect(["retry-1", "retry-2"]).toContain(
			record.claim.outcome.successorRequestId,
		);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(false);
	});

	it("does not recover using a successor already claimed by another route", async () => {
		const f = await started();
		expect(
			(
				await f.authority.claim({
					tenantId: "tenant",
					requestId: "retry-1",
					operationId: `sha256:${"d".repeat(64)}`,
					authorization: "signed:retry-1",
				})
			).status,
		).toBe("claimed");
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("uncertain");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		expect(await f.store.get(f.identity)).toBeUndefined();
	});

	it("rejects conflicting replay evidence and reauthorizes the replay", async () => {
		const f = await started();
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("recovered");
		expect(
			(
				await recoverIacRoute(f.deps, {
					...f.claim,
					evidence: {
						...f.claim.evidence,
						provider: { ...f.claim.evidence.provider, ref: "different" },
					},
				})
			).status,
		).toBe("denied");
		expect(
			(
				await recoverIacRoute(
					{ ...f.deps, authorize: async () => false },
					f.claim,
				)
			).status,
		).toBe("denied");
	});

	it("returns uncertain when the receipt cannot be reread and permits later replay", async () => {
		const f = await started();
		let reads = 0;
		const broken: IacRouteRecoveryStore = {
			...f.store,
			get: async (identity) => {
				if (++reads > 1) throw new Error("read unavailable");
				return f.store.get(identity);
			},
		};
		expect(
			(await recoverIacRoute({ ...f.deps, store: broken }, f.claim)).status,
		).toBe("uncertain");
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("replay");
	});

	it("rejects selected without an attempt but can recover an independently verified empty denial", async () => {
		const f = fixture();
		const owner = await f.authority.claim(f.identity);
		if (owner.status !== "claimed") throw new Error("claim missing");
		const snapshot = await f.store.inspect(f.identity);
		if (!snapshot) throw new Error("snapshot missing");
		const claim = {
			...f.identity,
			operatorId: "operator",
			expectedVersion: snapshot.version,
			expiresAt: Date.now() + 60_000,
			evidence: evidence(),
			outcome: {
				kind: "selected" as const,
				targetId: "yard-a",
				inventoryHash,
				financial: { disposition: "held" as const, reservationId: "r" },
			},
		};
		expect((await recoverIacRoute(f.deps, claim)).status).toBe("denied");
		await f.authority.finish({
			...f.identity,
			claimToken: owner.claimToken,
			outcome: { status: "denied" },
		});
		const finished = await f.store.inspect(f.identity);
		if (!finished) throw new Error("snapshot missing");
		expect(
			(
				await recoverIacRoute(f.deps, {
					...claim,
					expectedVersion: finished.version,
					outcome: {
						kind: "no-effect",
						successorRequestId: "new",
						reservations: [],
					},
				})
			).status,
		).toBe("recovered");
	});

	it("requires complete terminal financial proof and never releases a hold itself", async () => {
		const f = await started();
		let held = true;
		const deps = { ...f.deps, verifyFinancial: async () => !held };
		expect((await recoverIacRoute(deps, f.claim)).status).toBe("denied");
		expect(held).toBe(true);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		held = false;
		const duplicated = {
			...f.claim,
			outcome: {
				...f.claim.outcome,
				reservations: [
					{ reservationId: "r", status: "released" as const },
					{ reservationId: "r", status: "released" as const },
				],
			},
		};
		expect((await recoverIacRoute(deps, duplicated)).status).toBe("denied");
		expect((await recoverIacRoute(deps, f.claim)).status).toBe("recovered");
	});

	it("fails closed when authorization expires during verification", async () => {
		const f = await started();
		let now = Date.now();
		const result = await recoverIacRoute(
			{
				...f.deps,
				now: () => now,
				verifyProvider: async () => {
					now = f.claim.expiresAt;
					return true;
				},
			},
			f.claim,
		);
		expect(result.status).toBe("denied");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});
});

describe("fence causality", () => {
	it("rejects observations made before fencing when a paused executor creates an effect", async () => {
		const f = await started();
		let effectExists = false;
		const fenceTime = Date.now() - 500;

		const stale = {
			...f.claim,
			evidence: {
				fence: { ref: "fence:proof", establishedAt: fenceTime },
				provider: {
					ref: "old:no-effect",
					afterFence: "fence:proof",
					observedAt: fenceTime - 1,
				},
				financial: {
					ref: "old:no-hold",
					afterFence: "fence:proof",
					observedAt: fenceTime - 1,
				},
			},
		};
		effectExists = true;
		let invoked = false;
		const result = await recoverIacRoute(
			{
				...f.deps,
				verifyProvider: async () => {
					invoked = true;
					return !effectExists;
				},
			},
			stale,
		);
		expect(result.status).toBe("denied");
		expect(invoked).toBe(false);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("rejects equal timestamps, unrelated fence references and future observations", async () => {
		const f = await started();
		for (const provider of [
			{
				...f.claim.evidence.provider,
				observedAt: f.claim.evidence.fence.establishedAt,
			},
			{ ...f.claim.evidence.provider, afterFence: "another-fence" },
			{ ...f.claim.evidence.provider, observedAt: Date.now() + 10_000 },
		]) {
			expect(
				(
					await recoverIacRoute(f.deps, {
						...f.claim,
						evidence: { ...f.claim.evidence, provider },
					})
				).status,
			).toBe("denied");
		}
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("does not accept fresh-looking fields if the provider authority authenticates an older observation", async () => {
		const f = await started();
		const oldObservationTime = f.claim.evidence.fence.establishedAt - 1000;
		const forged = {
			...f.claim,
			evidence: {
				...f.claim.evidence,
				provider: {
					...f.claim.evidence.provider,
					ref: "signed-old-provider-result",
				},
			},
		};
		const result = await recoverIacRoute(
			{
				...f.deps,
				verifyProvider: async ({ claim }) =>
					claim.evidence.provider.ref === "signed-old-provider-result" &&
					claim.evidence.provider.observedAt === oldObservationTime,
			},
			forged,
		);
		expect(result.status).toBe("denied");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("round-trips all 256 reservation dispositions in a durable audit record", async () => {
		const f = await started();
		const reservations = Array.from({ length: 256 }, (_, index) => ({
			reservationId: `reservation-${String(index).padStart(3, "0")}-${"x".repeat(64)}`,
			status: "settled" as const,
		}));
		const claim = { ...f.claim, outcome: { ...f.claim.outcome, reservations } };
		expect((await recoverIacRoute(f.deps, claim)).status).toBe("recovered");
		const reopened = createSqliteIacRouteRecoveryStore({ path: f.path });
		closers.push(() => reopened.close());
		const record = await reopened.get(f.identity);
		expect(record?.claim.outcome.kind).toBe("no-effect");
		if (record?.claim.outcome.kind !== "no-effect")
			throw new Error("missing recovery");
		expect(record.claim.outcome.reservations).toEqual(reservations);
		expect(
			(await recoverIacRoute({ ...f.deps, store: reopened }, claim)).status,
		).toBe("replay");
	});
});

describe("recovery replay authorization", () => {
	it("does not disclose an existing result if authorization throws", async () => {
		const f = await started();
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("recovered");
		const result = await recoverIacRoute(
			{
				...f.deps,
				authorize: async () => {
					throw new Error("authorization unavailable");
				},
			},
			f.claim,
		);
		expect(result.status).toBe("uncertain");
	});
});

describe("operation lineage", () => {
	it("rejects a claim for a different logical operation", async () => {
		const f = await started();
		expect(
			(
				await recoverIacRoute(f.deps, {
					...f.claim,
					operationId: `sha256:${"d".repeat(64)}`,
				})
			).status,
		).toBe("denied");
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("fails the CAS when the logical operation changes while evidence is verified", async () => {
		const f = await started();
		const result = await recoverIacRoute(
			{
				...f.deps,
				verifyProvider: async () => {
					const db = new DatabaseSync(f.path);
					db.prepare(
						"UPDATE iac_route_operations SET request=? WHERE tenant=? AND operation_id=?",
					).run("changed", "tenant", operationId);
					db.close();
					return true;
				},
			},
			f.claim,
		);
		expect(result.status).toBe("uncertain");
		expect(await f.store.get(f.identity)).toBeUndefined();

		expect(await f.authority.verifyAttempt(f.permit)).toBe(false);
	});

	it("retains its audit after the operation legitimately advances to its successor", async () => {
		const f = await started();
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("recovered");
		const db = new DatabaseSync(f.path);
		const grant = db
			.prepare(
				"SELECT successor FROM iac_route_successors WHERE tenant=? AND operation_id=? AND predecessor=?",
			)
			.get("tenant", operationId, "request");
		expect(grant?.successor).toBe("retry-1");
		db.close();
		expect(
			(
				await f.authority.claim({
					tenantId: "tenant",
					requestId: "retry-1",
					operationId,
					authorization: "signed:retry-1",
				})
			).status,
		).toBe("claimed");
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("replay");
	});
});

describe("recovery audit integrity", () => {
	it("detects a tampered successor grant instead of reporting a replay", async () => {
		const f = await started();
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("recovered");
		const db = new DatabaseSync(f.path);
		db.prepare(
			"UPDATE iac_route_successors SET successor=? WHERE tenant=? AND operation_id=? AND predecessor=?",
		).run("forged", "tenant", operationId, "request");
		db.close();
		expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("uncertain");
	});

	it("creates no successor grant for an already-selected route", async () => {
		const f = await started();
		const outcome = {
			kind: "selected" as const,
			targetId: "yard-a",
			inventoryHash,
			financial: { disposition: "held" as const, reservationId: "hold-1" },
		};
		expect(
			(await recoverIacRoute(f.deps, { ...f.claim, outcome })).status,
		).toBe("recovered");
		const db = new DatabaseSync(f.path);
		const grant = db
			.prepare(
				"SELECT 1 FROM iac_route_successors WHERE tenant=? AND operation_id=? AND predecessor=?",
			)
			.get("tenant", operationId, "request");
		db.close();
		expect(grant).toBeUndefined();
	});
});

it("rolls back the entire recovery when authorization expires before commit", async () => {
	const f = await started();
	let reads = 0;
	const store = createSqliteIacRouteRecoveryStore({
		path: f.path,
		now: () => (++reads === 1 ? f.claim.expiresAt - 10 : f.claim.expiresAt),
	});
	closers.push(() => store.close());
	const result = await recoverIacRoute({ ...f.deps, store }, f.claim);
	expect(result.status).toBe("uncertain");
	expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	expect(await f.store.get(f.identity)).toBeUndefined();
	const db = new DatabaseSync(f.path);
	expect(
		db
			.prepare(
				"SELECT 1 FROM iac_route_successors WHERE tenant=? AND operation_id=?",
			)
			.get("tenant", operationId),
	).toBeUndefined();
	db.close();
});

it("rejects a selected recovery that also requests a successor", async () => {
	const f = await started();
	const outcome = {
		kind: "selected" as const,
		targetId: "yard-a",
		inventoryHash,
		financial: { disposition: "held" as const, reservationId: "hold" },
		successorRequestId: "unexpected-retry",
	};
	expect((await recoverIacRoute(f.deps, { ...f.claim, outcome })).status).toBe(
		"denied",
	);
	expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
});

it("executes only the recovery-granted retry and permits a later independent operation generation", async () => {
	const f = await started();
	expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("recovered");
	let effects = 0;
	const run = async (route: IacRouteController) => {
		const permit = await route.beginAttempt({
			targetId: "yard-b",
			inventoryHash,
		});
		expect(await f.authority.consumeAttempt(permit)).toBe(true);
		effects++;
		return {
			value: "ok",
			outcome: { status: "selected" as const, targetId: "yard-b" },
		};
	};
	const route = (
		requestId: string,
		generation = operationId,
		authorization = `signed:${requestId}`,
	) =>
		runIacRoute({
			authority: f.authority,
			tenantId: "tenant",
			requestId,
			operation: { operationId: generation, authorization },
			run,
		});
	expect((await route("unapproved")).status).toBe("replay");
	expect((await route("retry-1", operationId, "forged")).status).toBe(
		"uncertain",
	);
	expect((await route("retry-1")).status).toBe("executed");
	expect((await route("retry-1")).status).toBe("replay");
	expect((await recoverIacRoute(f.deps, f.claim)).status).toBe("replay");
	expect(effects).toBe(1);
	const nextGeneration = `sha256:${"e".repeat(64)}`;
	expect((await route("new-intent", nextGeneration)).status).toBe("executed");
	expect(effects).toBe(2);
});

const verificationStates = [false, true].flatMap((fence) =>
	[false, true].flatMap((provider) =>
		[false, true].flatMap((financial) =>
			(["no-effect", "selected"] as const).map((kind) => ({
				fence,
				provider,
				financial,
				kind,
			})),
		),
	),
);
it.each(
	verificationStates,
)("requires every verifier for $kind (fence=$fence, provider=$provider, financial=$financial)", async ({
	fence,
	provider,
	financial,
	kind,
}) => {
	const f = await started();
	const outcome =
		kind === "no-effect"
			? f.claim.outcome
			: {
					kind: "selected" as const,
					targetId: "yard-a",
					inventoryHash,
					financial: { disposition: "held" as const, reservationId: "hold" },
				};
	const result = await recoverIacRoute(
		{
			...f.deps,
			verifyFence: async () => fence,
			verifyProvider: async () => provider,
			verifyFinancial: async () => financial,
		},
		{ ...f.claim, outcome },
	);
	const verified = fence && provider && financial;
	expect(result.status).toBe(verified ? "recovered" : "denied");
	expect(await f.authority.verifyAttempt(f.permit)).toBe(!verified);
	const record = await f.store.get(f.identity);
	expect(record !== undefined).toBe(verified);
});

it("recovers an exhausted denied route and executes exactly its authorized successor", async () => {
	const f = await started();
	await f.authority.denyAttempt({
		...f.identity,
		claimToken: f.owner.claimToken,
		permit: f.permit,
	});
	await f.authority.finish({
		...f.identity,
		claimToken: f.owner.claimToken,
		outcome: { status: "denied" },
	});
	const snapshot = await f.store.inspect(f.identity);
	if (!snapshot) throw new Error("snapshot missing");
	const claim = { ...f.claim, expectedVersion: snapshot.version };
	expect((await recoverIacRoute(f.deps, claim)).status).toBe("recovered");
	let effects = 0;
	const result = await runIacRoute({
		authority: f.authority,
		tenantId: "tenant",
		requestId: "retry-1",
		operation: { operationId, authorization: "signed:retry-1" },
		run: async (route) => {
			const permit = await route.beginAttempt({
				targetId: "yard-b",
				inventoryHash,
			});
			expect(await f.authority.consumeAttempt(permit)).toBe(true);
			effects++;
			return {
				value: "done",
				outcome: { status: "selected", targetId: "yard-b" },
			};
		},
	});
	expect(result.status).toBe("executed");
	expect(effects).toBe(1);
	expect((await recoverIacRoute(f.deps, claim)).status).toBe("replay");
});

it("refuses a denied record with an unexplained finished attempt", async () => {
	const f = await started();
	await f.authority.finish({
		...f.identity,
		claimToken: f.owner.claimToken,
		outcome: { status: "uncertain", targetId: "yard-a" },
	});
	const db = new DatabaseSync(f.path);
	db.prepare(
		"UPDATE iac_routes SET outcome=? WHERE tenant=? AND request=?",
	).run(JSON.stringify({ status: "denied" }), "tenant", "request");
	db.close();
	const snapshot = await f.store.inspect(f.identity);
	if (!snapshot) throw new Error("snapshot missing");
	expect(
		(
			await recoverIacRoute(f.deps, {
				...f.claim,
				expectedVersion: snapshot.version,
			})
		).status,
	).toBe("denied");
	expect(await f.store.get(f.identity)).toBeUndefined();
});

it("requires all independent proofs again for an exhausted denial", async () => {
	const f = await started();
	await f.authority.denyAttempt({
		...f.identity,
		claimToken: f.owner.claimToken,
		permit: f.permit,
	});
	await f.authority.finish({
		...f.identity,
		claimToken: f.owner.claimToken,
		outcome: { status: "denied" },
	});
	const snapshot = await f.store.inspect(f.identity);
	if (!snapshot) throw new Error("snapshot missing");
	expect(
		(
			await recoverIacRoute(
				{ ...f.deps, verifyFinancial: async () => false },
				{ ...f.claim, expectedVersion: snapshot.version },
			)
		).status,
	).toBe("denied");
	expect(await f.store.get(f.identity)).toBeUndefined();
});

it("never reopens an already-selected route", async () => {
	const f = await started();
	expect(await f.authority.consumeAttempt(f.permit)).toBe(true);
	await f.authority.finish({
		...f.identity,
		claimToken: f.owner.claimToken,
		outcome: { status: "selected", targetId: "yard-a" },
	});
	const snapshot = await f.store.inspect(f.identity);
	if (!snapshot) throw new Error("snapshot missing");
	expect(
		(
			await recoverIacRoute(f.deps, {
				...f.claim,
				expectedVersion: snapshot.version,
			})
		).status,
	).toBe("denied");
	expect(await f.store.get(f.identity)).toBeUndefined();
});

describe("recovery store trust boundary", () => {
	it.each([
		"file::memory:?cache=shared",
		"file:recovery-volatile?mode=memory&cache=shared",
	])("rejects a memory-backed SQLite URI even with a complete journal schema: %s", (path) => {
		const db = new DatabaseSync(path);
		db.exec(`CREATE TABLE iac_routes(tenant TEXT,request TEXT,PRIMARY KEY(tenant,request));
			CREATE TABLE iac_route_attempts(consumed INTEGER);
			CREATE TABLE iac_route_operations(tenant TEXT);
			CREATE TABLE iac_route_successors(tenant TEXT);`);
		expect(() => {
			const store = createSqliteIacRouteRecoveryStore({ path });
			store.close();
		}).toThrow();
		db.close();
	});

	it("rejects accessor-based identity redirection before reading the ledger", async () => {
		const f = await started();
		let reads = 0;
		const identity = {
			tenantId: "tenant",
			get requestId() {
				reads++;
				return reads === 1 ? "request" : "other";
			},
		};
		expect(() => f.store.inspect(identity)).toThrow();
		expect(() => f.store.get(identity)).toThrow();
		expect(reads).toBe(0);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("rejects an accessor that changes the digest during commit", async () => {
		const f = await started();
		const claim = normalizeIacRouteRecoveryClaim(f.claim);
		if (!claim) throw new Error("claim missing");
		let reads = 0;
		const input = {
			claim,
			get claimDigest() {
				reads++;
				return recoveryClaimDigest(claim);
			},
		};
		expect(() => f.store.commit(input)).toThrow();
		expect(reads).toBe(0);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});
});

it("rejects accessor-based store configuration before opening a path", async () => {
	const f = await started();
	let reads = 0;
	const options = {
		get path() {
			reads++;
			return f.path;
		},
	};
	expect(() => createSqliteIacRouteRecoveryStore(options)).toThrow();
	expect(reads).toBe(0);
});

describe("recovery inputs with hostile descriptors", () => {
	it("rejects proxied claims and store inputs after the proxy predicate changes", async () => {
		const f = await started();
		let traps = 0;
		const original = Object.getOwnPropertyDescriptor(utilTypes, "isProxy");
		const proxy = <T extends object>(value: T): T =>
			new Proxy(value, {
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("descriptor trap");
				},
				get() {
					traps++;
					throw new Error("get trap");
				},
			});
		let pending: ReturnType<typeof recoverIacRoute>;
		const refused: boolean[] = [];
		try {
			Object.defineProperty(utilTypes, "isProxy", {
				configurable: true,
				value: () => false,
			});
			pending = recoverIacRoute(f.deps, proxy(f.claim));
			for (const call of [
				() => createSqliteIacRouteRecoveryStore(proxy({ path: f.path })),
				() => f.store.inspect(proxy(f.identity)),
				() => f.store.get(proxy(f.identity)),
				() =>
					f.store.commit(
						proxy({ claim: f.claim, claimDigest: "sha256:invalid" }),
					),
			]) {
				try {
					call();
					refused.push(false);
				} catch {
					refused.push(true);
				}
			}
		} finally {
			if (original) Object.defineProperty(utilTypes, "isProxy", original);
		}
		expect(await pending).toEqual({ status: "denied" });
		expect(refused).toEqual([true, true, true, true]);
		expect(traps).toBe(0);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
	});

	it("rejects proxied claims and evidence without invoking traps or authorities", async () => {
		const f = await started();
		let traps = 0;
		let calls = 0;
		const proxy = <T extends object>(value: T): T =>
			new Proxy(value, {
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("descriptor trap");
				},
				get() {
					traps++;
					throw new Error("get trap");
				},
			});
		const deps = {
			...f.deps,
			store: {
				...f.store,
				get: () => {
					calls++;
					return undefined;
				},
				inspect: () => {
					calls++;
					return undefined;
				},
				commit: () => {
					calls++;
				},
			},
			authorize: () => {
				calls++;
				return true;
			},
			verifyFence: () => {
				calls++;
				return true;
			},
			verifyProvider: () => {
				calls++;
				return true;
			},
			verifyFinancial: () => {
				calls++;
				return true;
			},
		};
		const claim = f.claim;
		const cases = [
			proxy(claim),
			{ ...claim, evidence: proxy(claim.evidence) },
			{
				...claim,
				evidence: { ...claim.evidence, fence: proxy(claim.evidence.fence) },
			},
			{
				...claim,
				evidence: {
					...claim.evidence,
					provider: proxy(claim.evidence.provider),
				},
			},
			{
				...claim,
				evidence: {
					...claim.evidence,
					financial: proxy(claim.evidence.financial),
				},
			},
			{ ...claim, outcome: proxy(claim.outcome) },
			{ ...claim, outcome: { ...claim.outcome, reservations: proxy([]) } },
			{
				...claim,
				outcome: {
					...claim.outcome,
					reservations: [
						proxy({ reservationId: "r", status: "released" as const }),
					],
				},
			},
		];
		for (const candidate of cases)
			expect(await recoverIacRoute(deps, candidate)).toEqual({
				status: "denied",
			});
		expect(traps).toBe(0);
		expect(calls).toBe(0);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		expect(await f.store.get(f.identity)).toBeUndefined();
	});

	it("ignores inherited descriptor values for claim, store identity, commit and options", async () => {
		const f = await started();
		let traps = 0;
		const badClaim = {
			...f.claim,
			get tenantId() {
				traps++;
				return "tenant";
			},
		};
		const badFence = {
			...f.claim.evidence.fence,
			get ref() {
				traps++;
				return "fence:evidence";
			},
		};
		const badReservations: typeof f.claim.outcome.reservations = [];
		Object.defineProperty(badReservations, "0", {
			enumerable: true,
			get() {
				traps++;
				return { reservationId: "r", status: "released" };
			},
		});
		const badNestedClaim = {
			...f.claim,
			evidence: { ...f.claim.evidence, fence: badFence },
		};
		const badArrayClaim = {
			...f.claim,
			outcome: { ...f.claim.outcome, reservations: badReservations },
		};
		const badIdentity = {
			...f.identity,
			get requestId() {
				traps++;
				return "request";
			},
		};
		const badCommit = {
			claim: f.claim,
			get claimDigest() {
				traps++;
				return "sha256:invalid";
			},
		};
		const badOptions = {
			get path() {
				traps++;
				return f.path;
			},
		};
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		const outcomes: boolean[] = [];
		let results: ReturnType<typeof recoverIacRoute>[] = [];
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					traps++;
					return "tenant";
				},
			});
			results = [
				recoverIacRoute(f.deps, badClaim),
				recoverIacRoute(f.deps, badNestedClaim),
				recoverIacRoute(f.deps, badArrayClaim),
			];
			for (const call of [
				() => f.store.inspect(badIdentity),
				() => f.store.get(badIdentity),
				() => f.store.commit(badCommit),
				() => createSqliteIacRouteRecoveryStore(badOptions),
			]) {
				try {
					call();
					outcomes.push(false);
				} catch {
					outcomes.push(true);
				}
			}
		} finally {
			if (previous) Object.defineProperty(Object.prototype, "value", previous);
			else Reflect.deleteProperty(Object.prototype, "value");
		}
		expect(await Promise.all(results)).toEqual([
			{ status: "denied" },
			{ status: "denied" },
			{ status: "denied" },
		]);
		expect(outcomes).toEqual([true, true, true, true]);
		expect(traps).toBe(0);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		expect(await f.store.get(f.identity)).toBeUndefined();
	});

	it("rejects proxied store inputs and clock before reading SQLite", async () => {
		const f = await started();
		let traps = 0;
		const proxy = <T extends object>(value: T): T =>
			new Proxy(value, {
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("descriptor trap");
				},
				get() {
					traps++;
					throw new Error("get trap");
				},
				apply() {
					traps++;
					throw new Error("apply trap");
				},
			});
		const claim = normalizeIacRouteRecoveryClaim(f.claim);
		if (!claim) throw new Error("claim missing");
		expect(() =>
			createSqliteIacRouteRecoveryStore(proxy({ path: f.path })),
		).toThrow();
		expect(() =>
			createSqliteIacRouteRecoveryStore({
				path: f.path,
				now: proxy(() => Date.now()),
			}),
		).toThrow();
		expect(() => f.store.inspect(proxy(f.identity))).toThrow();
		expect(() => f.store.get(proxy(f.identity))).toThrow();
		expect(() =>
			f.store.commit(proxy({ claim, claimDigest: recoveryClaimDigest(claim) })),
		).toThrow();
		expect(() =>
			f.store.commit({
				claim: proxy(claim),
				claimDigest: recoveryClaimDigest(claim),
			}),
		).toThrow();
		expect(traps).toBe(0);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		expect(await f.store.get(f.identity)).toBeUndefined();
	});
});

describe("recovery host capability capture", () => {
	it("does not replace a denying financial verifier while authorization is pending", async () => {
		const f = await started();
		let enter = () => {};
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		let checked = 0;
		let forged = 0;
		const deps = {
			...f.deps,
			authorize: async () => {
				enter();
				await paused;
				return true;
			},
			verifyFinancial: async () => {
				checked++;
				return false;
			},
		};
		const pending = recoverIacRoute(deps, f.claim);
		await entered;
		deps.verifyFinancial = async () => {
			forged++;
			return true;
		};
		release();
		expect(await pending).toEqual({ status: "denied" });
		expect(checked).toBe(1);
		expect(forged).toBe(0);
		expect(await f.authority.verifyAttempt(f.permit)).toBe(true);
		expect(await f.store.get(f.identity)).toBeUndefined();
	});

	it("pins the store, callbacks and detached receivers through a lost commit acknowledgement", async () => {
		const f = await started();
		let enter = () => {};
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		let forged = 0;
		let authorizations = 0;
		let receiversStable = true;
		const now = () => Date.now();
		const store: IacRouteRecoveryStore = {
			persistence: "durable-cas",
			get(identity: Parameters<IacRouteRecoveryStore["get"]>[0]) {
				receiversStable &&= Object.isFrozen(this) && this.get === get;
				return f.store.get(identity);
			},
			inspect(identity: Parameters<IacRouteRecoveryStore["inspect"]>[0]) {
				receiversStable &&= Object.isFrozen(this) && this.inspect === inspect;
				return f.store.inspect(identity);
			},
			commit(input: Parameters<typeof f.store.commit>[0]) {
				receiversStable &&= Object.isFrozen(this) && this.commit === commit;
				f.store.commit(input);
				throw new Error("lost acknowledgement");
			},
		};
		const { get, inspect, commit } = store;
		const deps = {
			...f.deps,
			store,
			now,
			async authorize() {
				authorizations++;
				if (authorizations === 1) {
					enter();
					await paused;
				}
				receiversStable &&=
					Object.isFrozen(this) &&
					this.now === now &&
					Object.isFrozen(this.store) &&
					this.store.get === get &&
					this.store.inspect === inspect &&
					this.store.commit === commit;
				return true;
			},
		};
		const pending = recoverIacRoute(deps, f.claim);
		await entered;
		store.get = () => {
			forged++;
			return undefined;
		};
		store.inspect = () => {
			forged++;
			return undefined;
		};
		store.commit = () => {
			forged++;
		};
		deps.store = { ...store };
		deps.now = () => 0;
		deps.authorize = async () => {
			forged++;
			return false;
		};
		deps.verifyFinancial = async () => {
			forged++;
			return false;
		};
		release();
		expect(await pending).toMatchObject({
			status: "replay",
			outcome: { kind: "no-effect" },
		});
		expect(authorizations).toBe(2);
		expect(receiversStable).toBe(true);
		expect(forged).toBe(0);
		expect(await f.store.get(f.identity)).toBeDefined();
		expect(await f.authority.verifyAttempt(f.permit)).toBe(false);
	});
});
