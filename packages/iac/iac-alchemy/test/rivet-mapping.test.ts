import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { actor, setup } from "rivetkit";
import { describe, expect, it, vi } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import {
	bindRivetHttpSource,
	createRivetPrimitiveMappers,
	describeRivetPrimitiveSupport,
} from "../src/rivet.js";
import {
	createRivetHttpActor,
	isRivetHttpBinding,
} from "../src/rivet-runtime.js";
import { testStateOwnership } from "./route-fixture.js";

const handler = () => (request: Request) =>
	new Response(`served:${new URL(request.url).pathname}`);

function application() {
	const authorize = vi.fn(async () => true);
	const binding = createRivetHttpActor({
		actorName: "web",
		entrypoint: handler,
		authorize,
	});
	const registry = setup({ use: { web: binding.actor }, noWelcome: true });
	const source = bindRivetHttpSource({
		main: "/src/app.ts",
		resourceName: "web",
		kind: "web",
		actorName: "web",
		sourceDigest: `sha256:${"a".repeat(64)}`,
		sourceFence: {
			sourceDigest: `sha256:${"a".repeat(64)}`,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "host:immutable-source",
			verify(claim) {
				return this.sourceDigest === claim.sourceDigest;
			},
		},
		registry,
		binding,
		verifySource: () => true,
	});
	const declaration = {
		name: "web",
		kind: "web",
		stableId: "web:web",
		declaredAllow: [],
		dependsOn: [],
		annotations: [],
	};
	return { binding, registry, source, declaration, authorize };
}

