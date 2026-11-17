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
			{ name: "web", key: ["tenant", "app"] },
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
				{ name: "web", key: ["tenant"] },
				new Request("https://example.test/"),
			);
			expect(result.status).toBe(403);
		}
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

	it("refuses a registry actor whose request handler is replaced after binding", () => {
		const { binding, source } = application();
		Object.assign(binding.actor.config, {
			onRequest: () => new Response("substituted"),
		});
		expect(() => bindRivetHttpSource(source)).toThrow("RIVET_SOURCE_MISMATCH");
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
