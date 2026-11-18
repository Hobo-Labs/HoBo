import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	contentHashOf,
	createSqliteYardGenerationQuotaAuthority,
	type YardGenerationQuotaRequest,
} from "../src/index.js";

function request(id: string, tenant = "tenant-a"): YardGenerationQuotaRequest {
	return {
		idempotencyKey: contentHashOf({ key: id }),
		attemptId: `attempt:${id}`,
		ownerTenantId: tenant,
		yardId: `yard:${id}`,
		planHash: contentHashOf({ plan: id }),
		maxConcurrentGenerations: 2,
		maxYardsPerTenant: 2,
	};
}

function setup(
	initialYards: readonly { yardId: string; ownerTenantId: string }[] = [],
) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-generation-quota-"));
	const path = join(directory, "quota.sqlite");
	const options = {
		path,
		scopeId: "scope:example",
		initialYards,
		maxConcurrentGenerations: 2,
		maxYardsPerTenant: 2,
		verifyReady: (input: { evidenceRef: string }) =>
			input.evidenceRef === "verified:ready",
	};
	const authority = createSqliteYardGenerationQuotaAuthority(options);
	return { directory, path, options, authority };
}

function markReady(
	authority: ReturnType<typeof setup>["authority"],
	claim: YardGenerationQuotaRequest,
	evidenceRef = "verified:ready",
) {
	authority.claimExecution(claim);
	return authority.markReady({
		idempotencyKey: claim.idempotencyKey,
		attemptId: claim.attemptId,
		ownerTenantId: claim.ownerTenantId,
		planHash: claim.planHash,
		yardId: claim.yardId,
		evidenceRef,
	});
}

