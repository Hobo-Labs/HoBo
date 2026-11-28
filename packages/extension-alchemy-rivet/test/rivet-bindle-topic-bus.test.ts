/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: the test injects an adversarial array callback at the boundary. */
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import { durableMessagingOperation } from "@hobo/core";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	mapBindleToAlchemy,
} from "@hobo/iac-alchemy";
import {
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
	createDurableMessagingPortMetadataGrant,
} from "@hobo/runtime/durable-messaging-host";
import {
	createRivetDurableTopicBusActor,
	createRivetDurableTopicMetadataGrant,
} from "@hobo/runtime-rivet";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setup } from "rivetkit";
import { expect, it } from "vitest";
import { bindle } from "../../bindles/src/bindle.js";
import { sessionReplay } from "../../bindles/src/session-replay.js";
import { createSqliteBusConformanceHost } from "../../runtimes/runtime-rivet/test/fixtures/durable-topic-bus-conformance.js";
import {
	bindRivetBindleTopicEntrypoint,
	createRivetBindleTopicBusApplication,
	createRivetBindleTopicBusMappers,
} from "../src/rivet-http-topic-bus.js";
import { rivetTopicUnavailable } from "../src/rivet-topic-unavailable.js";
import { testStateOwnership } from "./route-fixture.js";

it("keeps topic failures unavailable when application code changes array prototypes", async () => {
	const iterator = Array.prototype[Symbol.iterator];
	const push = Array.prototype.push;
	let response: Response;
	try {
		Reflect.set(Array.prototype, Symbol.iterator, function* () {});
		Reflect.set(Array.prototype, "push", () => 0);
		response = rivetTopicUnavailable("scope-unverified");
	} finally {
		Reflect.set(Array.prototype, Symbol.iterator, iterator);
		Reflect.set(Array.prototype, "push", push);
	}
	expect(response.status).toBe(503);
	let pushed: Response;
	try {
		Reflect.set(Array.prototype, "push", () => 0);
		pushed = rivetTopicUnavailable("scope-unverified");
	} finally {
		Reflect.set(Array.prototype, "push", push);
	}
	expect(pushed.status).toBe(503);
	expect(await pushed.json()).toEqual({
		status: "topic-unavailable",
		reason: "scope-unverified",
	});
	let sealed: Response;
	try {
		Reflect.set(Object.prototype, "writable", true);
		Reflect.set(Object.prototype, "configurable", true);
		sealed = rivetTopicUnavailable("scope-unverified");
	} finally {
		Reflect.deleteProperty(Object.prototype, "writable");
		Reflect.deleteProperty(Object.prototype, "configurable");
	}
	expect(Object.getOwnPropertyDescriptor(sealed, "then")).toMatchObject({
		writable: false,
		configurable: false,
		value: undefined,
	});
	expect(await sealed.json()).toEqual({
		status: "topic-unavailable",
		reason: "scope-unverified",
	});
	const ordinary = rivetTopicUnavailable("scope-unverified");
	expect(ordinary.status).toBe(503);
	expect(await ordinary.json()).toEqual({
		status: "topic-unavailable",
		reason: "scope-unverified",
	});
});

