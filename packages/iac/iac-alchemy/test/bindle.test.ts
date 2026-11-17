import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
					// SAFETY: these malformed decisions exercise the runtime boundary.
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
		// SAFETY: intentionally malformed mapper results exercise the runtime contract.
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