describe("durable Yard generation quota authority", () => {
	it("serializes capacity and retains uncertain claims until verified ready", () => {
		const { authority, directory } = setup();
		try {
			const a = request("a");
			const b = request("b", "tenant-b");
			const c = request("c", "tenant-c");
			expect(authority.reserve(a).kind).toBe("reserved");
			expect(authority.reserve(b).kind).toBe("reserved");
			expect(() => authority.reserve(c)).toThrow(/concurrency limit/u);
			expect(() => markReady(authority, a, "untrusted")).toThrow(
				/not verified/u,
			);
			expect(authority.lookup(a.idempotencyKey)?.status).toBe("pending");
			expect(() => authority.reserve(c)).toThrow(/concurrency limit/u);
			expect(markReady(authority, a).status).toBe("ready");
			expect(markReady(authority, a).status).toBe("ready");
			expect(authority.reserve(c).kind).toBe("reserved");
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("counts baseline and ready Yards against the tenant limit", () => {
		const { authority, directory } = setup([
			{ yardId: "yard:existing", ownerTenantId: "tenant-a" },
		]);
		try {
			const a = request("a");
			expect(() =>
				authority.reserve({ ...request("fresh"), maxConcurrentGenerations: 3 }),
			).toThrow(/fixed limits/u);
			expect(() =>
				authority.reserve({ ...request("fresh"), maxYardsPerTenant: 3 }),
			).toThrow(/fixed limits/u);
			expect(authority.reserve(a).kind).toBe("reserved");
			markReady(authority, a);
			expect(() => authority.reserve(request("b"))).toThrow(
				/tenant Yard limit/u,
			);
			expect(authority.reserve(request("c", "tenant-b")).kind).toBe("reserved");
			expect(() =>
				authority.reserve({ ...request("d"), yardId: "yard:existing" }),
			).toThrow(/already exists/u);
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("admits no additional Yard when the initial inventory is already over limit", () => {
		const fixture = setup([
			{ yardId: "yard:one", ownerTenantId: "tenant-a" },
			{ yardId: "yard:two", ownerTenantId: "tenant-a" },
			{ yardId: "yard:three", ownerTenantId: "tenant-a" },
		]);
		try {
			expect(() => fixture.authority.reserve(request("new"))).toThrow(
				/tenant Yard limit/u,
			);
			expect(
				fixture.authority.lookup(request("new").idempotencyKey),
			).toBeUndefined();
		} finally {
			fixture.authority.close();
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("binds idempotent retries to the entire claim and fixed scope limits", () => {
		const { authority, directory } = setup();
		try {
			const a = request("a");
			expect(authority.reserve(a).kind).toBe("reserved");
			expect(authority.reserve({ ...a }).kind).toBe("existing");
			for (const changed of [
				{ attemptId: "another" },
				{ ownerTenantId: "another" },
				{ yardId: "yard:another" },
				{ planHash: contentHashOf("another") },
				{ maxConcurrentGenerations: 3 },
				{ maxYardsPerTenant: 3 },
			])
				expect(() => authority.reserve({ ...a, ...changed })).toThrow();
			for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
				expect(() =>
					authority.reserve({
						...request("other"),
						maxConcurrentGenerations: invalid,
					}),
				).toThrow();
			expect(authority.lookup(a.idempotencyKey)?.status).toBe("pending");
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves claims across connections and refuses a different baseline", () => {
		const first = setup([
			{ yardId: "yard:existing", ownerTenantId: "tenant-a" },
		]);
		try {
			const a = request("a");
			first.authority.reserve(a);
			const second = createSqliteYardGenerationQuotaAuthority(first.options);
			try {
				expect(second.reserve(a).kind).toBe("existing");
				expect(() => second.reserve(request("b"))).toThrow(
					/tenant Yard limit/u,
				);
				markReady(second, a);
				expect(first.authority.lookup(a.idempotencyKey)?.status).toBe("ready");
			} finally {
				second.close();
			}
			expect(() =>
				createSqliteYardGenerationQuotaAuthority({
					...first.options,
					initialYards: [],
				}),
			).toThrow(/stored baseline/u);
			expect(() =>
				createSqliteYardGenerationQuotaAuthority({
					...first.options,
					maxConcurrentGenerations: 3,
				}),
			).toThrow(/stored baseline/u);
		} finally {
			first.authority.close();
			rmSync(first.directory, { recursive: true, force: true });
		}
	});

	it("refuses in-memory SQLite databases disguised as URI paths", () => {
		const fixture = setup();
		try {
			for (const path of [
				":memory:",
				"file::memory:?cache=shared",
				"file:quota-memory?mode=memory&cache=shared",
			])
				expect(() =>
					createSqliteYardGenerationQuotaAuthority({
						...fixture.options,
						path,
					}),
				).toThrow(/persistent/u);
		} finally {
			fixture.authority.close();
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});

	it("requires ready evidence to match the stored attempt, plan and Yard", () => {
		const { authority, directory } = setup();
		try {
			const a = request("a");
			authority.reserve(a);
			authority.claimExecution(a);
			for (const changed of [
				{ attemptId: "wrong" },
				{ ownerTenantId: "wrong-tenant" },
				{ yardId: "yard:wrong" },
				{ planHash: contentHashOf("wrong") },
			])
				expect(() =>
					authority.markReady({
						...a,
						...changed,
						evidenceRef: "verified:ready",
					}),
				).toThrow();
			expect(authority.lookup(a.idempotencyKey)?.status).toBe("pending");
			markReady(authority, a);
			expect(() => markReady(authority, a, "untrusted")).toThrow();
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("matches a reference model over generated reserve and ready histories", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.integer({ min: 0, max: 3 }),
						tenant: fc.constantFrom("tenant-a", "tenant-b"),
						ready: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 18 },
				),
				(history) => {
					const { authority, directory } = setup([
						{ yardId: "yard:existing", ownerTenantId: "tenant-a" },
					]);
					const claims = new Map<number, { tenant: string; ready: boolean }>();
					try {
						for (const event of history) {
							const current = claims.get(event.id);
							const claim = request(String(event.id), event.tenant);
							if (event.ready) {
								if (!current || current.tenant !== event.tenant)
									expect(() => markReady(authority, claim)).toThrow();
								else {
									markReady(authority, claim);
									current.ready = true;
								}
								continue;
							}
							if (current) {
								if (current.tenant === event.tenant)
									expect(authority.reserve(claim).kind).toBe("existing");
								else expect(() => authority.reserve(claim)).toThrow();
								continue;
							}
							const active = [...claims.values()].filter(
								(item) => !item.ready,
							).length;
							const tenant =
								[...claims.values()].filter(
									(item) => item.tenant === event.tenant,
								).length + (event.tenant === "tenant-a" ? 1 : 0);
							if (active >= 2 || tenant >= 2)
								expect(() => authority.reserve(claim)).toThrow();
							else {
								expect(authority.reserve(claim).kind).toBe("reserved");
								claims.set(event.id, { tenant: event.tenant, ready: false });
							}
						}
					} finally {
						authority.close();
						rmSync(directory, { recursive: true, force: true });
					}
				},
			),
			{ seed: 614_597, numRuns: 40 },
		);
	});

	it("admits at most one simultaneous claim for the last global slot", async () => {
		const fixture = setup();
		const seed = request("seed", "tenant-seed");
		fixture.authority.reserve(seed);
		const entry = new URL(
			"../src/yard-placement/generation-quota.ts",
			import.meta.url,
		).href;
		const source = `
			const { parentPort, workerData } = require('node:worker_threads');
			(async () => {
			  const { tsImport } = await import('tsx/esm/api');
			  const { createSqliteYardGenerationQuotaAuthority } = await tsImport(workerData.entry, workerData.entry);
			  const authority = createSqliteYardGenerationQuotaAuthority(workerData.options);
			  parentPort.on('message', () => {
			    try { parentPort.postMessage({ outcome: authority.reserve(workerData.request).kind }); }
			    catch (error) { parentPort.postMessage({ outcome: error.code || 'unexpected', message: String(error) }); }
			    finally { authority.close(); parentPort.close(); }
			  });
			  parentPort.postMessage({ ready: true });
			})().catch(error => parentPort.postMessage({ error: String(error) }));`;
		const workerOptions = { ...fixture.options, verifyReady: undefined };
		const a = new Worker(source, {
			eval: true,
			execArgv: ["--import", "tsx"],
			workerData: {
				entry,
				options: workerOptions,
				request: request("a", "tenant-a"),
			},
		});
		const b = new Worker(source, {
			eval: true,
			execArgv: ["--import", "tsx"],
			workerData: {
				entry,
				options: workerOptions,
				request: request("b", "tenant-b"),
			},
		});
		try {
			const readyA = once(a, "message");
			const readyB = once(b, "message");
			expect((await readyA)[0]).toEqual({ ready: true });
			expect((await readyB)[0]).toEqual({ ready: true });
			const resultA = once(a, "message");
			const resultB = once(b, "message");
			a.postMessage("reserve");
			b.postMessage("reserve");
			const values = [(await resultA)[0], (await resultB)[0]];
			expect(values).toEqual(
				expect.arrayContaining([
					{ outcome: "reserved" },
					expect.objectContaining({ outcome: "concurrent-limit" }),
				]),
			);
		} finally {
			await a.terminate();
			await b.terminate();
			fixture.authority.close();
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	}, 30000);
});