it("gates an HTTP application's scoped topic binding on real journal provisioning", async () => {
	const fixture = await createSqliteBusConformanceHost();
	try {
		const clientOptions = {
			...(await fixture.open("tenant-a")),
			metadataGrant: createRivetDurableTopicMetadataGrant(),
		};
		const bus = createRivetDurableTopicBusActor({
			actorName: clientOptions.binding.actorName,
			semanticDigest: clientOptions.binding.semanticDigest,
			now: () => 1_000,
			resolveScope: () => ({ tenant: "tenant-a", instance: "orders" }),
			authorize: () => true,
			authorizeInstanceScope: () => true,
			verifyIngress: () => true,
		});
		const definition = bindle("shop", (b) => {
			const orders = b.topic().allow("publish");
			const audit = b.topic().allow("publish");
			return {
				orders,
				audit,
				web: b
					.web()
					.with(sessionReplay({ enabled: false }))
					.dependsOn(orders, audit),
			};
		});
		const ordersResource = definition.resources.orders;
		if (!ordersResource) throw Error("missing orders resource");
		const mutableResources = {
			...definition.resources,
			orders: {
				...ordersResource,
				declaredAllow: [...ordersResource.declaredAllow],
			},
		};
		let injected = false;
		let publishMaps = 0;
		const originalPush = Array.prototype.push;
		const pushDescriptor = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"push",
		);
		const originalMap = Array.prototype.map;
		const mapDescriptor = Object.getOwnPropertyDescriptor(
			Array.prototype,
			"map",
		);
		let starts = 0;
		let invoked = 0;
		let revokeOnStart = true;
		let permitsProvisioning = false;
		let scopeValid = true;
		let app: ReturnType<typeof createRivetBindleTopicBusApplication>;
		try {
			Object.defineProperty(Array.prototype, "map", {
				configurable: true,
				writable: true,
				value: function (this: unknown[], ...args: unknown[]) {
					if (this.length === 1 && this[0] === "publish") {
						publishMaps++;
						return [];
					}
					return Reflect.apply(originalMap, this, args);
				},
			});
			Object.defineProperty(Array.prototype, "push", {
				configurable: true,
				writable: true,
				value: function (this: unknown[], ...args: unknown[]) {
					const first = args[0];
					if (
						!injected &&
						first &&
						typeof first === "object" &&
						Object.hasOwn(first, "operation")
					) {
						injected = true;
						mutableResources.orders.declaredAllow.length = 0;
					}
					return Reflect.apply(originalPush, this, args);
				},
			});
			app = createRivetBindleTopicBusApplication({
				actorName: "web",
				bus,
				clientOptions,
				verifyScope: () => scopeValid,
				authorize: () => true,
				bindle: {
					bindleName: definition.name,
					applicationName: "web",
					resources: mutableResources,
					edges: definition.edges,
					bindings: [
						{ resourceName: "orders", topic: "orders", subscriptions: [] },
						{ resourceName: "audit", topic: "audit", subscriptions: [] },
					],
				},
				operations: [
					{
						topic: "audit",
						operation: durableMessagingOperation(10_000, "topicaudit123456"),
					},
					{
						topic: "orders",
						operation: durableMessagingOperation(10_000, "topicorders12345"),
					},
				],
				hostOptions: (port) => {
					const portMetadataGrant = createDurableMessagingPortMetadataGrant({
						port,
						limits: clientOptions.binding.limits,
						verify: () => true,
					});
					return {
						provisioning: {
							limitsGrant: createDurableMessagingLimitsGrant(),
							lifecycle: createDurableMessagingLifecycle(),
							portMetadataGrant,
							authorize: () => permitsProvisioning,
						},
						application: {
							limitsGrant: createDurableMessagingLimitsGrant(),
							lifecycle: createDurableMessagingLifecycle(),
							portMetadataGrant,
							verify: () => true,
						},
					};
				},
				application: (host) => {
					starts++;
					if (revokeOnStart) {
						revokeOnStart = false;
						scopeValid = false;
					}
					const topic = host.topic("orders");
					return async () => {
						invoked++;
						const outcome = await topic.publish({
							operation: {
								id: durableMessagingOperation(10_000, "publishnonce1234").id,
								expiresAtMs: 10_000n,
							},
							message: {
								id: "order-1",
								subject: "created",
								payload: new Uint8Array([7]),
								attributes: [],
							},
						});
						return Response.json({
							tag: outcome.tag,
							messageId:
								outcome.tag === "committed" ? outcome.val.messageId : undefined,
						});
					};
				},
			});
		} finally {
			if (pushDescriptor)
				Object.defineProperty(Array.prototype, "push", pushDescriptor);
			if (mapDescriptor)
				Object.defineProperty(Array.prototype, "map", mapDescriptor);
		}
		expect(injected).toBe(true);
		expect(publishMaps).toBe(0);
		const deployed = bindRivetBindleTopicEntrypoint(definition, app);
		expect(deployed.entrypoint("web")).toBe(app.http.entrypoint);
		expect(definition.entrypoint("web")).toBeUndefined();
		const existingHandler = bindle("shop", (b) => {
			const orders = b.topic().allow("publish");
			const audit = b.topic().allow("publish");
			return {
				orders,
				audit,
				web: b.web(() => "already bound").dependsOn(orders, audit),
			};
		});
		expect(() =>
			bindRivetBindleTopicEntrypoint(existingHandler, app),
		).toThrow();
		expect(() =>
			bindRivetBindleTopicEntrypoint(
				{ ...definition, name: "different", entrypoint: definition.entrypoint },
				app,
			),
		).toThrow();
		const registry = setup({
			use: { web: app.http.actor, [bus.actorName]: bus.actor },
			noWelcome: true,
		});
		const digest = (value: string) => `sha256:${value.repeat(64)}`;
		const mapperOptions = {
			application: app,
			source: {
				main: "/src/main.ts",
				resourceName: "web",
				kind: "web" as const,
				actorName: "web",
				sourceDigest: digest("a"),
				sourceFence: {
					sourceDigest: digest("a"),
					environmentDigest: bus.semanticDigest,
					proofRef: "host:source",
					verify: () => true,
				},
				registry,
				binding: app.http,
				verifySource: () => true,
			},
			poolDigest: digest("b"),
			isolationDigest: digest("c"),
			poolHost: {
				deployExternal: () => Effect.void,
				deployCrate: () => Effect.void,
			},
			verifyPool: () => true,
		};
		const mappers = createRivetBindleTopicBusMappers(mapperOptions);
		Reflect.set(mapperOptions.source, "kind", "service");
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
		const mapping = await Effect.runPromise(
			mapBindleToAlchemy(deployed, mappers, {
				assessRequirements: () => ({ status: "supported" }),
			}).pipe(
				Effect.provideService(StackContext, {
					name: "Shop",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
				Effect.provide(providers),
			),
		);
		expect(mapping.resources).toHaveLength(1);
		expect(mapping.resources[0]?.Type).toBe("Rivet.DurableObject");
		expect(mapping.primary.audit).toBe(mapping.primary.orders);
		expect(mapping.primary.web).toBe(mapping.primary.orders);
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-topic-preview-"));
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		try {
			const stack = Stack(
				"Shop",
				{ providers, state: inMemoryState() },
				mapBindleToAlchemy(deployed, mappers, {
					assessRequirements: () => ({ status: "supported" }),
				}).pipe(Effect.map(() => ({}))),
			);
			let assessed = 0;
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:source",
					environmentDigest: bus.semanticDigest,
					sourceRequirements: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							bindleName: "shop",
							applicationName: "web",
							sourceKind: "rivet-http",
							sourcePath: "/src/main.ts",
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) => sourceClaims.length === 1,
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "Shop",
					stage: "test",
					programResourceId: "shop",
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
					assess: (inventory) => {
						assessed++;
						expect(
							inventory.resources.map((resource) => resource.resourceId),
						).toEqual(["web"]);
						return { inventory };
					},
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => true,
					uncertain: () => {},
				},
			});
			const preview = await provider.preview({
				programId: "shop",
				deploymentId: "d",
				resourceId: "shop",
				provider: "rivet",
				driver: "external",
				action: "apply",
				stackName: "Shop",
			});
			expect(preview.changes).toBe(1);
			expect(assessed).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
		const mismatched = bindle("shop", (b) => {
			const orders = b.topic().allow("publish");
			return {
				orders,
				web: b
					.web(app.http.entrypoint)
					.with(sessionReplay({ enabled: false }))
					.dependsOn(orders),
			};
		});
		expect(() =>
			mapBindleToAlchemy(mismatched, mappers, {
				assessRequirements: () => ({ status: "supported" }),
			}),
		).toThrow();
		const wrongPermissions = bindle("shop", (b) => {
			const orders = b.topic().allow("publish", "subscribe");
			const audit = b.topic().allow("publish");
			return {
				orders,
				audit,
				web: b
					.web(app.http.entrypoint)
					.with(sessionReplay({ enabled: false }))
					.dependsOn(orders, audit),
			};
		});
		expect(() =>
			mapBindleToAlchemy(wrongPermissions, mappers, {
				assessRequirements: () => ({ status: "supported" }),
			}),
		).toThrow();
		const orphaned = bindle("shop", (b) => ({
			orders: b.topic().allow("publish"),
			audit: b.topic().allow("publish"),
		}));
		expect(() =>
			mapBindleToAlchemy(orphaned, mappers, {
				assessRequirements: () => ({ status: "supported" }),
			}),
		).toThrow();
		const vars = {};
		const request = () =>
			app.http.handle(
				{ name: "web", key: ["tenant-a"], vars },
				new Request("https://app.test/"),
			);
		const refused = await request();
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({
			status: "topic-unavailable",
			reason: "unknown",
		});
		expect(starts).toBe(0);
		permitsProvisioning = true;
		const held = await fixture.controls.holdNextMutation("before-dispatch");
		const inFlight = request();
		await held.reached;
		scopeValid = false;
		await held.release();
		expect((await inFlight).status).toBe(503);
		expect(starts).toBe(0);
		scopeValid = true;
		expect((await request()).status).toBe(503);
		expect(starts).toBe(1);
		expect(invoked).toBe(0);
		scopeValid = true;
		const accepted = await request();
		const payload = await accepted.json();
		expect({ status: accepted.status, payload }).toEqual({
			status: 200,
			payload: { tag: "committed", messageId: "order-1" },
		});
		expect(starts).toBe(1);
		expect(invoked).toBe(1);
	} finally {
		await fixture.controls.close();
	}
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
