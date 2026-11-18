import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import { alchemyTarget, createAlchemyIacProvider } from "@hobo/iac-alchemy";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setup } from "rivetkit";
import { describe, expect, it, vi } from "vitest";
import {
	createRivetDurableTopicBusActor,
	createRivetDurableTopicMetadataGrant,
	RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	RIVET_DURABLE_TOPIC_BUS_LIMITS,
} from "@hobo/runtime-rivet";
import {
	createRivetHttpTopicBusApplication,
	createRivetHttpTopicBusMappers,
	type RivetHttpTopicBusApplicationOptions,
} from "../src/rivet-http-topic-bus.js";
import { testStateOwnership } from "./route-fixture.js";

const digest = (value: string) => `sha256:${value.repeat(64)}`;
const operation = { id: "v1.2000000000000.publishnonce1234", expiresAtMs: 2_000_000_000_000 };

function fixture() {
	const bus = createRivetDurableTopicBusActor({
		actorName: "events", semanticDigest: digest("d"), now: () => 1_000,
		resolveScope: () => ({ tenant: "tenant-a", instance: "orders" }),
		authorize: () => true, authorizeInstanceScope: () => true, verifyIngress: () => true,
	});
	let valid = true;
	let effects = 0;
	const fetch = vi.fn(async () =>
		Response.json({ status: "committed", value: { messageId: "m1", sequence: 1 } }),
	);
	const clientOptions = {
		binding: {
			actorName: "events", actorKey: ["tenant-a", "orders"],
			tenant: "tenant-a", instance: "orders", semanticDigest: digest("d"),
			limits: RIVET_DURABLE_TOPIC_BUS_LIMITS,
			actorCapabilities: RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
		},
		metadataGrant: createRivetDurableTopicMetadataGrant(),
		verifyTransport: () => true, authorize: () => ({ authorization: "test" }),
		revalidate: () => true, fetch,
	};
	const options: RivetHttpTopicBusApplicationOptions = {
		actorName: "web", bus, clientOptions, verifyScope: () => valid,
		authorize: ({ actorKey, request, bus: scope }) =>
			actorKey[0] === scope.tenant && request.headers.get("authorization") === scope.tenant,
		application: (client) => async () => {
			effects++;
			return Response.json(await client.publish({
				operation, topic: "orders",
				message: { id: "m1", subject: "created", payload: new Uint8Array([1]), attributes: [] },
			}));
		},
	};
	const app = createRivetHttpTopicBusApplication(options);
	return { bus, app, options, fetch, revoke: () => { valid = false; }, effects: () => effects };
}

