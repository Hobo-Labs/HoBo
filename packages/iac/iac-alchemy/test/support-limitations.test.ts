import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { describeAlchemyPrimitiveSupport } from "../src/bindle.js";

function fixture() {
	const mapper = {
		resourceTypes: ["Rivet.DurableObject"],
		operations: ["read"],
		annotations: [],
		bindsEntrypoint: true,
		limitations: ["No synchronous WIT bridge.", "Host fencing is required."],
		build: () => Effect.die("support reporting must not build"),
	};
	return {
		catalog: [{ factory: "web", allowVerbs: ["read"] }],
		mapper,
		registry: { web: mapper },
	};
}

describe("Alchemy primitive limitation reporting", () => {
	it("reports declared limitations as partial operational support", () => {
		const f = fixture();
		const report = describeAlchemyPrimitiveSupport(f.catalog, f.registry);
		expect(report[0]).toMatchObject({
			status: "partial",
			limitations: f.mapper.limitations,
			supportedOperations: ["read"],
		});
	});

	it("retains all limitations when array iteration and mapping are replaced", () => {
		const f = fixture();
		const iterator = Array.prototype[Symbol.iterator];
		const map = Array.prototype.map;
		let report: ReturnType<typeof describeAlchemyPrimitiveSupport> | undefined;
		try {
			Reflect.set(Array.prototype, Symbol.iterator, function* () {});
			Reflect.set(Array.prototype, "map", () => []);
			report = describeAlchemyPrimitiveSupport(f.catalog, f.registry);
		} finally {
			Reflect.set(Array.prototype, Symbol.iterator, iterator);
			Reflect.set(Array.prototype, "map", map);
		}
		expect(report?.[0]).toMatchObject({
			status: "partial",
			limitations: f.mapper.limitations,
		});
	});

	it("marks accessor-backed limitation declarations unsupported without invoking getters", () => {
		for (const where of ["field", "entry"] as const) {
			const f = fixture();
			let reads = 0;
			if (where === "field")
				Object.defineProperty(f.mapper, "limitations", {
					enumerable: true,
					get() {
						reads++;
						return [];
					},
				});
			else
				Object.defineProperty(f.mapper.limitations, "0", {
					enumerable: true,
					get() {
						reads++;
						return "hidden";
					},
				});
			const report = describeAlchemyPrimitiveSupport(f.catalog, f.registry);
			expect(report[0]?.status).toBe("unsupported");
			expect(reads).toBe(0);
		}
	});

	it("does not treat inherited limitations as an empty supported declaration", () => {
		const f = fixture();
		let reads = 0;
		Reflect.deleteProperty(f.mapper, "limitations");
		Object.setPrototypeOf(f.mapper, {
			get limitations() {
				reads++;
				return ["Host fencing is required."];
			},
		});
		const report = describeAlchemyPrimitiveSupport(f.catalog, f.registry);
		expect(report[0]?.status).toBe("unsupported");
		expect(reads).toBe(0);
	});

	it("rejects malformed or proxied limitation arrays without invoking proxy traps", () => {
		let traps = 0;
		const proxy = new Proxy(["hidden"], {
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("untrusted limitation array");
			},
		});
		const sparse = ["hidden"];
		Reflect.deleteProperty(sparse, "0");
		const decorated = Object.assign(["hidden"], { extra: true });
		for (const value of [proxy, sparse, decorated, [""]]) {
			const f = fixture();
			Reflect.set(f.mapper, "limitations", value);
			const report = describeAlchemyPrimitiveSupport(f.catalog, f.registry);
			expect(report[0]?.status).toBe("unsupported");
		}
		expect(traps).toBe(0);
	});

	it("treats absent or explicitly undefined limitations as an empty list", () => {
		for (const missing of [true, false]) {
			const f = fixture();
			if (missing) Reflect.deleteProperty(f.mapper, "limitations");
			else Reflect.set(f.mapper, "limitations", undefined);
			const report = describeAlchemyPrimitiveSupport(f.catalog, f.registry);
			expect(report[0]?.status).toBe("supported");
			expect(report[0]?.limitations).toEqual([]);
		}
	});

	it("writes dense limitation output without invoking inherited numeric setters", () => {
		const f = fixture();
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
			report = describeAlchemyPrimitiveSupport(f.catalog, f.registry);
		} finally {
			if (previous) Object.defineProperty(Array.prototype, "0", previous);
			else Reflect.deleteProperty(Array.prototype, "0");
		}
		expect(calls).toBe(0);
		expect(report?.[0]?.limitations).toEqual(f.mapper.limitations);
		expect(
			Object.getOwnPropertyDescriptor(report?.[0]?.limitations, "0")?.value,
		).toBe("No synchronous WIT bridge.");
	});
});
