import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDirectRoutePort,
	type IacRoutePermit,
	runIacRoute,
} from "../src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";

const hash = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
const authorities: ReturnType<typeof createSqliteIacRouteAuthority>[] = [];
function connect(path?: string) {
	const directory =
		path === undefined ? mkdtempSync(join(tmpdir(), "hobo-route-")) : undefined;
	if (directory) directories.push(directory);
	if (path === undefined && directory === undefined)
		throw new Error("directory missing");
	// SAFETY: the preceding check established a directory when path is absent.
	const databasePath = path ?? join(directory as string, "routes.sqlite");
	const authority = createSqliteIacRouteAuthority({ path: databasePath });
	authorities.push(authority);
	return { authority, path: databasePath };
}
afterEach(() => {
	for (const authority of authorities.splice(0)) authority.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("durable shared IaC route claims", () => {
	it("blocks concurrent and reopened callers before another target or policy can run", async () => {
		const first = connect();
		const second = connect(first.path);
		let release: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: (() => void) | undefined;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let calls = 0;
		const work = runIacRoute({
			authority: first.authority,
			tenantId: "tenant",
			requestId: "request",
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				expect(await second.authority.verifyAttempt(permit)).toBe(true);
				expect(await first.authority.consumeAttempt(permit)).toBe(true);
				calls++;
				started?.();
				await waiting;
				return {
					value: "created",
					outcome: { status: "selected", targetId: "a" },
				};
			},
		});
		await running;
		const competing = await runIacRoute({
			authority: second.authority,
			tenantId: "tenant",
			requestId: "request",
			run: async () => {
				calls++;
				throw new Error("must not execute");
			},
		});
		expect(competing).toMatchObject({ status: "uncertain", targetId: "a" });
		release?.();
		expect(await work).toMatchObject({ status: "executed", value: "created" });
		const reopened = connect(first.path);
		const replay = await runIacRoute({
			authority: reopened.authority,
			tenantId: "tenant",
			requestId: "request",
			run: async () => {
				calls++;
				throw new Error("must not execute");
			},
		});
		expect(replay).toMatchObject({ status: "replay", targetId: "a" });
		expect(calls).toBe(1);
	});

	it("persists each definitive denial before a subsequent target and invalidates the old permit", async () => {
		const { authority } = connect();
		const result = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "route",
			run: async (route) => {
				const a = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				await expect(
					route.beginAttempt({ targetId: "b", inventoryHash: hash }),
				).rejects.toThrow();
				await route.denyAttempt(a);
				expect(await authority.verifyAttempt(a)).toBe(false);
				const b = await route.beginAttempt({
					targetId: "b",
					inventoryHash: hash,
				});
				expect(await authority.verifyAttempt(b)).toBe(true);
				expect(await authority.consumeAttempt(b)).toBe(true);
				return { value: "b", outcome: { status: "selected", targetId: "b" } };
			},
		});
		expect(result).toMatchObject({ status: "executed", value: "b" });
	});

	it("retains an unknown claim when claim acknowledgement is lost", async () => {
		const { authority, path } = connect();
		const broken = {
			...authority,
			async claim(input: Parameters<typeof authority.claim>[0]) {
				await authority.claim(input);
				throw new Error("ack lost");
			},
		};
		let calls = 0;
		const result = await runIacRoute({
			authority: broken,
			tenantId: "tenant",
			requestId: "lost",
			run: async () => {
				calls++;
				throw new Error("not run");
			},
		});
		expect(result.status).toBe("uncertain");
		const reopened = connect(path);
		const retry = await runIacRoute({
			authority: reopened.authority,
			tenantId: "tenant",
			requestId: "lost",
			run: async () => {
				calls++;
				throw new Error("not run");
			},
		});
		expect(retry.status).toBe("uncertain");
		expect(calls).toBe(0);
	});

	it("returns unknown and blocks retry when a completed provider's final acknowledgement is lost", async () => {
		const { authority, path } = connect();
		const broken = {
			...authority,
			async finish(input: Parameters<typeof authority.finish>[0]) {
				await authority.finish(input);
				throw new Error("ack lost");
			},
		};
		let calls = 0;
		const result = await runIacRoute({
			authority: broken,
			tenantId: "tenant",
			requestId: "lost",
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				expect(await authority.consumeAttempt(permit)).toBe(true);
				calls++;
				return { value: "ok", outcome: { status: "selected", targetId: "a" } };
			},
		});
		expect(result.status).toBe("uncertain");
		const reopened = connect(path);
		const retry = await runIacRoute({
			authority: reopened.authority,
			tenantId: "tenant",
			requestId: "lost",
			run: async () => {
				calls++;
				throw new Error("not run");
			},
		});
		expect(retry).toMatchObject({ status: "replay", targetId: "a" });
		expect(calls).toBe(1);
	});

	it("rejects forged, cross-target and cross-tenant permits", async () => {
		const { authority } = connect();
		await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "request",
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				expect(await authority.consumeAttempt(permit)).toBe(true);
				for (const changed of [
					{ ...permit, tenantId: "other" },
					{ ...permit, requestId: "other" },
					{ ...permit, targetId: "other" },
					{ ...permit, inventoryHash: `sha256:${"b".repeat(64)}` },
					{ ...permit, attemptId: "A".repeat(43) },
				])
					expect(await authority.verifyAttempt(changed)).toBe(false);
				return { value: "ok", outcome: { status: "selected", targetId: "a" } };
			},
		});
	});

	it("preserves the exact started target when a provider crashes and later policy changes", async () => {
		const { authority, path } = connect();
		const attempt = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "restart",
			run: async (route) => {
				await route.beginAttempt({ targetId: "first", inventoryHash: hash });
				throw new Error("lost provider response");
			},
		});
		expect(attempt).toMatchObject({ status: "uncertain", targetId: "first" });
		const reopened = connect(path);
		expect(
			await reopened.authority.inspect({
				tenantId: "tenant",
				requestId: "restart",
			}),
		).toMatchObject({
			phase: "finished",
			outcome: { status: "uncertain", targetId: "first" },
			attempts: [
				{ targetId: "first", inventoryHash: hash, status: "finished" },
			],
		});
		let policyChecks = 0;
		let secondEffects = 0;
		const retry = await runIacRoute({
			authority: reopened.authority,
			tenantId: "tenant",
			requestId: "restart",
			run: async (route) => {
				policyChecks++;
				await route.beginAttempt({ targetId: "second", inventoryHash: hash });
				secondEffects++;
				return {
					value: "wrong",
					outcome: { status: "selected", targetId: "second" },
				};
			},
		});
		expect(retry).toMatchObject({ status: "uncertain", targetId: "first" });
		expect(policyChecks).toBe(0);
		expect(secondEffects).toBe(0);
	});

	it("keeps a route uncertain when a denial acknowledgement is lost", async () => {
		const { authority, path } = connect();
		const broken = {
			...authority,
			async denyAttempt(input: Parameters<typeof authority.denyAttempt>[0]) {
				await authority.denyAttempt(input);
				throw new Error("lost denial acknowledgement");
			},
		};
		let second = 0;
		const attempt = await runIacRoute({
			authority: broken,
			tenantId: "tenant",
			requestId: "denial",
			run: async (route) => {
				const first = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				await route.denyAttempt(first);
				second++;
				return { value: "wrong", outcome: { status: "denied" } };
			},
		});
		expect(attempt.status).toBe("uncertain");
		const reopened = connect(path);
		const retry = await runIacRoute({
			authority: reopened.authority,
			tenantId: "tenant",
			requestId: "denial",
			run: async () => {
				second++;
				throw new Error("must not run");
			},
		});
		expect(retry.status).toBe("uncertain");
		expect(second).toBe(0);
	});

	it("shares route identity between direct and ranked execution", async () => {
		const { authority } = connect();
		const direct = createDirectRoutePort({
			authority,
			hashInventory: (_plan: { version: number }) => hash,
		});
		const result = await direct.runDirect(
			{
				tenantId: "tenant",
				requestId: "same",
				targetId: "a",
				plan: { version: 1 },
			},
			async ({ permit }) => {
				expect(await direct.verifyAttempt(permit)).toBe(true);
				expect(await direct.consumeAttempt(permit)).toBe(true);
				return {
					value: "done",
					outcome: { status: "selected", targetId: "a" },
				};
			},
		);
		expect(result).toMatchObject({ status: "executed", value: "done" });
		let calls = 0;
		const retry = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "same",
			run: async () => {
				calls++;
				throw new Error("must not execute");
			},
		});
		expect(retry.status).toBe("replay");
		expect(calls).toBe(0);
	});

	it("allows exactly one handoff of a permit across independent connections", async () => {
		const first = connect();
		const second = connect(first.path);
		const direct = createDirectRoutePort({
			authority: second.authority,
			hashInventory: () => hash,
		});
		let oldPermit: IacRoutePermit | undefined;
		const result = await runIacRoute({
			authority: first.authority,
			tenantId: "tenant",
			requestId: "once",
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				oldPermit = permit;
				const handoffs = await Promise.all([
					first.authority.consumeAttempt(permit),
					direct.consumeAttempt(permit),
				]);
				expect(handoffs.filter(Boolean)).toHaveLength(1);
				expect(await second.authority.verifyAttempt(permit)).toBe(true);
				return { value: "ok", outcome: { status: "selected", targetId: "a" } };
			},
		});
		expect(result.status).toBe("executed");
		if (oldPermit === undefined) throw new Error("permit missing");
		expect(await first.authority.verifyAttempt(oldPermit)).toBe(false);
		expect(await second.authority.consumeAttempt(oldPermit)).toBe(false);
	});

	it("upgrades old running attempts without reauthorizing their capabilities", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-route-upgrade-"));
		directories.push(directory);
		const path = join(directory, "routes.sqlite");
		const db = new DatabaseSync(path);
		db.exec(`CREATE TABLE iac_routes(tenant TEXT NOT NULL,request TEXT NOT NULL,claim_token TEXT NOT NULL,phase TEXT NOT NULL,active_attempt TEXT,target TEXT,outcome TEXT,PRIMARY KEY(tenant,request));
		CREATE TABLE iac_route_attempts(tenant TEXT NOT NULL,request TEXT NOT NULL,attempt TEXT NOT NULL,target TEXT NOT NULL,inventory_hash TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(tenant,request,attempt),UNIQUE(tenant,request,ordinal));`);
		const permit = {
			tenantId: "tenant",
			requestId: "old",
			targetId: "a",
			inventoryHash: hash,
			attemptId: "A".repeat(43),
		};
		db.prepare("INSERT INTO iac_routes VALUES(?,?,?,'running',?,?,NULL)").run(
			"tenant",
			"old",
			"B".repeat(43),
			permit.attemptId,
			"a",
		);
		db.prepare(
			"INSERT INTO iac_route_attempts VALUES(?,?,?,?,?,1,'running')",
		).run("tenant", "old", permit.attemptId, "a", hash);
		db.close();
		const { authority } = connect(path);
		expect(await authority.verifyAttempt(permit)).toBe(true);
		expect(await authority.consumeAttempt(permit)).toBe(false);
		const fresh = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "new",
			run: async (route) => {
				const created = await route.beginAttempt({
					targetId: "b",
					inventoryHash: hash,
				});
				expect(await authority.consumeAttempt(created)).toBe(true);
				return { value: "ok", outcome: { status: "selected", targetId: "b" } };
			},
		});
		expect(fresh.status).toBe("executed");
	});
});
