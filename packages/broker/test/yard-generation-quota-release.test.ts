import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	contentHashOf,
	createSqliteYardGenerationQuotaAuthority,
	type YardGenerationQuotaRequest,
} from "../src/index.js";

function request(id: string): YardGenerationQuotaRequest {
	return {
		idempotencyKey: contentHashOf({ key: id }),
		attemptId: `attempt:${id}`,
		ownerTenantId: "tenant",
		yardId: `yard:${id}`,
		planHash: contentHashOf({ plan: id }),
		maxConcurrentGenerations: 1,
		maxYardsPerTenant: 2,
	};
}
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-quota-release-"));
	const options = {
		path: join(directory, "quota.sqlite"),
		scopeId: "scope:release",
		initialYards: [],
		maxConcurrentGenerations: 1,
		maxYardsPerTenant: 2,
		verifyReady: () => true,
	};
	const authority = createSqliteYardGenerationQuotaAuthority(options);
	return { directory, options, authority };
}

describe("durable generation quota cancellation", () => {
	it("releases only an unclaimed reservation and forbids reuse of its key", () => {
		const { authority, directory } = setup();
		try {
			const a = request("a");
			expect(authority.reserve(a).kind).toBe("reserved");
			expect(authority.lookup(a.idempotencyKey)?.executionClaimed).toBe(false);
			expect(() =>
				authority.cancelUnclaimed({ ...a, ownerTenantId: "foreign" }),
			).toThrow();
			expect(authority.cancelUnclaimed(a).kind).toBe("cancelled");
			expect(authority.cancelUnclaimed(a).kind).toBe("existing");
			expect(authority.lookup(a.idempotencyKey)).toBeUndefined();
			expect(authority.lookupCancellation(a.idempotencyKey)).toBe(
				contentHashOf(a),
			);
			expect(() =>
				authority.cancelUnclaimed({ ...a, ownerTenantId: "foreign" }),
			).toThrow();
			expect(() => authority.reserve(a)).toThrow(/cancelled/u);
			expect(() => authority.claimExecution(a)).toThrow();
			expect(authority.reserve(request("b")).kind).toBe("reserved");
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("retains a claimed slot until trusted readiness and makes duplicate claims inspect-only", () => {
		const { authority, directory } = setup();
		try {
			const a = request("a");
			authority.reserve(a);
			expect(authority.claimExecution(a).kind).toBe("claimed");
			expect(authority.claimExecution(a).kind).toBe("existing");
			expect(authority.lookup(a.idempotencyKey)?.executionClaimed).toBe(true);
			expect(() => authority.cancelUnclaimed(a)).toThrow(/claimed/u);
			expect(() => authority.reserve(request("b"))).toThrow(/concurrency/u);
			const ready = authority.markReady({
				...a,
				evidenceRef: "verified:ready",
			});
			expect(ready.status).toBe("ready");
			expect(() => authority.cancelUnclaimed(a)).toThrow();
			expect(authority.reserve(request("b")).kind).toBe("reserved");
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("treats every pre-upgrade pending reservation as already claimed", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-quota-legacy-"));
		const path = join(directory, "quota.sqlite");
		const options = {
			path,
			scopeId: "scope:legacy",
			initialYards: [],
			maxConcurrentGenerations: 1,
			maxYardsPerTenant: 2,
			verifyReady: () => true,
		};
		const a = request("legacy");
		const db = new DatabaseSync(path);
		try {
			db.exec(
				"CREATE TABLE generation_quota_meta (id INTEGER PRIMARY KEY CHECK(id=1), scope_id TEXT NOT NULL, baseline_hash TEXT NOT NULL); CREATE TABLE generation_quota_baseline (yard_id TEXT PRIMARY KEY, owner_tenant_id TEXT NOT NULL); CREATE TABLE generation_quota_claims (idempotency_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, owner_tenant_id TEXT NOT NULL, yard_id TEXT NOT NULL UNIQUE, plan_hash TEXT NOT NULL, max_concurrent INTEGER NOT NULL, max_yards INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','ready')), ready_evidence_ref TEXT)",
			);
			const legacyHash = contentHashOf({
				scopeId: options.scopeId,
				maxConcurrentGenerations: 1,
				maxYardsPerTenant: 2,
				yards: [],
			});
			db.prepare("INSERT INTO generation_quota_meta VALUES(1,?,?)").run(
				options.scopeId,
				legacyHash,
			);
			db.prepare(
				"INSERT INTO generation_quota_claims VALUES(?,?,?,?,?,?,?,'pending',NULL)",
			).run(
				a.idempotencyKey,
				a.attemptId,
				a.ownerTenantId,
				a.yardId,
				a.planHash,
				a.maxConcurrentGenerations,
				a.maxYardsPerTenant,
			);
			// A failed scope check must not install guards on another legacy store.
			expect(() =>
				createSqliteYardGenerationQuotaAuthority({
					...options,
					scopeId: "wrong",
				}),
			).toThrow(/baseline/u);
			db.prepare(
				"UPDATE generation_quota_claims SET status='pending' WHERE idempotency_key=?",
			).run(a.idempotencyKey);
			const authority = createSqliteYardGenerationQuotaAuthority(options);
			try {
				expect(authority.lookup(a.idempotencyKey)?.executionClaimed).toBe(true);
				expect(() => authority.cancelUnclaimed(a)).toThrow(/claimed/u);
				expect(authority.claimExecution(a).kind).toBe("existing");
				// This connection was opened before migration, like a running old process.
				expect(() =>
					db
						.prepare(
							"UPDATE generation_quota_claims SET status='ready', ready_evidence_ref='old' WHERE idempotency_key=?",
						)
						.run(a.idempotencyKey),
				).toThrow(/fencing/u);
				expect(() =>
					db
						.prepare(
							"DELETE FROM generation_quota_claims WHERE idempotency_key=?",
						)
						.run(a.idempotencyKey),
				).toThrow(/fencing/u);
				const b = request("legacy-writer");
				expect(() =>
					db
						.prepare(
							"INSERT INTO generation_quota_claims VALUES(?,?,?,?,?,?,?,'pending',NULL)",
						)
						.run(
							b.idempotencyKey,
							b.attemptId,
							b.ownerTenantId,
							b.yardId,
							b.planHash,
							b.maxConcurrentGenerations,
							b.maxYardsPerTenant,
						),
				).toThrow(/fencing/u);
			} finally {
				authority.close();
			}
		} finally {
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves cancellation and claim invariants across generated operation histories", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom("reserve", "claim", "cancel"), {
					minLength: 1,
					maxLength: 20,
				}),
				(events) => {
					const { authority, directory } = setup();
					const a = request("history");
					let state: "absent" | "pending" | "claimed" | "cancelled" = "absent";
					try {
						for (const event of events) {
							if (event === "reserve") {
								if (state === "cancelled")
									expect(() => authority.reserve(a)).toThrow();
								else {
									authority.reserve(a);
									if (state === "absent") state = "pending";
								}
							} else if (event === "claim") {
								if (state === "absent" || state === "cancelled")
									expect(() => authority.claimExecution(a)).toThrow();
								else {
									authority.claimExecution(a);
									state = "claimed";
								}
							} else if (state === "pending" || state === "cancelled") {
								authority.cancelUnclaimed(a);
								state = "cancelled";
							} else expect(() => authority.cancelUnclaimed(a)).toThrow();
							expect(authority.lookup(a.idempotencyKey)?.executionClaimed).toBe(
								state === "claimed"
									? true
									: state === "pending"
										? false
										: undefined,
							);
						}
					} finally {
						authority.close();
						rmSync(directory, { recursive: true, force: true });
					}
				},
			),
			{ seed: 614_602, numRuns: 40 },
		);
	});

	it.each([
		["claim", "cancel"],
		["claim", "claim"],
	])("serializes real %s and %s operations", async (first, second) => {
		const { authority, directory, options } = setup();
		const a = request("race");
		authority.reserve(a);
		const entry = new URL(
			"../src/yard-placement/generation-quota.ts",
			import.meta.url,
		).href;
		const code = `const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {tsImport}=await import('tsx/esm/api'); const {createSqliteYardGenerationQuotaAuthority}=await tsImport(workerData.entry,workerData.entry); const a=createSqliteYardGenerationQuotaAuthority(workerData.options); parentPort.on('message',()=>{try{const result=workerData.action==='claim'?a.claimExecution(workerData.request):a.cancelUnclaimed(workerData.request); parentPort.postMessage({kind:result.kind});}catch(e){parentPort.postMessage({kind:'denied'});}finally{a.close();parentPort.close();}});parentPort.postMessage({ready:true});})().catch(e=>parentPort.postMessage({error:String(e)}));`;
		const workerOptions = { ...options, verifyReady: undefined };
		const workers = [first, second].map(
			(action) =>
				new Worker(code, {
					eval: true,
					workerData: { entry, options: workerOptions, request: a, action },
				}),
		);
		try {
			await Promise.all(workers.map((w) => once(w, "message")));
			const replies = workers.map((w) => once(w, "message"));
			for (const worker of workers) worker.postMessage("go");
			const values = (await Promise.all(replies))
				.map(([value]) => value.kind)
				.sort();
			const allowed =
				second === "claim"
					? [["claimed", "existing"]]
					: [
							["cancelled", "denied"],
							["claimed", "denied"],
						];
			expect(allowed.map((value) => JSON.stringify(value))).toContain(
				JSON.stringify(values),
			);
			if (values.includes("claimed"))
				expect(authority.lookup(a.idempotencyKey)?.executionClaimed).toBe(true);
			else expect(authority.lookup(a.idempotencyKey)).toBeUndefined();
		} finally {
			await Promise.all(workers.map((w) => w.terminate()));
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
