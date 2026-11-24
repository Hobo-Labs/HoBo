import { Resource } from "alchemy";
import { Action } from "alchemy/Action";
import * as Provider from "alchemy/Provider";
import type { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	type AlchemyPrimitiveMapper,
	mapBindleToAlchemy,
} from "../src/bindle.js";

type SharedResource = Resource<"Spec.Shared", object, { id: string }>;
const SharedResource = Resource<SharedResource>("Spec.Shared");
const Build = Action("Spec.Build", () => Effect.succeed({ ok: true }));
const entrypoint = () => "web";
const declaration = {
	name: "app",
	resources: {
		events: {
			kind: "topic",
			name: "events",
			stableId: "topic:events",
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		},
		web: {
			kind: "web",
			name: "web",
			stableId: "web:web",
			declaredAllow: [],
			dependsOn: ["topic"],
			annotations: [],
		},
	},
	edges: [{ from: "web", to: "events" }],
	requirements: {},
	entrypoint: (name: string) => (name === "web" ? entrypoint : undefined),
};
type Mapper = AlchemyPrimitiveMapper<
	typeof entrypoint,
	object,
	Stack | Provider.Provider<SharedResource>
>;
type BuildInput = Parameters<Mapper["build"]>[0];
interface MapperPair {
	readonly topic: Mapper;
	readonly web: Mapper;
}
const requirements = {
	assessRequirements: () => ({ status: "supported" as const }),
};
const metadata = {
	resourceTypes: ["Spec.Shared"],
	operations: [],
	annotations: [],
	bindsEntrypoint: false,
};
function dependency(input: BuildInput) {
	const primary = input.dependencies.events;
	if (!primary) throw new Error("missing test dependency");
	return primary;
}
function mappers(webBuild: Mapper["build"]): MapperPair {
	return {
		topic: {
			...metadata,
			build: () =>
				Effect.gen(function* () {
					const primary = yield* SharedResource("physical", {});
					return { primary, resources: [primary], boundDependencies: [] };
				}),
		},
		web: { ...metadata, bindsEntrypoint: true, build: webBuild },
	};
}
function executeMapping(mapping: MapperPair) {
	return Effect.runPromise(
		mapBindleToAlchemy(
			declaration,
			{ topic: mapping.topic, web: mapping.web },
			requirements,
		).pipe(
			Effect.provideService(StackContext, {
				name: "App",
				stage: "test",
				resources: {},
				bindings: {},
				actions: {},
			}),
			Effect.provide(
				Provider.succeed(SharedResource, {
					reconcile: () => Effect.succeed({ id: "physical" }),
					delete: () => Effect.void,
				}),
			),
		),
	);
}
function execute(webBuild: Mapper["build"]) {
	return executeMapping(mappers(webBuild));
}
function boundEntrypoint(input: BuildInput) {
	if (input.entrypoint === undefined)
		throw new Error("missing test entrypoint");
	return input.entrypoint;
}
const shared: Mapper["build"] = (input) =>
	Effect.succeed({
		primary: dependency(input),
		resources: [],
		sharedDependency: "events",
		boundDependencies: ["events"],
		boundEntrypoint: boundEntrypoint(input),
	});

describe("Alchemy resources shared by declared dependencies", () => {
	it("accounts once for the exact resource and binds the entrypoint", async () => {
		const result = await execute(shared);
		expect(result.resources).toHaveLength(1);
		expect(result.primary.events).toBe(result.primary.web);
		expect(result.primary.web).toBe(result.resources[0]);
	});

	it("rejects an undeclared or incorrectly returned shared dependency", async () => {
		await expect(
			execute((input) =>
				Effect.succeed({
					primary: dependency(input),
					resources: [],
					sharedDependency: "other",
					boundDependencies: ["events"],
					boundEntrypoint: boundEntrypoint(input),
				}),
			),
		).rejects.toThrow("MAPPING_INCOMPLETE");
		await expect(
			execute((input) =>
				Effect.gen(function* () {
					const other = yield* SharedResource("other", {});
					return {
						primary: other,
						resources: [],
						sharedDependency: "events",
						boundDependencies: ["events"],
						boundEntrypoint: boundEntrypoint(input),
					};
				}),
			),
		).rejects.toThrow("MAPPING_INCOMPLETE");
	});

	it("rejects shared mappers that register an extra resource or action", async () => {
		for (const register of [
			() => SharedResource("hidden", {}),
			() => Build("hidden", {}),
		]) {
			await expect(
				execute((input) =>
					Effect.gen(function* () {
						yield* register();
						return yield* shared(input);
					}),
				),
			).rejects.toThrow("MAPPING_INCOMPLETE");
		}
	});

	it("rejects shared mappers that delete an already registered resource", async () => {
		await expect(
			execute((input) =>
				Effect.gen(function* () {
					const stack = yield* StackContext;
					Reflect.deleteProperty(stack.resources, "physical");
					return yield* shared(input);
				}),
			),
		).rejects.toThrow("MAPPING_INCOMPLETE");
	});

	it("rejects a shared mapper that introduces an Alchemy binding", async () => {
		await expect(
			execute((input) =>
				Effect.gen(function* () {
					const stack = yield* StackContext;
					Reflect.set(stack.bindings, "physical", []);
					return yield* shared(input);
				}),
			),
		).rejects.toThrow("MAPPING_INCOMPLETE");
	});

	it("rejects an owned mapper that omits a resource it registered", async () => {
		const original = mappers(shared);
		const mapping: MapperPair = {
			...original,
			topic: {
				...original.topic,
				build: () =>
					Effect.gen(function* () {
						const primary = yield* SharedResource("physical", {});
						yield* SharedResource("hidden", {});
						return { primary, resources: [primary], boundDependencies: [] };
					}),
			},
		};
		await expect(executeMapping(mapping)).rejects.toThrow("MAPPING_INCOMPLETE");
	});

	it("rejects an owned mapper that removes the resource it returns", async () => {
		const original = mappers(shared);
		const mapping: MapperPair = {
			...original,
			topic: {
				...original.topic,
				build: () =>
					Effect.gen(function* () {
						const primary = yield* SharedResource("physical", {});
						const stack = yield* StackContext;
						Reflect.deleteProperty(stack.resources, "physical");
						return { primary, resources: [primary], boundDependencies: [] };
					}),
			},
		};
		await expect(executeMapping(mapping)).rejects.toThrow("MAPPING_INCOMPLETE");
	});
});
