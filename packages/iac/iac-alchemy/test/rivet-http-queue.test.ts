import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setup } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { describe, expect, it, vi } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import {
	createRivetHttpQueueApplication,
	createRivetHttpQueueMappers,
} from "../src/rivet-http-queue.js";
import { createRivetQueueActor } from "../src/rivet-queue-runtime.js";
import { testStateOwnership } from "./route-fixture.js";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;

function fixture() {
	const queue = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1_000,
		authorize: () => true,
		verifyIngress: () => true,
	});
	const fetch = vi.fn(async () =>
		Response.json({
			messageId: "message-1",
			idempotencyKey: "order-1",
			deduped: false,
		}),
	);
	const transport = {
		scope: {
			tenantId: "tenant-a",
			instanceId: "queue-1",
			actorName: "jobs",
			actorKey: ["tenant-a", "queue-1"],
		},
		fetch,
		verifyDispatch: () => true,
		verifyResponseBounds: () => true,
	};
	let scopeValid = true;
	let effects = 0;
	const application = createRivetHttpQueueApplication({
		actorName: "web",
		queue,
		transport,
		verifyScope: () => scopeValid,
		authorize: ({ actorKey, request, queue: scope }) =>
			actorKey[0] === scope.tenantId &&
			request.headers.get("authorization") === scope.tenantId,
		application: (client) => async () => {
			effects++;
			const receipt = await client.enqueue("order-1", { amount: 1 });
			return Response.json(receipt);
		},
	});
	return {
		queue,
		transport,
		application,
		fetch,
		revoke: () => {
			scopeValid = false;
		},
		effects: () => effects,
	};
}

