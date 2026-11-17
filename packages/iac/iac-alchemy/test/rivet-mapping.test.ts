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
} from "../src/rivet.js";
import { createRivetHttpActor } from "../src/rivet-runtime.js";

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
		const pool = Layer.succeed(PoolHost, {
			deployExternal: (input) =>
				Effect.sync(() => {
					deploys.push(input.main);
				}),
			deployCrate: () => Effect.void,
		});
		const stack = Stack(
			"App",
			{ providers: Layer.merge(registry, pool), state: inMemoryState() },
			program.pipe(Effect.map(() => ({}))),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-alchemy-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		try {
			const provider = createAlchemyIacProvider({
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
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
		expect(binding.actor.config.onRequest).toBe(binding.handle);
	});

	it("denies requests if host authorization rejects or fails", async () => {
		for (const authorize of [
			async () => false,
			async () => {
				throw new Error("unavailable");
			},
		]) {
			const binding = createRivetHttpActor({
				actorName: "web",
				entrypoint: handler,
				authorize,
			});
			const result = await binding.handle(
				{ name: "web", key: ["tenant"], vars: {} },
				new Request("https://example.test/"),
			);
			expect(result.status).toBe(403);
		}
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
		const { binding } = application();
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
			mappers.web.validate({ ...input, entrypoint: () => handler }),
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
});
