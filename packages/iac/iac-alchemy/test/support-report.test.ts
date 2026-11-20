import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { describeAlchemyPrimitiveSupport } from "../src/bindle.js";

function mappers(_observed: string[]) {
	return {
		bucket: {
			resourceTypes: ["Spec.Store"],
			operations: ["read", "write"],
			annotations: [],
			bindsEntrypoint: false,
			build: () => Effect.die("support reporting must not build"),
		},
	};
}

describe("Alchemy primitive support reports", () => {
	it("rejects catalog accessors and refuses mapper accessors without invoking them", () => {
		let reads = 0;
		const entry = { factory: "bucket", allowVerbs: ["read"] };
		Object.defineProperty(entry, "factory", {
			enumerable: true,
			get() {
				reads++;
				return "bucket";
			},
		});
		expect(() => describeAlchemyPrimitiveSupport([entry], mappers([]))).toThrow(
			"BINDLE_INVALID",
		);
		const registry = mappers([]);
		Object.defineProperty(registry.bucket, "operations", {
			enumerable: true,
			get() {
				reads++;
				return ["read"];
			},
		});
		const report = describeAlchemyPrimitiveSupport(
			[{ factory: "bucket", allowVerbs: ["read"] }],
			registry,
		);
		expect(report[0]?.status).toBe("unsupported");
		expect(report[0]?.unsupportedOperations).toEqual(["read"]);
		const accessorRegistry = Object.defineProperty({}, "bucket", {
			enumerable: true,
			get() {
				reads++;
				return registry.bucket;
			},
		});
		expect(
			describeAlchemyPrimitiveSupport(
				[{ factory: "bucket", allowVerbs: ["read"] }],
				accessorRegistry,
			)[0]?.status,
		).toBe("unsupported");
		expect(reads).toBe(0);
	});

	it("rejects sparse, decorated and duplicate catalog inputs without reading index accessors", () => {
		let reads = 0;
		const accessorVerbs = ["read"];
		Object.defineProperty(accessorVerbs, "0", {
			enumerable: true,
			get() {
				reads++;
				return "read";
			},
		});
		const inputs = [
			[{ factory: "bucket", allowVerbs: accessorVerbs }],
			[{ factory: "bucket", allowVerbs: ["read", "read"] }],
			[
				{ factory: "bucket", allowVerbs: ["read"] },
				{ factory: "bucket", allowVerbs: [] },
			],
			Object.assign([{ factory: "bucket", allowVerbs: [] }], { extra: true }),
		];
		for (const catalog of inputs)
			expect(() =>
				describeAlchemyPrimitiveSupport(catalog, mappers([])),
			).toThrow("BINDLE_INVALID");
		expect(reads).toBe(0);
	});

	it("accepts plain or null-prototype records and rejects inherited mapper declarations", () => {
		const original = mappers([]).bucket;
		const inherited = Object.assign(Object.create({ hidden: true }), original);
		const catalog = [{ factory: "bucket", allowVerbs: ["read"] }];
		expect(
			describeAlchemyPrimitiveSupport(catalog, { bucket: inherited })[0]
				?.status,
		).toBe("unsupported");
		const entry = Object.assign(Object.create({ hidden: true }), catalog[0]);
		expect(() => describeAlchemyPrimitiveSupport([entry], mappers([]))).toThrow(
			"BINDLE_INVALID",
		);
		const registry = Object.assign(
			Object.create({ hidden: true }),
			mappers([]),
		);
		expect(() => describeAlchemyPrimitiveSupport(catalog, registry)).toThrow(
			"BINDLE_INVALID",
		);
		const safeEntry = Object.assign(Object.create(null), catalog[0]);
		const safeMapper = Object.assign(Object.create(null), original);
		const safeRegistry = Object.assign(Object.create(null), {
			bucket: safeMapper,
		});
		expect(
			describeAlchemyPrimitiveSupport([safeEntry], safeRegistry)[0]?.status,
		).toBe("supported");
	});

	it("does not invoke mapper-registry or catalog proxy traps", () => {
		let traps = 0;
		const registry = new Proxy(mappers([]), {
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("registry trap");
			},
		});
		const catalog = new Proxy([{ factory: "bucket", allowVerbs: ["read"] }], {
			get() {
				traps++;
				throw new Error("catalog trap");
			},
		});
		expect(() =>
			describeAlchemyPrimitiveSupport(catalog, mappers([])),
		).toThrow();
		expect(() =>
			describeAlchemyPrimitiveSupport(
				[{ factory: "bucket", allowVerbs: ["read"] }],
				registry,
			),
		).toThrow();
		expect(traps).toBe(0);
	});

	it("retains unsupported operations and resource types when array methods change", () => {
		const catalog = [{ factory: "bucket", allowVerbs: ["read", "delete"] }];
		const registry = mappers([]);
		const some = Array.prototype.some;
		const map = Array.prototype.map;
		const every = Array.prototype.every;
		const filter = Array.prototype.filter;
		const includes = Array.prototype.includes;
		const iterator = Array.prototype[Symbol.iterator];
		let report: ReturnType<typeof describeAlchemyPrimitiveSupport> | undefined;
		try {
			Reflect.set(Array.prototype, "some", () => false);
			Reflect.set(Array.prototype, "map", () => []);
			Reflect.set(Array.prototype, "every", () => true);
			Reflect.set(Array.prototype, "filter", () => []);
			Reflect.set(Array.prototype, "includes", () => true);
			Reflect.set(Array.prototype, Symbol.iterator, function* () {});
			report = describeAlchemyPrimitiveSupport(catalog, registry);
		} finally {
			Reflect.set(Array.prototype, "some", some);
			Reflect.set(Array.prototype, "map", map);
			Reflect.set(Array.prototype, "every", every);
			Reflect.set(Array.prototype, "filter", filter);
			Reflect.set(Array.prototype, "includes", includes);
			Reflect.set(Array.prototype, Symbol.iterator, iterator);
		}
		expect(report).toMatchObject([
			{
				kind: "bucket",
				status: "partial",
				resourceTypes: ["Spec.Store"],
				supportedOperations: ["read"],
				unsupportedOperations: ["delete"],
			},
		]);
	});

	/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: the regression substitutes collection methods and delegates unrelated inputs to the saved native methods. */
	it("does not let substituted filters or membership checks hide an unsupported operation", () => {
		const catalog = [{ factory: "bucket", allowVerbs: ["read", "delete"] }];
		const registry = mappers([]);
		const filter = Array.prototype.filter;
		const includes = Array.prototype.includes;
		let report: ReturnType<typeof describeAlchemyPrimitiveSupport> | undefined;
		try {
			Reflect.set(
				Array.prototype,
				"filter",
				function (this: unknown[], predicate: unknown) {
					if (this === catalog[0]?.allowVerbs) return [];
					return Reflect.apply(filter, this, [predicate]);
				},
			);
			Reflect.set(
				Array.prototype,
				"includes",
				function (this: unknown[], value: unknown) {
					if (this === registry.bucket.operations) return true;
					return Reflect.apply(includes, this, [value]);
				},
			);
			report = describeAlchemyPrimitiveSupport(catalog, registry);
		} finally {
			Reflect.set(Array.prototype, "filter", filter);
			Reflect.set(Array.prototype, "includes", includes);
		}
		expect(report?.[0]).toMatchObject({
			status: "partial",
			supportedOperations: ["read"],
			unsupportedOperations: ["delete"],
		});
	});

	/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */
	it("rejects duplicate catalog kinds when Set methods are substituted", () => {
		const catalog = [
			{ factory: "bucket", allowVerbs: ["read"] },
			{ factory: "bucket", allowVerbs: ["write"] },
		];
		const has = Set.prototype.has;
		const add = Set.prototype.add;
		let rejected = false;
		try {
			Reflect.set(Set.prototype, "has", () => false);
			Reflect.set(Set.prototype, "add", function (this: Set<unknown>) {
				return this;
			});
			try {
				describeAlchemyPrimitiveSupport(catalog, mappers([]));
			} catch {
				rejected = true;
			}
		} finally {
			Reflect.set(Set.prototype, "has", has);
			Reflect.set(Set.prototype, "add", add);
		}
		expect(rejected).toBe(true);
	});

	it("writes support rows and operations as dense own data despite inherited setters", () => {
		const catalog = [{ factory: "bucket", allowVerbs: ["read", "delete"] }];
		const registry = mappers([]);
		const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
		let calls = 0;
		let report: ReturnType<typeof describeAlchemyPrimitiveSupport> | undefined;
		try {
			Object.defineProperty(Array.prototype, "0", {
				configurable: true,
				set() {
					calls++;
				},
			});
			report = describeAlchemyPrimitiveSupport(catalog, registry);
		} finally {
			if (previous) Object.defineProperty(Array.prototype, "0", previous);
			else Reflect.deleteProperty(Array.prototype, "0");
		}
		expect(calls).toBe(0);
		expect(report).toHaveLength(1);
		expect(Object.getOwnPropertyDescriptor(report, "0")?.value.kind).toBe(
			"bucket",
		);
		expect(
			Object.getOwnPropertyDescriptor(report?.[0]?.unsupportedOperations, "0")
				?.value,
		).toBe("delete");
	});
});