describe("Rivet HTTP application and asynchronous queue", () => {
	it("authorizes the HTTP principal and actor key against the exact queue scope", async () => {
		const f = fixture();
		const denied = await f.application.http.handle(
			{ name: "web", key: ["tenant-b"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-b" },
			}),
		);
		expect(denied.status).toBe(403);
		expect(f.effects()).toBe(0);
		expect(f.fetch).not.toHaveBeenCalled();
		const allowed = await f.application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a" },
			}),
		);
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toMatchObject({
			messageId: "message-1",
			deduped: false,
		});
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects queue scope substitution and uninspectable options before callbacks", () => {
		const f = fixture();
		let traps = 0;
		const proxy = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("trap");
				},
			},
		);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this intentionally malformed input verifies Proxy rejection.
		expect(() => createRivetHttpQueueApplication(proxy as never)).toThrow();
		expect(traps).toBe(0);
		expect(() =>
			createRivetHttpQueueApplication({
				actorName: "web",
				queue: f.queue,
				transport: {
					...f.transport,
					scope: { ...f.transport.scope, actorName: "other" },
				},
				verifyScope: () => true,
				authorize: () => true,
				application: () => () => new Response(),
			}),
		).toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("rejects nested proxies and accessors without invoking them", () => {
		const f = fixture();
		let traps = 0;
		const hostile = new Proxy(["tenant-a", "queue-1"], {
			getPrototypeOf() {
				traps++;
				throw new Error("trap");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("trap");
			},
		});
		const options = {
			actorName: "web",
			queue: f.queue,
			transport: {
				...f.transport,
				scope: { ...f.transport.scope, actorKey: hostile },
			},
			verifyScope: vi.fn(() => true),
			authorize: () => true,
			application: () => () => new Response(),
		};
		expect(() => createRivetHttpQueueApplication(options)).toThrow();
		const transport = { ...f.transport };
		Object.defineProperty(transport, "verifyResponseBounds", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("trap");
			},
		});
		expect(() =>
			createRivetHttpQueueApplication({ ...options, transport }),
		).toThrow();
		expect(traps).toBe(0);
		expect(options.verifyScope).not.toHaveBeenCalled();
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("does not start work after scope revocation", async () => {
		const f = fixture();
		f.revoke();
		const response = await f.application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a" },
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ execution: "not-started" });
		expect(f.effects()).toBe(0);
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it.each([
		"decorated key",
		"extra scope field",
	] as const)("refuses a %s before verifying the queue scope", (kind) => {
		const f = fixture();
		const actorKey = [...f.transport.scope.actorKey];
		const scope = { ...f.transport.scope, actorKey };
		if (kind === "decorated key")
			Object.defineProperty(actorKey, "extra", { value: "hidden" });
		else Object.defineProperty(scope, "extra", { value: "hidden" });
		let verified = 0;
		expect(() =>
			createRivetHttpQueueApplication({
				actorName: "web",
				queue: f.queue,
				transport: { ...f.transport, scope },
				verifyScope: () => {
					verified++;
					return true;
				},
				authorize: () => true,
				application: () => () => new Response(),
			}),
		).toThrow();
		expect(verified).toBe(0);
	});

	it("refuses an unobservable authorizer without reading its thenable properties", async () => {
		const f = fixture();
		let traps = 0;
		const unobservable = new Proxy(
			{},
			{
				get() {
					traps++;
					throw new Error("thenable trap");
				},
			},
		);
		const app = createRivetHttpQueueApplication({
			actorName: "web",
			queue: f.queue,
			transport: f.transport,
			verifyScope: () => true,
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exercise a JavaScript caller returning an unsupported result.
			authorize: () => unobservable as never,
			application: () => () => new Response("unexpected"),
		});
		const result = await app.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test"),
		);
		expect(result.status).toBe(503);
		expect(await result.json()).toMatchObject({ execution: "not-started" });
		expect(traps).toBe(0);
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("reports a possibly completed effect if scope is revoked by the handler", async () => {
		const f = fixture();

		let accepted = true;
		const guarded = createRivetHttpQueueApplication({
			actorName: "guarded-web",
			queue: f.queue,
			transport: f.transport,
			verifyScope: () => accepted,
			authorize: () => true,
			application: (client) => async () => {
				await client.enqueue("order-1", { amount: 1 });
				accepted = false;
				return new Response("private result");
			},
		});
		const response = await guarded.http.handle(
			{ name: "guarded-web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/"),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			execution: "possibly-completed",
		});
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it("retains a committed SQLite enqueue when authorization is revoked before disclosure", async () => {
		const sql = new DatabaseSync(":memory:");
		try {
			sql.exec(
				"CREATE TABLE hobo_queue_messages (idempotency_key TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, available_at INTEGER NOT NULL, requested_available_at INTEGER, state TEXT NOT NULL, lease_id TEXT, lease_expires_at INTEGER, attempt INTEGER NOT NULL, completed_lease_id TEXT); CREATE TABLE hobo_queue_clock (id INTEGER PRIMARY KEY CHECK(id=1), observed_at INTEGER NOT NULL)",
			);
			const execute = async (query: string, ...args: SQLInputValue[]) =>
				sql.prepare(query).all(...args);
			const transaction = async <T>(run: (tx: RawAccess) => Promise<T>) => {
				sql.exec("BEGIN IMMEDIATE");
				try {
					// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture's actor uses the transaction execute method only.
					const result = await run({ execute } as RawAccess);
					sql.exec("COMMIT");
					return result;
				} catch (error) {
					sql.exec("ROLLBACK");
					throw error;
				}
			};
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the tested actor uses only this fixture's execute and transaction methods.
			const database = { execute, transaction } as RawAccess;
			const queue = createRivetQueueActor({
				actorName: "jobs",
				now: () => 1_000,
				authorize: ({ actorKey }) => actorKey[0] === "tenant-a",
				verifyIngress: () => true,
			});
			let authorized = true;
			const transport = {
				scope: {
					tenantId: "tenant-a",
					instanceId: "queue-1",
					actorName: "jobs",
					actorKey: ["tenant-a", "queue-1"],
				},
				fetch: (path: string, init: RequestInit) =>
					queue.handle(
						{ name: "jobs", key: ["tenant-a", "queue-1"], db: database },
						new Request(`https://queue.test${path}`, init),
					),
				verifyDispatch: () => true,
				verifyResponseBounds: () => true,
			};
			const app = createRivetHttpQueueApplication({
				actorName: "web",
				queue,
				transport,
				verifyScope: () => authorized,
				authorize: () => true,
				application: (client) => async () => {
					await client.enqueue("order-1", { amount: 1 });
					authorized = false;
					return new Response("must not disclose");
				},
			});
			const response = await app.http.handle(
				{ name: "web", key: ["tenant-a"], vars: {} },
				new Request("https://app.test/"),
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				execution: "possibly-completed",
			});
			expect(
				sql
					.prepare("SELECT idempotency_key, body FROM hobo_queue_messages")
					.all(),
			).toEqual([{ idempotency_key: "order-1", body: '{"amount":1}' }]);
		} finally {
			sql.close();
		}
	});

	it("requires the exact two-actor registry for the Alchemy mapper", () => {
		const f = fixture();
		const registry = setup({
			use: { web: f.application.http.actor, jobs: f.queue.actor },
			noWelcome: true,
		});
		const input = {
			application: f.application,
			source: {
				main: "/src/main.ts",
				resourceName: "web",
				kind: "web" as const,
				actorName: "web",
				sourceDigest: digest("a"),
				sourceFence: {
					sourceDigest: digest("a"),
					environmentDigest: digest("d"),
					proofRef: "host:source",
					verify: () => true,
				},
				registry,
				binding: f.application.http,
				verifySource: () => true,
			},
			poolDigest: digest("b"),
			isolationDigest: digest("c"),
			poolHost: {
				deployExternal: () => {
					throw new Error("not executing");
				},
				deployCrate: () => {
					throw new Error("not executing");
				},
			},
			verifyPool: () => true,
		};
		const expectedLimitations =
			createRivetHttpQueueMappers(input).web.limitations;
		const nativeIterator = Array.prototype[Symbol.iterator];
		let limitations: readonly string[] | undefined;
		/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: the fixture substitutes array iteration while mapper limitations are copied. */
		try {
			limitations = createRivetHttpQueueMappers({
				...input,
				verifyPool: () => {
					Reflect.set(
						Array.prototype,
						Symbol.iterator,
						function (this: string[]) {
							if (
								typeof this[0] === "string" &&
								this[0].startsWith("Only the attested source kind")
							)
								return Reflect.apply(nativeIterator, [], []);
							return Reflect.apply(nativeIterator, this, []);
						},
					);
					return true;
				},
			}).web.limitations;
		} finally {
			Reflect.set(Array.prototype, Symbol.iterator, nativeIterator);
		}
		/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
		expect(limitations).toEqual(expectedLimitations);
		const fake = { http: f.application.http, queue: f.queue };
		const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
		if (original === undefined) throw new Error("WeakMap.get missing");
		const nativeGet = original.value;
		let traps = 0;
		/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-reflect-apply -- SAFETY: the fixture substitutes a native WeakMap method to check the binding brand. */
		try {
			Object.defineProperty(WeakMap.prototype, "get", {
				...original,
				value(this: WeakMap<object, unknown>, key: object) {
					if (key === fake) {
						traps++;
						return { ...fake, verify: () => true };
					}
					return Reflect.apply(nativeGet, this, [key]);
				},
			});
			expect(() =>
				createRivetHttpQueueMappers({ ...input, application: fake }),
			).toThrow();
		} finally {
			Object.defineProperty(WeakMap.prototype, "get", original);
		}
		/* oxlint-enable anti-slop/no-object-parameters, anti-slop/no-reflect-apply */
		expect(traps).toBe(0);
		Reflect.set(registry.config.use, "jobs", f.application.http.actor);
		expect(() => createRivetHttpQueueMappers(input)).toThrow();
	});

	it("rechecks the original principal when the handler substitutes request headers", async () => {
		const f = fixture();
		let aliceAllowed = true;
		const observed: string[] = [];
		const app = createRivetHttpQueueApplication({
			actorName: "web",
			queue: f.queue,
			transport: f.transport,
			verifyScope: () => true,
			authorize: ({ request }) => {
				const principal = request.headers.get("authorization") ?? "";
				observed.push(principal);
				return principal === "bob" || (principal === "alice" && aliceAllowed);
			},
			application: (client) => async (request) => {
				await client.enqueue("order-1", { amount: 1 });
				request.headers.set("authorization", "bob");
				aliceAllowed = false;
				return new Response("private");
			},
		});
		const result = await app.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test", { headers: { authorization: "alice" } }),
		);
		expect(result.status).toBe(403);
		expect(await result.json()).toMatchObject({
			error: "authorization-denied",
			execution: "possibly-completed",
		});
		expect(observed.length).toBeGreaterThan(1);
		expect(observed.every((value) => value === "alice")).toBe(true);
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it("does not start the handler when authorization finishes after its deadline", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			let finish: (value: boolean) => void = () => {};
			const decision = new Promise<boolean>((resolve) => {
				finish = resolve;
			});
			const handler = vi.fn(() => new Response("unexpected"));
			const app = createRivetHttpQueueApplication({
				actorName: "web",
				queue: f.queue,
				transport: f.transport,
				verifyScope: () => true,
				authorizationTimeoutMs: 5_000,
				authorize: () => decision,
				application: () => handler,
			});
			const pending = app.http.handle(
				{ name: "web", key: ["tenant-a"], vars: {} },
				new Request("https://app.test"),
			);
			await vi.advanceTimersByTimeAsync(5_001);
			const result = await pending;
			expect(result.status).toBe(503);
			expect(await result.json()).toMatchObject({ execution: "not-started" });
			finish(true);
			await Promise.resolve();
			expect(handler).not.toHaveBeenCalled();
			expect(f.fetch).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("exhaustively preserves dispatch and disclosure across bounded authority outcomes", async () => {
		const outcomes = ["allow", "deny", "unavailable"] as const;
		for (const initial of outcomes)
			for (const after of outcomes) {
				const f = fixture();
				const decisions = [initial, after];
				let checks = 0;
				const app = createRivetHttpQueueApplication({
					actorName: "web",
					queue: f.queue,
					transport: f.transport,
					verifyScope: () => true,
					authorize: () => {
						const next = decisions[checks++];
						if (next === "unavailable") throw new Error("host unavailable");
						return next === "allow";
					},
					application: (client) => async () => {
						await client.enqueue("order-1", { amount: 1 });
						return new Response("private-result");
					},
				});
				const result = await app.http.handle(
					{ name: "web", key: ["tenant-a"], vars: {} },
					new Request("https://app.test"),
				);
				const dispatched = initial === "allow";
				expect(f.fetch, `${initial}/${after}`).toHaveBeenCalledTimes(
					dispatched ? 1 : 0,
				);
				expect(checks).toBe(dispatched ? 2 : 1);
				if (dispatched && after === "allow") {
					expect(result.status).toBe(200);
					expect(await result.text()).toBe("private-result");
				} else if (dispatched) {
					expect(result.status).toBe(after === "deny" ? 403 : 503);
					expect(await result.json()).toMatchObject({
						error:
							after === "deny"
								? "authorization-denied"
								: "authorization-unavailable",
						execution: "possibly-completed",
					});
				} else if (initial === "deny") {
					expect(result.status).toBe(403);
				} else {
					expect(result.status).toBe(503);
					expect(await result.json()).toMatchObject({
						execution: "not-started",
					});
				}
			}
	});

	it("previews a real DurableObject and rejects legacy queue dependencies", async () => {
		const f = fixture();
		const main = "/src/main.ts";
		const registry = setup({
			use: { web: f.application.http.actor, jobs: f.queue.actor },
			noWelcome: true,
		});
		const calls: string[] = [];
		const mappers = createRivetHttpQueueMappers({
			application: f.application,
			source: {
				main,
				resourceName: "web",
				kind: "web",
				actorName: "web",
				sourceDigest: digest("a"),
				sourceFence: {
					sourceDigest: digest("a"),
					environmentDigest: digest("d"),
					proofRef: "host:source",
					verify: () => true,
				},
				registry,
				binding: f.application.http,
				verifySource: () => true,
			},
			poolDigest: digest("b"),
			isolationDigest: digest("c"),
			poolHost: {
				deployExternal: ({ main: path }) =>
					Effect.sync(() => {
						calls.push(path);
					}),
				deployCrate: () => Effect.void,
			},
			verifyPool: () => true,
		});
		const declaration = {
			name: "web",
			kind: "web",
			stableId: "web:web",
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		};
		const mapperInput = {
			declaration,
			entrypoint: f.application.http.entrypoint,
			requirements: {},
			bindleName: "app",
			dependencyDeclarations: {},
			dependencies: {},
		};
		expect(() =>
			mappers.web.validate({
				...mapperInput,
				declaration: { ...declaration, dependsOn: ["jobs"] },
				dependencyDeclarations: {
					jobs: { ...declaration, name: "jobs", kind: "queue" },
				},
			}),
		).toThrow("RIVET_DEPENDENCY_UNSUPPORTED");
		const providers = Layer.effect(
			Providers,
			Provider.collection([DurableObjectResource]),
		).pipe(
			Layer.provide(
				Provider.succeed(DurableObjectResource, {
					reconcile: () =>
						Effect.succeed({
							name: "web",
							pool: "pool",
							endpoint: "https://rivet.test",
							namespace: "test",
							token: undefined,
						}),
					delete: () => Effect.void,
				}),
			),
		);
		const stack = Stack(
			"App",
			{ providers, state: inMemoryState() },
			mappers.web.build(mapperInput).pipe(Effect.map(() => ({}))),
		);
		const directory = mkdtempSync(
			join(tmpdir(), "hobo-rivet-http-queue-plan-"),
		);
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		try {
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:source",
					environmentDigest: digest("d"),
					sourceRequirements: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							bindleName: "app",
							applicationName: "web",
							sourceKind: "rivet-http",
							sourcePath: main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) =>
						sourceClaims.length === 1 && sourceClaims[0]?.sourcePath === main,
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: digest("a"),
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							providerId: "rivet",
							providerAccountRef: "account",
							productId: "actor",
						},
					],
				}),
				financial: {
					assess: (inventory) => ({ inventory }),
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => true,
					uncertain: () => {},
				},
			});
			const result = await provider.preview({
				programId: "app",
				deploymentId: "d",
				resourceId: "app",
				provider: "rivet",
				driver: "external",
				action: "apply",
				stackName: "App",
			});
			expect(result.changes).toBe(1);
			expect(calls).toEqual([main]);
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
