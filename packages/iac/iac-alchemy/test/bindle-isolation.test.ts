import { Resource } from "alchemy";
import { Action } from "alchemy/Action";
import * as Namespace from "alchemy/Namespace";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { mapBindleToAlchemy } from "../src/bindle.js";

type Spec = Resource<"Spec.Resource", { tag: string }, { id: string }>;
const Spec = Resource<Spec>("Spec.Resource");
const stack = () => ({
	name: "App",
	stage: "test",
	resources: {},
	bindings: {},
	actions: {},
});
const definition = (name: string, resource: string) => ({
	name,
	resources: {
		[resource]: {
			kind: "spec",
			name: resource,
			stableId: `spec:${resource}`,
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		},
	},
	edges: [],
	requirements: {},
	entrypoint: () => undefined,
});
function mapper(tag: string) {
	return {
		spec: {
			resourceTypes: ["Spec.Resource"],
			operations: [],
			annotations: [],
			bindsEntrypoint: false,
			build: (input) =>
				Effect.gen(function* () {
					const primary = yield* Spec(input.declaration.name, { tag });
					return { primary, resources: [primary], boundDependencies: [] };
				}),
		},
	};
}
function execute<A, E, R>(effect: Effect.Effect<A, E, R>, target = stack()) {
	// SAFETY: these tests supply the Alchemy stack service needed by their real resource constructors.
	return Effect.runPromise(
		effect.pipe(Effect.provideService(StackContext, target)) as Effect.Effect<
			A,
			E,
			never
		>,
	);
}

describe("Alchemy Bindle identity ownership", () => {
	it.each([
		"sequential",
		"concurrent",
	] as const)("rejects %s mappings that would alias an existing resource", async (mode) => {
		const first = mapBindleToAlchemy(
			definition("first", "cache"),
			mapper("first"),
		);
		const second = mapBindleToAlchemy(
			definition("second", "cache"),
			mapper("second"),
		);
		const program =
			mode === "sequential"
				? Effect.gen(function* () {
						yield* first;
						yield* second;
					})
				: Effect.all([first, second], { concurrency: "unbounded" });
		await expect(execute(program)).rejects.toThrow("BINDLE_IDENTITY_COLLISION");
	});

	it("rejects a raw resource registered before the Bindle", async () => {
		const program = Effect.gen(function* () {
			yield* Spec("cache", { tag: "raw" });
			yield* mapBindleToAlchemy(definition("app", "cache"), mapper("bindle"));
		});
		await expect(execute(program)).rejects.toThrow("BINDLE_IDENTITY_COLLISION");
	});

	it("permits distinct Alchemy namespaces without renaming existing declarations", async () => {
		const one = mapBindleToAlchemy(definition("first", "cache"), mapper("one"));
		const two = mapBindleToAlchemy(
			definition("second", "cache"),
			mapper("two"),
		);
		const result = await execute(
			Effect.all([Namespace.push("one", one), Namespace.push("two", two)]),
		);
		expect(result.map((item) => item.primary.cache?.FQN)).toEqual([
			"one/cache",
			"two/cache",
		]);
	});

	it("rejects reused action identities, including across primitives within one Bindle", async () => {
		const Build = Action("Spec.Build", () => Effect.succeed({ ok: true }));
		const mapping = {
			spec: {
				resourceTypes: ["Spec.Resource"],
				operations: [],
				annotations: [],
				bindsEntrypoint: false,
				build: (input) =>
					Effect.gen(function* () {
						yield* Build("shared-build", {});
						const primary = yield* Spec(input.declaration.name, {
							tag: input.declaration.name,
						});
						return { primary, resources: [primary], boundDependencies: [] };
					}),
			},
		};
		const first = definition("app", "one");
		const second = definition("app", "two");
		const app = {
			...first,
			resources: { ...first.resources, ...second.resources },
		};
		await expect(execute(mapBindleToAlchemy(app, mapping))).rejects.toThrow(
			"BINDLE_IDENTITY_COLLISION",
		);
	});

	it("documents why the host must forbid later raw reuse of a mapped identity", async () => {
		const program = Effect.gen(function* () {
			const mapped = yield* mapBindleToAlchemy(
				definition("app", "cache"),
				mapper("first"),
			);
			const raw = yield* Spec("cache", { tag: "second" });
			return { original: mapped.primary.cache, raw };
		});
		const result = await execute(program);
		expect(result.raw).toBe(result.original);
	});
});