describe("Rivet native application binding", () => {
	it("plans a real Alchemy Rivet DurableObject and registers its program with the pool host", async () => {
		const { source, declaration } = application();
		const deploys: string[] = [];
		const mapper = createRivetPrimitiveMappers(source).web;
		const program = mapper.build({
			declaration,
			entrypoint: handler,
			requirements: {},
			bindleName: "app",
			dependencyDeclarations: {},
			dependencies: {},
		});
		const registry = Layer.effect(
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
		const pool: PoolHost["Service"] = {
			deployExternal: (input) =>
				Effect.sync(() => {
					deploys.push(input.main);
				}),
			deployCrate: () => Effect.void,
		};
		const stack = Stack(
			"App",
			{ providers: registry, state: inMemoryState() },
			program.pipe(
				Effect.provideService(PoolHost, pool),
				Effect.map(() => ({})),
			),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-alchemy-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		try {
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:immutable-source",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							bindleName: "app",
							applicationName: "web",
							sourceKind: "rivet-http",
							sourcePath: source.main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) =>
						sourceClaims.length === 1 &&
						sourceClaims[0]?.sourcePath === source.main,
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: source.sourceDigest,
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
			expect(deploys).toEqual([source.main]);
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("binds a real RivetKit actor to the declared application entrypoint and registry", async () => {
		const { binding, authorize } = application();
		const request = new Request("https://example.test/hello");
		const response = await binding.handle(
			{ name: "web", key: ["tenant", "app"], vars: {} },
			request,
		);
		expect(await response.text()).toBe("served:/hello");
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				actorName: "web",
				actorKey: ["tenant", "app"],
			}),
		);
		expect(binding.actor.config.onRequest).not.toBe(binding.handle);
		expect(isRivetHttpBinding(binding)).toBe(true);
	});

	it("distinguishes a definite policy denial from unavailable or malformed authority", async () => {
		for (const [authorize, status] of [
			[async () => false, 403],
			[
				async () => {
					throw new Error("unavailable");
				},
				503,
			],
			[async () => "malformed", 503],
		] as const) {
			const entrypoint = vi.fn(handler);
			const binding = createRivetHttpActor({
				actorName: "web",
				entrypoint,
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the malformed case deliberately exercises the JavaScript boundary.
				authorize: authorize as never,
			});
			const result = await binding.handle(
				{ name: "web", key: ["tenant"], vars: {} },
				new Request("https://example.test/"),
			);
			expect(result.status).toBe(status);
			if (status === 503)
				expect(await result.json()).toEqual({
					error: "authorization-unavailable",
					execution: "not-started",
				});
			expect(entrypoint).not.toHaveBeenCalled();
		}
	});

	it("does not start an application when synchronous authorization exceeds its deadline", async () => {
		const entrypoint = vi.fn(handler);
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint,
			authorizationTimeoutMs: 300,
			authorize: () => {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
				return true;
			},
		});
		const result = await binding.handle(
			{ name: "web", key: ["tenant"], vars: {} },
			new Request("https://example.test/"),
		);
		expect(result.status).toBe(503);
		expect(await result.json()).toEqual({
			error: "authorization-unavailable",
			execution: "not-started",
		});
		expect(entrypoint).not.toHaveBeenCalled();
	});

	it("does not claim no effect when the application factory outlives authorization", async () => {
		let effects = 0;
		const application = vi.fn(() => new Response("unexpected"));
		const binding = createRivetHttpActor({
			actorName: "web",
			authorizationTimeoutMs: 300,
			authorize: () => true,
			entrypoint: () => {
				effects++;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
				return application;
			},
		});
		const result = await binding.handle(
			{ name: "web", key: ["tenant"], vars: {} },
			new Request("https://example.test/"),
		);
		expect(result.status).toBe(503);
		expect(await result.json()).toEqual({
			error: "authorization-unavailable",
			execution: "possibly-completed",
		});
		expect(effects).toBe(1);
		expect(application).not.toHaveBeenCalled();
	});

	it("does not dispatch a fetch method whose getter outlives authorization", async () => {
		let getters = 0;
		let handled = 0;
		const binding = createRivetHttpActor({
			actorName: "web",
			authorizationTimeoutMs: 300,
			authorize: () => true,
			entrypoint: () => ({
				get fetch() {
					getters++;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
					return () => {
						handled++;
						return new Response("unexpected");
					};
				},
			}),
		});
		const response = await binding.handle(
			{ name: "web", key: ["tenant"], vars: {} },
			new Request("https://example.test/"),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "authorization-unavailable",
			execution: "possibly-completed",
		});
		expect(getters).toBe(1);
		expect(handled).toBe(0);
	});

	it.each([
		"factory",
		"fetch-getter",
		"handler",
		"malformed-response",
		"proxied-response",
	] as const)("reports possibly-completed when the application fails in %s", async (phase) => {
		let effects = 0;
		const binding = createRivetHttpActor({
			actorName: "web",
			authorize: () => true,
			entrypoint: () => {
				if (phase === "factory") {
					effects++;
					throw new Error("factory failed after effect");
				}
				if (phase === "fetch-getter")
					return {
						get fetch() {
							effects++;
							throw new Error("getter failed after effect");
						},
					};
				return async () => {
					effects++;
					if (phase === "handler")
						throw new Error("handler failed after effect");
					if (phase === "proxied-response")
						return new Proxy(new Response("secret"), {
							getPrototypeOf() {
								effects++;
								throw new Error("response trap");
							},
						});
					return { malformed: true };
				};
			},
		});
		const response = await binding.handle(
			{ name: "web", key: ["tenant"], vars: {} },
			new Request("https://example.test/"),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "application-failed",
			execution: "possibly-completed",
		});
		expect(effects).toBe(1);
	});

	it("does not cache a factory that threw after a possible effect", async () => {
		let factories = 0;
		const binding = createRivetHttpActor({
			actorName: "web",
			authorize: () => true,
			entrypoint: () => {
				if (++factories === 1) throw new Error("after possible effect");
				return () => new Response("ready");
			},
		});
		const context = { name: "web", key: ["tenant"], vars: {} };
		const failed = await binding.handle(
			context,
			new Request("https://example.test/"),
		);
		expect(await failed.json()).toEqual({
			error: "application-failed",
			execution: "possibly-completed",
		});

		const later = await binding.handle(
			context,
			new Request("https://example.test/"),
		);
		expect(await later.text()).toBe("ready");
		expect(factories).toBe(2);
	});

	it.each([
		"malformed",
		"getter",
	] as const)("does not cache an initializer whose handler is %s", async (kind) => {
		let factories = 0;
		const binding = createRivetHttpActor({
			actorName: "web",
			authorize: () => true,
			entrypoint: () => {
				if (++factories !== 1) return () => new Response("ready");
				if (kind === "malformed") return {};
				return {
					get fetch() {
						throw new Error("unavailable handler");
					},
				};
			},
		});
		const context = { name: "web", key: ["tenant"], vars: {} };
		const first = await binding.handle(
			context,
			new Request("https://example.test/"),
		);
		expect(await first.json()).toEqual({
			error: "application-failed",
			execution: "possibly-completed",
		});

		const second = await binding.handle(
			context,
			new Request("https://example.test/"),
		);
		expect(await second.text()).toBe("ready");
		expect(factories).toBe(2);
	});

	it("observes an accidentally rejected native Promise from a synchronous factory", async () => {
		let attempts = 0;
		const binding = createRivetHttpActor({
			actorName: "web",
			authorize: () => true,
			entrypoint: () =>
				++attempts === 1
					? Promise.reject(new Error("factory failed"))
					: () => new Response("ready"),
		});
		const context = { name: "web", key: ["tenant"], vars: {} };
		const response = await binding.handle(
			context,
			new Request("https://example.test/"),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "application-failed",
			execution: "possibly-completed",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		const later = await binding.handle(
			context,
			new Request("https://example.test/"),
		);
		expect(await later.text()).toBe("ready");
		expect(attempts).toBe(2);
	});

	it("bounds pending authorization and retains timed-out slots until the callbacks settle", async () => {
		vi.useFakeTimers();
		const resolve: ((value: boolean) => void)[] = [];
		const entrypoint = vi.fn(handler);
		try {
			const binding = createRivetHttpActor({
				actorName: "web",
				entrypoint,
				authorizationTimeoutMs: 5_000,
				authorize: () => new Promise<boolean>((finish) => resolve.push(finish)),
			});
			const request = () =>
				binding.handle(
					{ name: "web", key: ["tenant"], vars: {} },
					new Request("https://example.test/"),
				);
			const pending = Array.from({ length: 128 }, request);
			await vi.advanceTimersByTimeAsync(5_001);
			for (const response of await Promise.all(pending)) {
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({
					error: "authorization-unavailable",
					execution: "not-started",
				});
			}
			expect(resolve).toHaveLength(128);
			expect((await request()).status).toBe(503);
			expect(resolve).toHaveLength(128);
			resolve[0]?.(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(entrypoint).not.toHaveBeenCalled();
			const next = request();
			await vi.advanceTimersByTimeAsync(0);
			expect(resolve).toHaveLength(129);
			resolve[128]?.(false);
			expect((await next).status).toBe(403);
			expect(entrypoint).not.toHaveBeenCalled();
		} finally {
			for (const finish of resolve) finish(false);
			vi.useRealTimers();
		}
	});

	it("rejects authorization deadlines outside the supported bounds", () => {
		for (const authorizationTimeoutMs of [0, -1, 60_001, 1.5, Number.NaN])
			expect(() =>
				createRivetHttpActor({
					actorName: "web",
					entrypoint: handler,
					authorize: () => true,
					authorizationTimeoutMs,
				}),
			).toThrow();
	});

	it("captures actor options once before validating and authorizing", async () => {
		let nameReads = 0;
		let authorizationReads = 0;
		const binding = createRivetHttpActor({
			get actorName() {
				return ++nameReads === 1 ? "web" : "other";
			},
			entrypoint: handler,
			get authorize() {
				return ++authorizationReads === 1 ? () => false : () => true;
			},
		});
		expect(binding.actorName).toBe("web");
		const response = await binding.handle(
			{ name: "web", key: ["tenant"], vars: {} },
			new Request("https://example.test/"),
		);
		expect(response.status).toBe(403);
		expect(nameReads).toBe(1);
		expect(authorizationReads).toBe(1);
	});

	it("authorizes from copied request metadata without duplicating the application body", async () => {
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: () => async (request: Request) =>
				new Response(
					`${request.headers.get("x-test")}:${await request.text()}`,
				),
			authorize: ({ request }) => {
				expect("body" in request).toBe(false);
				request.headers.set("x-test", "changed");
				return true;
			},
		});
		const result = await binding.handle(
			{ name: "web", key: ["tenant"], vars: {} },
			new Request("https://example.test/", {
				method: "POST",
				headers: { "x-test": "original" },
				body: "application body",
			}),
		);
		expect(await result.text()).toBe("original:application body");
	});

	it.each([
		"function",
		"fetch",
	] as const)("passes authenticated request metadata to the %s handler despite later mutation", async (kind) => {
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const authorized = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const application = async (request: Request) =>
			new Response(
				`${request.method}:${request.url}:${request.headers.get("authorization")}:${await request.text()}`,
			);
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: () =>
				kind === "function" ? application : { fetch: application },
			authorize: async ({ request }) => {
				expect(request.method).toBe("POST");
				expect(request.url).toBe("https://example.test/app");
				expect(request.headers.get("authorization")).toBe("tenant-a");
				entered();
				await waiting;
				return true;
			},
		});
		const request = new Request("https://example.test/app", {
			method: "POST",
			headers: { authorization: "tenant-a" },
			body: "message",
		});
		const response = binding.handle(
			{ name: "web", key: ["a"], vars: {} },
			request,
		);
		await authorized;
		request.headers.set("authorization", "tenant-b");
		Object.defineProperty(request, "method", { value: "DELETE" });
		Object.defineProperty(request, "url", {
			value: "https://example.test/other",
		});
		release();
		expect(await (await response).text()).toBe(
			"POST:https://example.test/app:tenant-a:message",
		);
	});

	it("preserves the authorized actor activation when the caller changes its context", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let instances = 0;
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: () => {
				const id = ++instances;
				return () => new Response(String(id));
			},
			authorize: async ({ actorKey }) => {
				if (actorKey[0] === "a") await waiting;
				return true;
			},
		});
		const varsB = {};
		expect(
			await (
				await binding.handle(
					{ name: "web", key: ["b"], vars: varsB },
					new Request("https://example.test/"),
				)
			).text(),
		).toBe("1");
		const context = { name: "web", key: ["a"], vars: {} };
		const result = binding.handle(
			context,
			new Request("https://example.test/"),
		);
		context.vars = varsB;
		release();
		expect(await (await result).text()).toBe("2");
	});

	it("captures bounded actor keys without invoking a caller-supplied iterator", async () => {
		const key = ["tenant"];
		Object.defineProperty(key, Symbol.iterator, {
			value: () => {
				throw new Error("unexpected iterator");
			},
		});
		let observed: readonly string[] | undefined;
		const authorize = ({ actorKey }: { actorKey: readonly string[] }) => {
			observed = actorKey;
			return true;
		};
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: handler,
			authorize,
		});
		const result = await binding.handle(
			{ name: "web", key, vars: {} },
			new Request("https://example.test/"),
		);
		expect(result.status).toBe(200);
		expect(observed).toEqual(["tenant"]);
	});

	it("rejects proxied, revoked and accessor-backed actor contexts and keys without traps", async () => {
		let traps = 0;
		let authorizations = 0;
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: handler,
			authorize: () => {
				authorizations++;
				return true;
			},
		});
		const key = ["tenant"];
		const proxiedKey = new Proxy(key, {
			get() {
				traps++;
				throw new Error("key trap");
			},
		});
		const revokedKey = Proxy.revocable(["tenant"], {});
		revokedKey.revoke();
		const accessorKey = ["tenant"];
		Object.defineProperty(accessorKey, "0", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("key accessor");
			},
		});
		const context = { name: "web", key, vars: {} };
		const proxiedContext = new Proxy(context, {
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("context trap");
			},
		});
		const revokedContext = Proxy.revocable(context, {});
		revokedContext.revoke();
		const accessorContexts = ["name", "key", "vars"].map((field) =>
			Object.defineProperty({ ...context }, field, {
				enumerable: true,
				get() {
					traps++;
					throw new Error("context accessor");
				},
			}),
		);
		const inheritedContext = Object.create({
			get key() {
				traps++;
				throw new Error("inherited context accessor");
			},
		});
		Object.assign(inheritedContext, { name: "web", vars: {} });
		for (const input of [
			{ ...context, key: proxiedKey },
			{ ...context, key: revokedKey.proxy },
			{ ...context, key: accessorKey },
			{ ...context, key: Array(1) },
			proxiedContext,
			revokedContext.proxy,
			...accessorContexts,
			inheritedContext,
		]) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed host contexts deliberately exercise the runtime boundary.
			const result = await binding.handle(
				input as never,
				new Request("https://example.test/"),
			);
			expect(result.status).toBe(403);
		}
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this exercises the native callback with deliberately malformed contexts.
		const onRequest = binding.actor.config.onRequest as typeof binding.handle;
		for (const input of [
			proxiedContext,
			revokedContext.proxy,
			...accessorContexts,
		]) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed host contexts deliberately exercise the runtime boundary.
			const result = await onRequest(
				input as never,
				new Request("https://example.test/"),
			);
			expect(result.status).toBe(403);
		}
		expect(traps).toBe(0);
		expect(authorizations).toBe(0);
	});

	it("accepts authenticated native context getters only through the actor callback", async () => {
		let calls = 0;
		const vars = {};
		const context = {
			get name() {
				calls++;
				return "web";
			},
			get key() {
				calls++;
				return ["tenant"];
			},
			get vars() {
				calls++;
				return vars;
			},
		};
		const inherited = Object.create(context);
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: handler,
			authorize: () => true,
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture models the trusted Rivet native context adapter.
		const onRequest = binding.actor.config.onRequest as typeof binding.handle;
		expect(
			(await binding.handle(inherited, new Request("https://example.test/")))
				.status,
		).toBe(403);
		expect(calls).toBe(0);
		expect(
			(await onRequest(inherited, new Request("https://example.test/"))).status,
		).toBe(200);
		expect(calls).toBe(3);
	});

	it("moves a streaming body without a second unconsumed tee or unbounded prefetch", async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array([1]));
				if (pulls === 64) controller.close();
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			body: stream,
			duplex: "half",
		};
		const request = new Request("https://example.test/", init);
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: () => async (input: Request) =>
				new Response(String((await input.arrayBuffer()).byteLength)),
			authorize: async () => {
				await waiting;
				return true;
			},
		});
		const response = binding.handle(
			{ name: "web", key: ["a"], vars: {} },
			request,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(request.body?.locked).toBe(true);
		expect(pulls).toBeLessThanOrEqual(8);
		release();
		expect(await (await response).text()).toBe("64");
	});

	it("rejects a consumed body before authorization or application code runs", async () => {
		const authorize = vi.fn(() => true);
		const entrypoint = vi.fn(() => () => new Response("unexpected"));
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint,
			authorize,
		});
		const request = new Request("https://example.test/", {
			method: "POST",
			body: "used",
		});
		await request.text();
		expect(
			(await binding.handle({ name: "web", key: ["a"], vars: {} }, request))
				.status,
		).toBe(403);
		expect(authorize).not.toHaveBeenCalled();
		expect(entrypoint).not.toHaveBeenCalled();
	});

	it("cancels the transferred body when authorization denies the request", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			body,
			duplex: "half",
		};
		const request = new Request("https://example.test/", init);
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint: handler,
			authorize: () => false,
		});
		expect(
			(await binding.handle({ name: "web", key: ["a"], vars: {} }, request))
				.status,
		).toBe(403);
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	it("initializes an application only after authorization and once per activation", async () => {
		const entrypoint = vi.fn(() => () => new Response("ok"));
		const authorize = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const binding = createRivetHttpActor({
			actorName: "web",
			entrypoint,
			authorize,
		});
		const context = { name: "web", key: ["tenant"], vars: {} };
		const request = () => new Request("https://example.test/");
		expect((await binding.handle(context, request())).status).toBe(403);
		expect(entrypoint).not.toHaveBeenCalled();
		await binding.handle(context, request());
		await binding.handle(context, request());
		expect(entrypoint).toHaveBeenCalledTimes(1);
		await binding.handle({ ...context, vars: {} }, request());
		expect(entrypoint).toHaveBeenCalledTimes(2);
	});

	it("refuses a source registry that does not actually contain the bound actor", () => {
		const { binding, source } = application();
		const registry = setup({
			use: { web: actor({ actions: {} }) },
			noWelcome: true,
		});
		expect(() =>
			bindRivetHttpSource({
				main: "/src/app.ts",
				resourceName: "web",
				kind: "web",
				actorName: "web",
				sourceDigest: `sha256:${"a".repeat(64)}`,
				sourceFence: source.sourceFence,
				registry,
				binding,
				verifySource: () => true,
			}),
		).toThrow("RIVET_SOURCE_MISMATCH");
	});

	it("requires independent host source verification", () => {
		const { source } = application();
		expect(() =>
			bindRivetHttpSource({ ...source, verifySource: () => false }),
		).toThrow("RIVET_SOURCE_UNVERIFIED");
		expect(() =>
			bindRivetHttpSource({
				...source,
				verifySource: () => {
					throw new Error("unavailable");
				},
			}),
		).toThrow("RIVET_SOURCE_UNVERIFIED");
	});

	it("requires the Alchemy resource name to match the registered actor name", () => {
		const { source } = application();
		expect(() =>
			bindRivetHttpSource({ ...source, resourceName: "other" }),
		).toThrow("RIVET_SOURCE_MISMATCH");
	});

	it("prevents replacing the request handler after binding", () => {
		const { binding, source } = application();
		expect(() =>
			Object.assign(binding.actor.config, {
				onRequest: () => new Response("substituted"),
			}),
		).toThrow(TypeError);
		expect(() => bindRivetHttpSource(source)).not.toThrow();
	});

	it("prevents replacing the activation initializer", () => {
		const { binding, source } = application();
		expect(() =>
			Object.assign(binding.actor.config, { createVars: () => ({}) }),
		).toThrow(TypeError);
		expect(() => bindRivetHttpSource(source)).not.toThrow();
	});

	it("prevents adding unauthenticated actor hooks or changing runtime options", () => {
		const { binding, source } = application();
		expect(() =>
			Object.assign(binding.actor.config, { onWebSocket: () => {} }),
		).toThrow(TypeError);
		expect(() =>
			Object.assign(binding.actor.config.options, {
				enableActorRuntimeSocket: true,
			}),
		).toThrow(TypeError);
		expect(() => Object.setPrototypeOf(binding.actor, {})).toThrow(TypeError);
		expect(() => bindRivetHttpSource(source)).not.toThrow();
	});

	it("exposes real DurableObject mapping and refuses unsupported entrypoints, dependencies and enabled replay", () => {
		const { source, declaration } = application();
		const mappers = createRivetPrimitiveMappers(source);
		expect(mappers.web.resourceTypes).toEqual(["Rivet.DurableObject"]);
		const input = {
			declaration,
			entrypoint: handler,
			requirements: {},
			bindleName: "app",
			dependencyDeclarations: {},
		};
		expect(() => mappers.web.validate(input)).not.toThrow();
		expect(() =>
			mappers.web.validate({
				...input,
				entrypoint: () => (request: Request) => new Response(request.url),
			}),
		).toThrow("RIVET_SOURCE_MISMATCH");
		expect(() =>
			mappers.web.validate({
				...input,
				dependencyDeclarations: { db: declaration },
			}),
		).toThrow("RIVET_DEPENDENCY_UNSUPPORTED");
		expect(() =>
			mappers.web.validate({
				...input,
				declaration: {
					...declaration,
					annotations: [
						{
							provider: "hobo",
							option: "session-replay",
							config: { enabled: true },
						},
					],
				},
			}),
		).toThrow("RIVET_REPLAY_UNSUPPORTED");
		expect(() =>
			mappers.web.validate({
				...input,
				declaration: {
					...declaration,
					annotations: [
						{
							provider: "hobo",
							option: "session-replay",
							config: { enabled: false },
						},
					],
				},
			}),
		).not.toThrow();
	});

	it("reports only the attested HTTP kind as mapped and leaves storage and messaging unsupported", () => {
		const { source } = application();
		const report = describeRivetPrimitiveSupport(
			[
				{ factory: "web", allowVerbs: [] },
				{ factory: "api", allowVerbs: [] },
				{ factory: "service", allowVerbs: [] },
				{ factory: "kv", allowVerbs: ["get", "put"] },
				{ factory: "bucket", allowVerbs: ["get", "put"] },
				{ factory: "queue", allowVerbs: ["send", "receive"] },
				{ factory: "topic", allowVerbs: ["publish", "subscribe"] },
			],
			createRivetPrimitiveMappers(source),
		);
		expect(report[0]).toMatchObject({
			kind: "web",
			status: "partial",
			resourceTypes: ["Rivet.DurableObject"],
			bindsEntrypoint: true,
		});
		for (const row of report.slice(1)) {
			expect(row.status).toBe("unsupported");
			expect(row.resourceTypes).toEqual([]);
			expect(row.reason).not.toBe("");
		}
	});
});
