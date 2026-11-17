import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runIacRoute } from "../src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";

const operationId = `sha256:${"a".repeat(64)}`;
const inventoryHash = `sha256:${"b".repeat(64)}`;
const anotherOperationId = `sha256:${"c".repeat(64)}`;
const directories: string[] = [];
const authorities: ReturnType<typeof createSqliteIacRouteAuthority>[] = [];
function connect() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-operation-"));
	directories.push(dir);
	const authority = createSqliteIacRouteAuthority({
		path: join(dir, "routes.sqlite"),
		verifyOperation: (input) =>
			input.tenantId === "tenant" &&
			(input.operationId === operationId ||
				input.operationId === anotherOperationId) &&
			input.authorization === `signed:${input.requestId}`,
	});
	authorities.push(authority);
	return authority;
}
afterEach(() => {
	for (const a of authorities.splice(0)) a.close();
	for (const d of directories.splice(0))
		rmSync(d, { recursive: true, force: true });
});

describe("authenticated operation lineage", () => {
	it("cannot bypass an existing effect by selecting a different request id", async () => {
		const authority = connect();
		let effects = 0;
		const first = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "first",
			operation: { operationId, authorization: "signed:first" },
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash,
				});
				expect(permit.operationId).toBe(operationId);
				expect(await authority.consumeAttempt(permit)).toBe(true);
				effects++;
				throw new Error("unknown provider result");
			},
		});
		expect(first.status).toBe("uncertain");
		expect(effects).toBe(1);
		const second = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "different",
			operation: { operationId, authorization: "signed:different" },
			run: async () => {
				effects++;
				throw new Error("must not run");
			},
		});
		expect(second.status).toBe("uncertain");
		expect(effects).toBe(1);
	});
	it("does not let a caller self-assert an operation without host proof", async () => {
		const authority = connect();
		let calls = 0;
		const result = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "first",
			operation: { operationId, authorization: "forged" },
			run: async () => {
				calls++;
				throw new Error("must not run");
			},
		});
		expect(result.status).toBe("uncertain");
		expect(calls).toBe(0);
		expect(
			await authority.inspect({ tenantId: "tenant", requestId: "first" }),
		).toBeUndefined();
	});

	it("only advances an operation to an exact recovery-granted successor", async () => {
		const authority = connect();
		const first = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "first",
			operation: { operationId, authorization: "signed:first" },
			run: async () => {
				throw new Error("lost acknowledgement");
			},
		});
		expect(first.status).toBe("uncertain");
		const denied = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "successor",
			operation: { operationId, authorization: "signed:successor" },
			run: async () => {
				throw new Error("must not run");
			},
		});
		expect(denied.status).toBe("uncertain");
		const directory = directories.at(-1);
		if (!directory) throw new Error("missing directory");
		const db = new DatabaseSync(join(directory, "routes.sqlite"));
		// A trusted recovery transaction has independently proved no effect,
		// no remaining liability, and permanently fenced the old executor.
		db.exec("BEGIN IMMEDIATE");
		db.prepare(
			"UPDATE iac_routes SET claim_token=?,phase='finished',active_attempt=NULL,target=NULL,outcome=? WHERE tenant=? AND request=?",
		).run(
			"C".repeat(43),
			JSON.stringify({ status: "denied" }),
			"tenant",
			"first",
		);
		db.prepare(
			"INSERT INTO iac_route_successors(tenant,operation_id,predecessor,successor) VALUES(?,?,?,?)",
		).run("tenant", operationId, "first", "successor");
		db.exec("COMMIT");
		db.close();
		let effects = 0;
		const stolen = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "successor",
			operation: {
				operationId: anotherOperationId,
				authorization: "signed:successor",
			},
			run: async () => {
				effects++;
				throw new Error("must not run");
			},
		});
		expect(stolen.status).toBe("uncertain");
		expect(effects).toBe(0);
		const successor = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "successor",
			operation: { operationId, authorization: "signed:successor" },
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "b",
					inventoryHash,
				});
				expect(await authority.consumeAttempt(permit)).toBe(true);
				effects++;
				return { value: "ok", outcome: { status: "selected", targetId: "b" } };
			},
		});
		expect(successor).toMatchObject({ status: "executed", value: "ok" });
		const replay = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "first",
			operation: { operationId, authorization: "signed:first" },
			run: async () => {
				effects++;
				throw new Error("must not run");
			},
		});
		expect(replay.status).toBe("replay");
		expect(effects).toBe(1);
		const rebound = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "first",
			operation: {
				operationId: anotherOperationId,
				authorization: "signed:first",
			},
			run: async () => {
				effects++;
				throw new Error("must not run");
			},
		});
		expect(rebound.status).toBe("uncertain");
		expect(effects).toBe(1);
		const nextGeneration = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "unrelated",
			operation: {
				operationId: anotherOperationId,
				authorization: "signed:unrelated",
			},
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "c",
					inventoryHash,
				});
				expect(await authority.consumeAttempt(permit)).toBe(true);
				effects++;
				return {
					value: "new intent",
					outcome: { status: "selected", targetId: "c" },
				};
			},
		});
		expect(nextGeneration).toMatchObject({
			status: "executed",
			value: "new intent",
		});
		expect(effects).toBe(2);
	});

	it("blocks new routes until each legacy request is independently bound", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-legacy-op-"));
		directories.push(dir);
		const path = join(dir, "routes.sqlite");
		const authority = createSqliteIacRouteAuthority({
			path,
			verifyOperation: () => true,
		});
		authorities.push(authority);
		const db = new DatabaseSync(path);
		for (const request of ["old1", "old2"])
			db.prepare(
				"INSERT INTO iac_routes VALUES(?,?,?,'running',NULL,NULL,NULL)",
			).run("tenant", request, "D".repeat(43));
		db.close();
		const op1 = `sha256:${"1".repeat(64)}`,
			op2 = `sha256:${"2".repeat(64)}`,
			op3 = `sha256:${"3".repeat(64)}`;
		await expect(
			authority.claim({
				tenantId: "tenant",
				requestId: "new",
				operationId: op3,
				authorization: "proof",
			}),
		).rejects.toThrow();
		expect(
			(
				await authority.claim({
					tenantId: "tenant",
					requestId: "old1",
					operationId: op1,
					authorization: "proof",
				})
			).status,
		).toBe("existing");
		await expect(
			authority.claim({
				tenantId: "tenant",
				requestId: "new",
				operationId: op3,
				authorization: "proof",
			}),
		).rejects.toThrow();
		expect(
			(
				await authority.claim({
					tenantId: "tenant",
					requestId: "old2",
					operationId: op2,
					authorization: "proof",
				})
			).status,
		).toBe("existing");
		expect(
			(
				await authority.claim({
					tenantId: "tenant",
					requestId: "new",
					operationId: op3,
					authorization: "proof",
				})
			).status,
		).toBe("claimed");
	});

	it("rejects a successor grant while the predecessor is still active", async () => {
		const authority = connect();
		const claim = await authority.claim({
			tenantId: "tenant",
			requestId: "first",
			operationId,
			authorization: "signed:first",
		});
		if (claim.status !== "claimed") throw new Error("missing claim");
		const permit = await authority.beginAttempt({
			tenantId: "tenant",
			requestId: "first",
			operationId,
			claimToken: claim.claimToken,
			targetId: "a",
			inventoryHash,
		});
		expect(await authority.consumeAttempt(permit)).toBe(true);
		const directory = directories.at(-1);
		if (!directory) throw new Error("missing directory");
		const db = new DatabaseSync(join(directory, "routes.sqlite"));
		db.prepare("INSERT INTO iac_route_successors VALUES(?,?,?,?)").run(
			"tenant",
			operationId,
			"first",
			"successor",
		);
		db.close();
		let calls = 0;
		const result = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "successor",
			operation: { operationId, authorization: "signed:successor" },
			run: async () => {
				calls++;
				throw new Error("must not run");
			},
		});
		expect(result.status).toBe("uncertain");
		expect(calls).toBe(0);
		expect(await authority.verifyAttempt(permit)).toBe(true);
	});

	it("validates the exact immutable identity passed to the host verifier", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-operation-mutation-"));
		directories.push(dir);
		let checks = 0;
		const authority = createSqliteIacRouteAuthority({
			path: join(dir, "routes.sqlite"),
			verifyOperation: () => {
				checks++;
				return true;
			},
		});
		authorities.push(authority);
		let reads = 0;
		const input = {
			get tenantId() {
				return ++reads === 1 ? "tenant" : " invalid";
			},
			requestId: "request",
			operationId,
			authorization: "proof",
		};
		await expect(authority.claim(input)).rejects.toThrow();
		expect(checks).toBe(0);
	});

	it("fails closed when recovery lineage exists but its operation mapping is missing", async () => {
		const authority = connect();
		const claim = await authority.claim({
			tenantId: "tenant",
			requestId: "first",
			operationId,
			authorization: "signed:first",
		});
		if (claim.status !== "claimed") throw new Error("missing claim");
		const directory = directories.at(-1);
		if (!directory) throw new Error("missing directory");
		const db = new DatabaseSync(join(directory, "routes.sqlite"));
		db.prepare("INSERT INTO iac_route_successors VALUES(?,?,?,?)").run(
			"tenant",
			operationId,
			"first",
			"successor",
		);
		// Simulate an inconsistent restore or corruption of the operation index.
		db.exec("PRAGMA foreign_keys=OFF");
		db.prepare(
			"DELETE FROM iac_route_operations WHERE tenant=? AND operation_id=?",
		).run("tenant", operationId);
		db.close();
		let effects = 0;
		const result = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "successor",
			operation: { operationId, authorization: "signed:successor" },
			run: async () => {
				effects++;
				throw new Error("must not execute");
			},
		});
		expect(result.status).toBe("uncertain");
		expect(effects).toBe(0);
	});

	it("does not finish a route whose active attempt state is corrupt", async () => {
		const authority = connect();
		const claim = await authority.claim({
			tenantId: "tenant",
			requestId: "first",
			operationId,
			authorization: "signed:first",
		});
		if (claim.status !== "claimed") throw new Error("missing claim");
		await authority.beginAttempt({
			tenantId: "tenant",
			requestId: "first",
			operationId,
			claimToken: claim.claimToken,
			targetId: "a",
			inventoryHash,
		});
		const directory = directories.at(-1);
		if (!directory) throw new Error("missing directory");
		const db = new DatabaseSync(join(directory, "routes.sqlite"));
		db.prepare(
			"UPDATE iac_routes SET active_attempt='corrupt' WHERE tenant=? AND request=?",
		).run("tenant", "first");
		db.close();
		expect(() =>
			authority.finish({
				tenantId: "tenant",
				requestId: "first",
				claimToken: claim.claimToken,
				outcome: { status: "uncertain" },
			}),
		).toThrow();
	});
});
