/* oxlint-disable unicorn/no-thenable -- SAFETY: this test deliberately constructs a hostile thenable. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types } from "node:util";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

type Store = Resource<"Spec.Store", object, { id: string }>;
type Queue = Resource<"Spec.Queue", object, { id: string }>;
type Web = Resource<"Spec.Web", object, { id: string }>;
const Store = Resource<Store>("Spec.Store");
const Queue = Resource<Queue>("Spec.Queue");
const Web = Resource<Web>("Spec.Web");

const entrypoint = () => "application logic";
const supportedRequirements = {
	assessRequirements: () => ({ status: "supported" as const }),
};
const declaration = {
	name: "app",
	resources: {
		store: {
			kind: "bucket",
			name: "store",
			stableId: "bucket:store",
			declaredAllow: ["read", "write"],
			dependsOn: [],
			annotations: [],
		},
		queue: {
			kind: "queue",
			name: "queue",
			stableId: "queue:queue",
			declaredAllow: ["enqueue", "dequeue"],
			dependsOn: [],
			annotations: [],
		},
		web: {
			kind: "web",
			name: "web",
			stableId: "web:web",
			declaredAllow: [],
			dependsOn: ["bucket", "queue"],
			annotations: [],
		},
	},
	edges: [
		{ from: "web", to: "store" },
		{ from: "web", to: "queue" },
	],
	requirements: {},
	entrypoint(name: string) {
		return name === "web" ? entrypoint : undefined;
	},
};

function mappers(observed: string[]) {
	return {
		bucket: {
			resourceTypes: ["Spec.Store"],
			operations: ["read", "write"],
			annotations: [],
			bindsEntrypoint: false,
			build: (input) =>
				Effect.gen(function* () {
					observed.push(input.declaration.name);
					const primary = yield* Store(input.declaration.name, {});
					return { primary, resources: [primary], boundDependencies: [] };
				}),
		},
		queue: {
			resourceTypes: ["Spec.Queue"],
			operations: ["enqueue", "dequeue"],
			annotations: [],
			bindsEntrypoint: false,
			build: (input) =>
				Effect.gen(function* () {
					observed.push(input.declaration.name);
					const primary = yield* Queue(input.declaration.name, {});
					return { primary, resources: [primary], boundDependencies: [] };
				}),
		},
		web: {
			resourceTypes: ["Spec.Web"],
			operations: [],
			annotations: [],
			bindsEntrypoint: true,
			build: (input) =>
				Effect.gen(function* () {
					observed.push(input.declaration.name);
					expect(input.dependencies.store.Type).toBe("Spec.Store");
					expect(input.dependencies.queue.Type).toBe("Spec.Queue");
					expect(input.entrypoint).toBe(entrypoint);
					const primary = yield* Web(input.declaration.name, {});
					return {
						primary,
						resources: [primary],
						boundDependencies: ["store", "queue"],
						boundEntrypoint: input.entrypoint,
					};
				}),
		},
	};
}

describe("explicit Alchemy primitive mapping", () => {
	it("refuses and observes an accidental rejected requirements Promise", async () => {
		const observed: string[] = [];
		expect(() =>
			mapBindleToAlchemy(declaration, mappers(observed), {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this exercises the runtime boundary, beyond the synchronous SDK type.
				assessRequirements: () =>
					Promise.reject(new Error("host rejected")) as never,
			}),
		).toThrow("REQUIREMENTS_ASSESSMENT_FAILED");
		expect(observed).toEqual([]);
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("rejects a proxied requirements result without invoking its traps", () => {
		let traps = 0;
		const decision = new Proxy(
			{ status: "supported" },
			{
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("requirements trap");
				},
			},
		);
		expect(() =>
			mapBindleToAlchemy(declaration, mappers([]), {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the proxy deliberately violates the synchronous SDK contract.
				assessRequirements: () => decision as never,
			}),
		).toThrow("REQUIREMENTS_ASSESSMENT_FAILED");
		expect(traps).toBe(0);
	});

	it("rejects sparse declarations even if descriptor-map indices are inherited", () => {
		const sparse: unknown[] = [];
		sparse.length = 1;
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "0");
		Object.defineProperty(Object.prototype, "0", {
			configurable: true,
			writable: true,
			value: { value: "forged", enumerable: true },
		});
		let error: unknown;
		let assessments = 0;
		try {
			mapBindleToAlchemy(
				{ ...declaration, requirements: { values: sparse } },
				mappers([]),
				{
					assessRequirements: () => {
						assessments++;
						return { status: "supported" };
					},
				},
			);
		} catch (caught) {
			error = caught;
		} finally {
			if (previous === undefined) Reflect.deleteProperty(Object.prototype, "0");
			else Object.defineProperty(Object.prototype, "0", previous);
		}
		expect(error).toMatchObject({ code: "BINDLE_INVALID" });
		expect(assessments).toBe(0);
	});

	it("keeps its original proxy predicate when the public property is replaced", () => {
		let traps = 0;
		const source = new Proxy(declaration, {
			get() {
				traps++;
				throw new Error("get");
			},
		});
		const previous = Object.getOwnPropertyDescriptor(types, "isProxy");
		Object.defineProperty(types, "isProxy", {
			configurable: true,
			writable: true,
			value: () => false,
		});
		let error: unknown;
		try {
			mapBindleToAlchemy(source, mappers([]), supportedRequirements);
		} catch (caught) {
			error = caught;
		} finally {
			if (previous !== undefined)
				Object.defineProperty(types, "isProxy", previous);
		}
		expect(error).toMatchObject({ code: "BINDLE_INVALID" });
		expect(traps).toBe(0);
	});

	it("rejects accessor declarations without consulting an inherited descriptor value", () => {
		let traps = 0;
		const source = Object.defineProperty({ ...declaration }, "requirements", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("declaration accessor");
			},
		});
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("inherited descriptor value");
			},
		});
		let error: unknown;
		try {
			mapBindleToAlchemy(source, mappers([]), supportedRequirements);
		} catch (caught) {
			error = caught;
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", previous);
		}
		expect(error).toMatchObject({ code: "BINDLE_INVALID" });
		expect(traps).toBe(0);
	});

	it("accepts HoBo's non-enumerable own entrypoint", () => {
		const source = { ...declaration };
		Object.defineProperty(source, "entrypoint", { enumerable: false });
		expect(() =>
			mapBindleToAlchemy(source, mappers([]), supportedRequirements),
		).not.toThrow();
	});

	it("cannot hide an application entrypoint with a mutable call property", () => {
		let traps = 0;
		const lookup = function (this: typeof declaration, name: string) {
			expect(this).toBe(source);
			return name === "web" ? entrypoint : undefined;
		};
		Object.defineProperty(lookup, "call", {
			get() {
				traps++;
				return () => undefined;
			},
		});
		const source = { ...declaration, entrypoint: lookup };
		const available = mappers([]);
		expect(() =>
			mapBindleToAlchemy(
				source,
				{ ...available, web: { ...available.web, bindsEntrypoint: false } },
				supportedRequirements,
			),
		).toThrow("ENTRYPOINT_UNSUPPORTED");
		expect(traps).toBe(0);
	});

	it("rejects proxy and accessor-backed entrypoint callbacks without executing them", () => {
		let traps = 0;
		const proxied = new Proxy(declaration.entrypoint, {
			apply() {
				traps++;
				throw new Error("trap");
			},
		});
		const accessor = Object.defineProperty({ ...declaration }, "entrypoint", {
			get() {
				traps++;
				throw new Error("trap");
			},
			enumerable: true,
		});
		for (const source of [{ ...declaration, entrypoint: proxied }, accessor])
			expect(() =>
				mapBindleToAlchemy(source, mappers([]), supportedRequirements),
			).toThrow("BINDLE_INVALID");
		expect(traps).toBe(0);
	});

	it("rejects proxied and accessor-backed declaration data before reflection", () => {
		let traps = 0;
		let assessments = 0;
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					traps++;
					throw new Error("trap");
				},
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			},
		);
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		const accessor = Object.defineProperty({ ...declaration }, "resources", {
			get() {
				traps++;
				throw new Error("trap");
			},
		});
		for (const source of [
			hostile,
			revoked.proxy,
			accessor,
			{ ...declaration, name: hostile },
			{ ...declaration, name: revoked.proxy },
			{ ...declaration, name: null },
			{ ...declaration, resources: null },
			{ ...declaration, edges: null },
			{ ...declaration, resources: { broken: null } },
			{ ...declaration, edges: [null] },
			{
				...declaration,
				resources: {
					store: { ...declaration.resources.store, annotations: [null] },
				},
			},
			{ ...declaration, requirements: { nested: hostile } },
			{ ...declaration, requirements: { nested: revoked.proxy } },
		]) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: adversarial values intentionally exercise the runtime boundary.
			expect(() =>
				mapBindleToAlchemy(source as never, mappers([]), {
					assessRequirements: () => {
						assessments++;
						return { status: "supported" };
					},
				}),
			).toThrow("BINDLE_INVALID");
		}
		expect(traps).toBe(0);
		expect(assessments).toBe(0);
	});

	it("refuses and observes asynchronous primitive validation before building", async () => {
		const observed: string[] = [];
		const original = mappers(observed);
		expect(() =>
			mapBindleToAlchemy(
				declaration,
				{
					...original,
					bucket: {
						...original.bucket,
						validate: () => Promise.reject(new Error("host rejected")),
					},
				},
				supportedRequirements,
			),
		).toThrow("BINDLE_VALIDATION_UNAVAILABLE");
		expect(observed).toEqual([]);
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("refuses a returned value without inspecting arbitrary thenables", () => {
		const observed: string[] = [];
		const original = mappers(observed);
		let traps = 0;
		const value = {
			// biome-ignore lint/suspicious/noThenProperty: deliberately hostile validator result.
			get then() {
				traps++;
				throw new Error("then trap");
			},
		};
		expect(() =>
			mapBindleToAlchemy(
				declaration,
				{
					...original,
					bucket: { ...original.bucket, validate: () => value },
				},
				supportedRequirements,
			),
		).toThrow("BINDLE_VALIDATION_UNAVAILABLE");
		expect(observed).toEqual([]);
		expect(traps).toBe(0);
	});

	it("snapshots requirements, annotations, dependency declarations and mapper callbacks before effects execute", async () => {
		const source = {
			name: "snapshot",
			resources: {
				data: {
					kind: "bucket",
					name: "data",
					stableId: "bucket:data",
					declaredAllow: ["read"],
					dependsOn: [],
					annotations: [],
				},
				web: {
					kind: "web",
					name: "web",
					stableId: "web:web",
					declaredAllow: [],
					dependsOn: ["bucket"],
					annotations: [
						{
							provider: "test",
							option: "feature",
							config: { setting: { value: "before" } },
						},
					],
				},
			},
			edges: [{ from: "web", to: "data" }],
			requirements: { labels: { team: "before" } },
			entrypoint: (name: string) => (name === "web" ? entrypoint : undefined),
		};
		let seen: object | undefined;
		const registry = {
			bucket: {
				resourceTypes: ["Spec.Store"],
				operations: ["read"],
				annotations: [],
				bindsEntrypoint: false,
				validate: ({ bindleName, requirements }) => {
					expect(bindleName).toBe("snapshot");
					expect(requirements.labels.team).toBe("before");
					source.name = "changed-during-validation";
					source.requirements.labels.team = "changed-during-validation";
				},
				build: () =>
					Effect.gen(function* () {
						const primary = yield* Store("data", {});
						return { primary, resources: [primary], boundDependencies: [] };
					}),
			},
			web: {
				resourceTypes: ["Spec.Web"],
				operations: [],
				annotations: ["test:feature"],
				bindsEntrypoint: true,
				validate: ({
					bindleName,
					requirements,
					declaration,
					dependencyDeclarations,
				}) => {
					expect(bindleName).toBe("snapshot");
					expect(requirements.labels.team).toBe("before");
					expect(Object.isFrozen(requirements.labels)).toBe(true);
					expect(Object.getPrototypeOf(requirements.labels)).toBe(
						Object.prototype,
					);
					expect(Object.isFrozen(declaration.annotations[0]?.config)).toBe(
						true,
					);
					expect(
						Object.isFrozen(dependencyDeclarations.data?.declaredAllow),
					).toBe(true);
				},
				build: (input) =>
					Effect.sync(() => {
						seen = {
							name: input.bindleName,
							requirements: input.requirements,
							declaration: input.declaration,
							dependency: input.dependencyDeclarations.data,
						};
						throw new Error("observed snapshot");
					}),
			},
		};
		const program = mapBindleToAlchemy(source, registry, supportedRequirements);
		source.name = "changed";
		source.requirements.labels.team = "changed";
		source.resources.web.annotations[0].config.setting.value = "changed";
		source.resources.data.declaredAllow.push("write");
		source.edges[0].to = "missing";
		registry.web.annotations.push("test:other");
		registry.web.build = () =>
			Effect.sync(() => {
				throw new Error("replaced callback");
			});
		await expect(
			Effect.runPromise(
				program.pipe(
					Effect.provideService(StackContext, {
						name: "Snapshot",
						stage: "test",
						resources: {},
						bindings: {},
						actions: {},
					}),
				),
			),
		).rejects.toThrow("observed snapshot");
		expect(seen).toMatchObject({
			name: "snapshot",
			requirements: { labels: { team: "before" } },
			declaration: {
				annotations: [{ config: { setting: { value: "before" } } }],
			},
			dependency: { declaredAllow: ["read"] },
		});
	});

	it("rejects cyclic, accessor-bearing and oversized requirement data before callbacks run", () => {
		let assessed = false;
		interface CyclicFixture {
			self?: object;
		}
		const cyclic: CyclicFixture = {};
		cyclic.self = cyclic;
		const inputs = [
			cyclic,
			{
				get label() {
					throw new Error("accessor ran");
				},
			},
			{ label: "x".repeat(65_537) },
		];
		for (const requirements of inputs) {
			expect(() =>
				mapBindleToAlchemy({ ...declaration, requirements }, mappers([]), {
					assessRequirements: () => {
						assessed = true;
						return { status: "supported" };
					},
				}),
			).toThrow("BINDLE_INVALID");
		}
		expect(assessed).toBe(false);
	});

	it("classifies malformed structural identities and edges without leaking TypeError", () => {
		const invalidBindles = [
			{ ...declaration, name: null },
			{ ...declaration, resources: null },
			{ ...declaration, resources: { broken: null } },
			{
				...declaration,
				resources: { broken: { ...declaration.resources.store, kind: null } },
			},
			{
				...declaration,
				resources: {
					store: { ...declaration.resources.store, declaredAllow: [null] },
				},
			},
			{
				...declaration,
				resources: {
					store: { ...declaration.resources.store, annotations: [null] },
				},
			},
			{
				...declaration,
				resources: {
					store: {
						...declaration.resources.store,
						annotations: [{ provider: null, option: "feature", config: {} }],
					},
				},
			},
			{ ...declaration, connectors: [] },
			{ ...declaration, entrypoint: null },
		];
		for (const input of invalidBindles) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed inputs exercise the runtime boundary.
			expect(() =>
				mapBindleToAlchemy(input as never, mappers([]), supportedRequirements),
			).toThrow("BINDLE_INVALID");
		}
		for (const edge of [
			null,
			{ from: null, to: "store" },
			{ from: "web", to: null },
		]) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed edges exercise the runtime boundary.
			expect(() =>
				mapBindleToAlchemy(
					{ ...declaration, edges: [edge] } as never,
					mappers([]),
					supportedRequirements,
				),
			).toThrow("BINDLE_INVALID");
		}
		for (const catalog of [
			null,
			[null],
			[{ factory: null, allowVerbs: [] }],
			[{ factory: "bucket", allowVerbs: null }],
			[{ factory: "bucket", allowVerbs: ["read", "read"] }],
		]) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed catalogs exercise the runtime boundary.
			expect(() =>
				describeAlchemyPrimitiveSupport(catalog as never, mappers([])),
			).toThrow("BINDLE_INVALID");
		}
	});
	it("validates dependency declarations before any Alchemy resource is built", () => {
		const observed: string[] = [];
		const registry = mappers(observed);
		expect(() =>
			mapBindleToAlchemy(
				declaration,
				{
					...registry,
					web: {
						...registry.web,
						validate: ({ dependencyDeclarations }) => {
							expect(Object.keys(dependencyDeclarations).sort()).toEqual([
								"queue",
								"store",
							]);
							expect(dependencyDeclarations.store?.declaredAllow).toEqual([
								"read",
								"write",
							]);
							throw new Error("unhandled annotation");
						},
					},
				},
				supportedRequirements,
			),
		).toThrow("unhandled annotation");
		expect(observed).toEqual([]);
	});

	it("rejects connector declarations until their authorization and runtime bindings can be mapped", () => {
		const observed: string[] = [];
		const input = {
			...declaration,
			connectors: { payments: { kind: "connector" as const } },
		};
		expect(() =>
			mapBindleToAlchemy(input, mappers(observed), supportedRequirements),
		).toThrow("BINDLE_CONNECTORS_UNSUPPORTED");
		expect(observed).toEqual([]);
	});

	it("requires a provider decision on bindle-wide requirements before construction", () => {
		const observed: string[] = [];
		expect(() =>
			mapBindleToAlchemy(declaration, mappers(observed), {
				assessRequirements: () => ({
					status: "unsupported",
					reason: "runtime unavailable",
				}),
			}),
		).toThrow("BINDLE_REQUIREMENTS_UNSUPPORTED");
		expect(() =>
			mapBindleToAlchemy(declaration, mappers(observed), {
				assessRequirements: () => {
					throw new Error("unavailable");
				},
			}),
		).toThrow("REQUIREMENTS_ASSESSMENT_FAILED");
		for (const decision of [
			undefined,
			{},
			{ status: "unknown" },
			{ status: "unsupported", reason: "" },
			{
				get status() {
					return "supported";
				},
			},
			{
				status: "unsupported",
				get reason() {
					return "runtime unavailable";
				},
			},
		]) {
			expect(() =>
				mapBindleToAlchemy(declaration, mappers(observed), {
					// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these malformed decisions exercise the runtime boundary.
					assessRequirements: () => decision as never,
				}),
			).toThrow("REQUIREMENTS_ASSESSMENT_FAILED");
		}
		expect(observed).toEqual([]);
	});
	it("constructs Alchemy resources in dependency order and passes application logic to the mapper", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-alchemy-bindle-"));
		const priorHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		const observed: string[] = [];
		try {
			const program = mapBindleToAlchemy(
				declaration,
				mappers(observed),
				supportedRequirements,
			);
			const providers = Layer.mergeAll(
				Provider.succeed(Store, {
					reconcile: () => Effect.succeed({ id: "store" }),
					delete: () => Effect.void,
				}),
				Provider.succeed(Queue, {
					reconcile: () => Effect.succeed({ id: "queue" }),
					delete: () => Effect.void,
				}),
				Provider.succeed(Web, {
					reconcile: () => Effect.succeed({ id: "web" }),
					delete: () => Effect.void,
				}),
			);
			const stack = Stack(
				"App",
				{ providers, state: inMemoryState() },
				program.pipe(Effect.map(() => ({}))),
			);
			const provider = createAlchemyIacProvider({
				stack,
				stateOwnership: testStateOwnership,
				composite: {
					proofRef: "test:no-source",
					environmentDigest: `sha256:${"e".repeat(64)}`,
					sourceRequirements: [],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) => sourceClaims.length === 0,
				},
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: join(directory, "runtime"),
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: `sha256:${"a".repeat(64)}`,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "store",
							resourceType: "Spec.Store",
							providerId: "test",
							providerAccountRef: "account",
							productId: "store",
						},
						{
							resourceId: "queue",
							resourceType: "Spec.Queue",
							providerId: "test",
							providerAccountRef: "account",
							productId: "queue",
						},
						{
							resourceId: "web",
							resourceType: "Spec.Web",
							providerId: "test",
							providerAccountRef: "account",
							productId: "web",
						},
					],
				}),
				financial: {
					assess: (inventory) => ({ inventory }),
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => false,
					uncertain: () => {},
				},
			});
			const diff = await provider.preview({
				programId: "p",
				deploymentId: "d",
				resourceId: "app",
				provider: "test",
				driver: "external",
				action: "apply",
				stackName: "App",
			});
			expect(diff.changes).toBe(3);
			expect(observed).toEqual(["queue", "store", "web"]);
		} finally {
			if (priorHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = priorHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reports missing and partial primitive coverage", () => {
		const support = describeAlchemyPrimitiveSupport(
			[
				{ factory: "bucket", allowVerbs: ["read", "write", "delete"] },
				{ factory: "web", allowVerbs: [] },
				{ factory: "topic", allowVerbs: ["publish", "subscribe"] },
			],
			mappers([]),
		);
		expect(support).toMatchObject([
			{ kind: "bucket", status: "partial", unsupportedOperations: ["delete"] },
			{ kind: "web", status: "supported", bindsEntrypoint: true },
			{ kind: "topic", status: "unsupported" },
		]);
	});

	it("identifies the rejected operation or annotation and the provider limitation", () => {
		const registry = mappers([]);
		const input = {
			...declaration,
			resources: {
				...declaration.resources,
				store: { ...declaration.resources.store, declaredAllow: ["delete"] },
			},
		};
		const limited = {
			...registry,
			bucket: {
				...registry.bucket,
				limitations: ["blob events are unavailable"],
			},
		};
		expect(() =>
			mapBindleToAlchemy(input, limited, supportedRequirements),
		).toThrow("operation delete: blob events are unavailable");
		const withAnnotation = {
			...input,
			resources: {
				...input.resources,
				store: {
					...declaration.resources.store,
					annotations: [{ provider: "custom", option: "feature", config: {} }],
				},
			},
		};
		expect(() =>
			mapBindleToAlchemy(withAnnotation, limited, supportedRequirements),
		).toThrow("annotation custom:feature: blob events are unavailable");
	});

	it("reports partial coverage even when all operations are present but runtime behavior is limited", () => {
		const registry = mappers([]);
		const support = describeAlchemyPrimitiveSupport(
			[{ factory: "web", allowVerbs: [] }],
			{
				...registry,
				web: {
					...registry.web,
					limitations: ["session replay is unavailable"],
				},
			},
		);
		expect(support).toMatchObject([
			{ status: "partial", limitations: ["session replay is unavailable"] },
		]);
	});

	it("does not treat inherited object properties as provider mappings", () => {
		const catalog = [{ factory: "toString", allowVerbs: [] }];
		expect(describeAlchemyPrimitiveSupport(catalog, {})).toMatchObject([
			{ status: "unsupported" },
		]);
		const input = {
			name: "unmapped",
			resources: {
				x: {
					kind: "toString",
					name: "x",
					stableId: "toString:x",
					declaredAllow: [],
					dependsOn: [],
					annotations: [],
				},
			},
			edges: [],
			requirements: {},
			entrypoint: () => undefined,
		};
		expect(() => mapBindleToAlchemy(input, {}, supportedRequirements)).toThrow(
			"PRIMITIVE_UNSUPPORTED",
		);
	});

	it.each([
		"entrypoint",
		"resource-type",
		"duplicate",
		"dependencies",
	])("rejects an incomplete mapper result: %s", async (failure) => {
		const resource = {
			Type: failure === "resource-type" ? "Wrong.Type" : "Spec.Web",
			FQN: "web",
		};
		const mapped = {
			primary: resource,
			resources: failure === "duplicate" ? [resource, resource] : [resource],
			boundDependencies: failure === "dependencies" ? ["missing"] : [],
			boundEntrypoint: failure === "entrypoint" ? undefined : entrypoint,
		};
		const one = {
			...declaration,
			resources: { web: { ...declaration.resources.web, dependsOn: [] } },
			edges: [],
		};
		const registry = {
			web: {
				resourceTypes: ["Spec.Web"],
				operations: [],
				annotations: [],
				bindsEntrypoint: true,
				build: () => Effect.succeed(mapped),
			},
		};
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally malformed mapper results exercise the runtime contract.
		const program = mapBindleToAlchemy(
			one,
			registry as never,
			supportedRequirements,
		);
		await expect(
			Effect.runPromise(
				program.pipe(
					Effect.provideService(StackContext, {
						name: "Invalid",
						stage: "test",
						resources: {},
						bindings: {},
						actions: {},
					}),
				),
			),
		).rejects.toThrow("MAPPING_INCOMPLETE");
	});

	it("rejects an unmapped kind, unsupported permission, handler, annotation, dangling edge, or cycle before construction", () => {
		const observed: string[] = [];
		const registry = mappers(observed);
		const cases = [
			{
				...declaration,
				resources: {
					...declaration.resources,
					queue: {
						...declaration.resources.queue,
						kind: "topic",
						stableId: "topic:queue",
					},
				},
			},
			{
				...declaration,
				resources: {
					...declaration.resources,
					store: { ...declaration.resources.store, declaredAllow: ["delete"] },
				},
			},
			{
				...declaration,
				resources: {
					...declaration.resources,
					store: {
						...declaration.resources.store,
						annotations: [
							{ provider: "custom", option: "feature", config: {} },
						],
					},
				},
			},
			{
				...declaration,
				edges: [...declaration.edges, { from: "web", to: "missing" }],
			},
			{
				...declaration,
				edges: [...declaration.edges, { from: "store", to: "web" }],
			},
		];
		for (const input of cases)
			expect(() =>
				mapBindleToAlchemy(input, registry, supportedRequirements),
			).toThrow();
		expect(() =>
			mapBindleToAlchemy(
				declaration,
				{
					...registry,
					web: { ...registry.web, bindsEntrypoint: false },
				},
				supportedRequirements,
			),
		).toThrow();
		expect(observed).toEqual([]);
	});

	it("accepts exactly the acyclic graphs across all three-resource directed graphs", () => {
		const names = ["a", "b", "c"];
		const possible = names.flatMap((from) =>
			names.filter((to) => to !== from).map((to) => ({ from, to })),
		);
		for (let mask = 0; mask < 1 << possible.length; mask++) {
			const edges = possible.filter(
				(_edge, index) => (mask & (1 << index)) !== 0,
			);
			const resources = Object.fromEntries(
				names.map((name) => [
					name,
					{
						kind: "bucket",
						name,
						stableId: `bucket:${name}`,
						declaredAllow: [],
						annotations: [],
						dependsOn: edges
							.filter((edge) => edge.from === name)
							.map(() => "bucket"),
					},
				]),
			);
			const reaches = names.map((from) =>
				names.map((to) =>
					edges.some((edge) => edge.from === from && edge.to === to),
				),
			);
			for (let via = 0; via < names.length; via++)
				for (let from = 0; from < names.length; from++)
					for (let to = 0; to < names.length; to++)
						if (reaches[from]?.[via] && reaches[via]?.[to]) {
							const row = reaches[from];
							if (row !== undefined) row[to] = true;
						}
			const cyclic = names.some(
				(_name, index) => reaches[index]?.[index] === true,
			);
			const input = {
				name: "graph",
				resources,
				edges,
				requirements: {},
				entrypoint: () => undefined,
			};
			if (cyclic)
				expect(() =>
					mapBindleToAlchemy(input, mappers([]), supportedRequirements),
				).toThrow("BINDLE_GRAPH_UNSUPPORTED");
			else
				expect(() =>
					mapBindleToAlchemy(input, mappers([]), supportedRequirements),
				).not.toThrow();
		}
	});
});
