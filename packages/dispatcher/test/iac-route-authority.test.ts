import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDirectRoutePort,
	type IacRoutePermit,
	runIacRoute as runAuthorizedRoute,
} from "../src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";

function operationFor(requestId: string) {
	return {
		operationId: `sha256:${createHash("sha256").update(requestId).digest("hex")}`,
		authorization: "host-proof",
	};
}
function runIacRoute<T>(
	input: Omit<Parameters<typeof runAuthorizedRoute<T>>[0], "operation">,
) {
	return runAuthorizedRoute({
		...input,
		operation: operationFor(input.requestId),
	});
}
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
	const authority = createSqliteIacRouteAuthority({
		path: databasePath,
		verifyOperation: () => true,
	});
	authorities.push(authority);
	return { authority, path: databasePath };
}
afterEach(() => {
	for (const authority of authorities.splice(0)) authority.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("durable shared IaC route claims", () => {
	it.each([
		"identity-accessor",
		"plan-accessor",
		"nested-plan-proxy",
	] as const)("rejects direct route %s before claim", async (kind) => {
		const { authority } = connect();
		let traps = 0;
		let calls = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted direct input");
		};
		const direct = createDirectRoutePort({
			authority,
			hashInventory: (_plan: { config: object }) => {
				calls++;
				return hash;
			},
		});
		const input = {
			tenantId: "tenant",
			requestId: "request",
			targetId: "a",
			operation: operationFor("request"),
			plan: { config: {} },
		};
		if (kind === "identity-accessor")
			Object.defineProperty(input, "tenantId", { get: fail });
		if (kind === "plan-accessor")
			Object.defineProperty(input, "plan", { get: fail });
		if (kind === "nested-plan-proxy")
			input.plan.config = new Proxy(
				{},
				{ ownKeys: fail, getPrototypeOf: fail },
			);
		const result = await direct.runDirect(input, async () => {
			calls++;
			throw new Error("must not run");
		});
		expect(result).toMatchObject({
			status: "uncertain",
			code: "ROUTE_INPUT_INVALID",
		});
		expect(
			await authority.inspect({ tenantId: "tenant", requestId: "request" }),
		).toBeUndefined();
		expect({ calls, traps }).toEqual({ calls: 0, traps: 0 });
	});
	it("does not accept a durable outcome changed by the authority after validation", async () => {
		const { authority, path } = connect();
		const writes: {
			status: string;
			targetId?: string;
			requestChanged: boolean;
			outcomeChanged: boolean;
		}[] = [];
		const altered = {
			...authority,
			async finish(input: Parameters<typeof authority.finish>[0]) {
				const original = input.outcome;
				const requestChanged = Reflect.set(input, "outcome", {
					status: "denied",
				});
				const outcomeChanged = Reflect.set(original, "status", "denied");
				writes.push({
					status: original.status,
					targetId: original.targetId,
					requestChanged,
					outcomeChanged,
				});
				if (original.status === "selected") {
					return authority.finish({
						...input,
						outcome: { status: "uncertain", targetId: "a" },
					});
				}
				return authority.finish(input);
			},
		};
		const result = await runIacRoute({
			authority: altered,
			tenantId: "tenant",
			requestId: "request",
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				expect(await authority.consumeAttempt(permit)).toBe(true);
				return {
					value: "selected result",
					outcome: { status: "selected", targetId: "a" },
				};
			},
		});
		expect(result).toMatchObject({ status: "uncertain", targetId: "a" });
		expect(writes).toEqual([
			{
				status: "selected",
				targetId: "a",
				requestChanged: false,
				outcomeChanged: false,
			},
			{
				status: "uncertain",
				targetId: "a",
				requestChanged: false,
				outcomeChanged: false,
			},
		]);
		const reopened = connect(path);
		expect(
			await reopened.authority.inspect({
				tenantId: "tenant",
				requestId: "request",
			}),
		).toMatchObject({
			phase: "finished",
			outcome: { status: "uncertain", targetId: "a" },
		});
	});
	it("rejects a route callback getter before claiming the request", async () => {
		const { authority } = connect();
		let traps = 0;
		const input = {
			authority,
			tenantId: "tenant",
			requestId: "request",
			operation: operationFor("request"),
			run: async () => ({
				value: "bad",
				outcome: { status: "denied" as const },
			}),
		};
		Object.defineProperty(input, "run", {
			get: () => {
				traps++;
				throw new Error("callback getter");
			},
		});
		expect(await runAuthorizedRoute(input)).toMatchObject({
			status: "uncertain",
			code: "ROUTE_INPUT_UNINSPECTABLE",
		});
		expect(
			await authority.inspect({ tenantId: "tenant", requestId: "request" }),
		).toBeUndefined();
		expect(traps).toBe(0);
	});

	it("accepts an explicitly present undefined route value", async () => {
		const { authority } = connect();
		const result = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "request",
			run: async (route) => {
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				expect(await authority.consumeAttempt(permit)).toBe(true);
				return {
					value: undefined,
					outcome: { status: "selected", targetId: "a" },
				};
			},
		});
		expect(result).toEqual({ status: "executed", value: undefined });
	});

	it("preserves the host callback's original method receiver", async () => {
		const { authority } = connect();
		let traps = 0;
		const input = {
			authority,
			tenantId: "tenant",
			requestId: "request",
			operation: operationFor("request"),
			marker: "host-owned",
			async run(route: import("../src/iac-route.js").IacRouteController) {
				expect(this.marker).toBe("host-owned");
				const permit = await route.beginAttempt({
					targetId: "a",
					inventoryHash: hash,
				});
				expect(await authority.consumeAttempt(permit)).toBe(true);
				return {
					value: "ok",
					outcome: { status: "selected" as const, targetId: "a" },
				};
			},
		};
		Object.defineProperty(input.run, "call", {
			get: () => {
				traps++;
				throw new Error("mutable callback call");
			},
		});
		expect(await runAuthorizedRoute(input)).toEqual({
			status: "executed",
			value: "ok",
		});
		expect(traps).toBe(0);
	});

	it.each([
		"outcome-accessor",
		"value-accessor",
		"value-proxy",
		"missing-value",
	] as const)("blocks the route when callback %s cannot be inspected", async (kind) => {
		const { authority, path } = connect();
		let traps = 0;
		let attempts = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted value");
		};
		const result = await runIacRoute({
			authority,
			tenantId: "tenant",
			requestId: "request",
			run: async (route) => {
				await route.beginAttempt({ targetId: "a", inventoryHash: hash });
				attempts++;
				const response = {
					value: {},
					outcome: { status: "selected" as const, targetId: "a" },
				};
				if (kind === "outcome-accessor")
					Object.defineProperty(response, "outcome", { get: fail });
				if (kind === "value-accessor")
					Object.defineProperty(response.value, "field", {
						enumerable: true,
						get: fail,
					});
				if (kind === "value-proxy")
					response.value = new Proxy(
						{},
						{ ownKeys: fail, getPrototypeOf: fail },
					);
				if (kind === "missing-value") Reflect.deleteProperty(response, "value");
				return response;
			},
		});
		expect(result).toMatchObject({ status: "uncertain", targetId: "a" });
		const reopened = connect(path);
		const retry = await runIacRoute({
			authority: reopened.authority,
			tenantId: "tenant",
			requestId: "request",
			run: async () => {
				attempts++;
				throw new Error("must not run");
			},
		});
		expect(retry.status).toBe("uncertain");
		expect({ traps, attempts }).toEqual({ traps: 0, attempts: 1 });
	});
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

	it.each([
		"proxy",
		"accessor",
	] as const)("stops on an uninspectable denial acknowledgement: %s", async (kind) => {
		const { authority, path } = connect();
		let traps = 0;
		let second = 0;
		const broken = {
			...authority,
			async denyAttempt(input: Parameters<typeof authority.denyAttempt>[0]) {
				await authority.denyAttempt(input);
				const receipt = { status: "denied" as const };
				if (kind === "proxy")
					return new Proxy(receipt, {
						getOwnPropertyDescriptor: (target, key) => {
							traps++;
							return Reflect.getOwnPropertyDescriptor(target, key);
						},
					});
				return Object.defineProperty(receipt, "status", {
					get: () => {
						traps++;
						return "denied";
					},
				});
			},
		};
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
		expect({ second, traps }).toEqual({ second: 0, traps: 0 });
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
				operation: operationFor("same"),
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
			operationId: operationFor("old").operationId,
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
		expect(await authority.verifyAttempt(permit)).toBe(false);
		expect(
			(
				await authority.claim({
					tenantId: "tenant",
					requestId: "old",
					...operationFor("old"),
				})
			).status,
		).toBe("existing");
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

	it.each([
		":memory:",
		"file::memory:?cache=shared",
		"file:route-test?mode=memory&cache=shared",
	])("refuses an ephemeral SQLite database %s", (path) => {
		expect(() =>
			createSqliteIacRouteAuthority({ path, verifyOperation: () => true }),
		).toThrow();
	});
});