describe("Rivet HTTP application with a durable topic bus", () => {
	it("authorizes the HTTP principal and passes the bound bus client to the handler", async () => {
		const f = fixture();
		const denied = await f.app.http.handle(
			{ name: "web", key: ["tenant-b"], vars: {} },
			new Request("https://app.test/", { headers: { authorization: "tenant-b" } }),
		);
		expect(denied.status).toBe(403);
		expect(f.effects()).toBe(0);
		const allowed = await f.app.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", { headers: { authorization: "tenant-a" } }),
		);
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toMatchObject({ status: "committed", value: { messageId: "m1", sequence: 1 } });
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it("refuses changed scope, profiles, accessors and proxies before application work", () => {
		const f = fixture();
		let traps = 0;
		const key = new Proxy(["tenant-a"], { getPrototypeOf() { traps++; throw new Error("trap"); } });
		expect(() => createRivetHttpTopicBusApplication({
			...f.options,
			clientOptions: { ...f.options.clientOptions, binding: { ...f.options.clientOptions.binding, actorKey: key } },
		})).toThrow();
		expect(() => createRivetHttpTopicBusApplication({
			...f.options,
			clientOptions: { ...f.options.clientOptions, binding: { ...f.options.clientOptions.binding, actorName: "other" } },
		})).toThrow();
		expect(() => createRivetHttpTopicBusApplication({
			...f.options,
			clientOptions: { ...f.options.clientOptions, binding: { ...f.options.clientOptions.binding, actorCapabilities: { ...RIVET_DURABLE_TOPIC_BUS_CAPABILITIES, leases: false } } },
		})).toThrow();
		const options = { ...f.options };
		Object.defineProperty(options, "verifyScope", { enumerable: true, get() { traps++; throw new Error("getter"); } });
		expect(() => createRivetHttpTopicBusApplication(options)).toThrow();
		expect(traps).toBe(0);
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("refuses a rejected asynchronous scope verifier without an unhandled rejection", async () => {
		const f = fixture();
		const verifyScope = (() => Promise.reject(new Error("async verifier"))) as unknown as RivetHttpTopicBusApplicationOptions["verifyScope"];
		expect(() => createRivetHttpTopicBusApplication({ ...f.options, verifyScope })).toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("does not start application work after the host revokes the bus scope", async () => {
		const f = fixture();
		f.revoke();
		const response = await f.app.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", { headers: { authorization: "tenant-a" } }),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ execution: "not-started" });
		expect(f.effects()).toBe(0);
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("withholds a response if bus scope is revoked after a publish", async () => {
		const f = fixture();
		f.fetch.mockImplementationOnce(async () => {
			f.revoke();
			return Response.json({ status: "committed", value: { messageId: "m1", sequence: 1 } });
		});
		const response = await f.app.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", { headers: { authorization: "tenant-a" } }),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ execution: "possibly-completed" });
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});

	it("refuses a revoked metadata grant before starting the handler", async () => {
		const f = fixture();
		f.options.clientOptions.metadataGrant.revoke();
		const response = await f.app.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", { headers: { authorization: "tenant-a" } }),
		);
		expect(response.status).toBe(503);
		expect(f.effects()).toBe(0);
		expect(f.fetch).not.toHaveBeenCalled();
	});

	it("requires the exact HTTP and bus actor registry and source environment", () => {
		const f = fixture();
		const registry = setup({ use: { web: f.app.http.actor, events: f.bus.actor }, noWelcome: true });
		const input = {
			application: f.app,
			source: {
				main: "/src/main.ts", resourceName: "web", kind: "web" as const, actorName: "web",
				sourceDigest: digest("a"),
				sourceFence: { sourceDigest: digest("a"), environmentDigest: digest("d"), proofRef: "host:source", verify: () => true },
				registry, binding: f.app.http, verifySource: () => true,
			},
			poolDigest: digest("b"), isolationDigest: digest("c"),
			poolHost: { deployExternal: () => Effect.void, deployCrate: () => Effect.void },
			verifyPool: () => true,
		};
		const mappers = createRivetHttpTopicBusMappers(input);
		expect(mappers.web.resourceTypes).toContain("Rivet.DurableObject");
		expect(mappers.web.limitations?.join(" ")).toContain("asynchronous");
		expect(() => createRivetHttpTopicBusMappers({ ...input, application: { ...f.app } })).toThrow();
		expect(() => createRivetHttpTopicBusMappers({
			...input,
			source: { ...input.source, sourceFence: { ...input.source.sourceFence, environmentDigest: digest("e") } },
		})).toThrow();
		Reflect.set(registry.config.use, "events", f.app.http.actor);
		expect(() => createRivetHttpTopicBusMappers(input)).toThrow();
	});

	it("previews a real DurableObject and rejects legacy topic dependencies", async () => {
		const f = fixture();
		const main = "/src/main.ts";
		const registry = setup({
			use: { web: f.app.http.actor, events: f.bus.actor },
			noWelcome: true,
		});
		const calls: string[] = [];
		const mappers = createRivetHttpTopicBusMappers({
			application: f.app,
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
				binding: f.app.http,
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
			entrypoint: f.app.http.entrypoint,
			requirements: {},
			bindleName: "app",
			dependencyDeclarations: {},
			dependencies: {},
		};
		expect(() =>
			mappers.web.validate({
				...mapperInput,
				declaration: { ...declaration, dependsOn: ["events"] },
				dependencyDeclarations: {
					events: { ...declaration, name: "events", kind: "topic" },
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
			join(tmpdir(), "hobo-rivet-http-bus-plan-"),
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
