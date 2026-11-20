import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { QuoteScenarioSchema } from "../src/_generated/pricing_pb.js";
import {
	developerPricing,
	pricingUnavailable,
	quoteAvailablePricing,
} from "../src/availability.js";
import {
	isBoundedPricingInput,
	isExactProtoMessage,
	isSupportedPricingRealm,
} from "../src/json.js";
import { quoteScenario, quoteScenarioJson } from "../src/quote.js";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
	targetPricingUnavailable,
} from "../src/target-pricing.js";
import { makeScenario, perUnitCharge, usage, workload } from "./fixtures.js";

describe("pricing input BigInt bounds", () => {
	it("enforces the existing 128-character decimal limit at both signed boundaries", () => {
		const positiveLimit = 10n ** 128n;
		const negativeLimit = 10n ** 127n;
		expect(isBoundedPricingInput(positiveLimit - 1n)).toBe(true);
		expect(isBoundedPricingInput(positiveLimit)).toBe(false);
		expect(isBoundedPricingInput(-(negativeLimit - 1n))).toBe(true);
		expect(isBoundedPricingInput(-negativeLimit)).toBe(false);
	});

	it("checks even huge BigInts without invoking an overridable conversion", () => {
		const descriptor = Object.getOwnPropertyDescriptor(
			BigInt.prototype,
			"toString",
		);
		if (descriptor === undefined)
			throw new Error("missing native BigInt conversion");
		const huge = 1n << 1_000_000n;
		let calls = 0;
		let results: boolean[];
		try {
			Object.defineProperty(BigInt.prototype, "toString", {
				...descriptor,
				value: () => {
					calls++;
					throw new Error("conversion must not run");
				},
			});
			results = [0n, -7n, huge, -huge].map(isBoundedPricingInput);
		} finally {
			Object.defineProperty(BigInt.prototype, "toString", descriptor);
		}
		expect(results).toEqual([true, true, false, false]);
		expect(calls).toBe(0);
	});
});

describe("pricing input descriptor inspection", () => {
	it("rejects custom array prototypes before a quote can invoke their methods", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "0.25")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		let reads = 0;
		const custom = Object.create(Array.prototype, {
			map: {
				get() {
					reads++;
					throw new Error("untrusted array method");
				},
			},
		});
		Object.setPrototypeOf(scenario.baseline, custom);
		expect(isBoundedPricingInput(scenario)).toBe(false);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
		expect(reads).toBe(0);
	});

	it("rejects accessors without reading an inherited descriptor value", () => {
		let inputReads = 0;
		let inheritedReads = 0;
		const object = Object.create(null);
		Object.defineProperty(object, "price", {
			enumerable: true,
			get() {
				inputReads++;
				return 1;
			},
		});
		const array = [1];
		Object.defineProperty(array, "0", {
			enumerable: true,
			get() {
				inputReads++;
				return 1;
			},
		});
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		let results: boolean[];
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					inheritedReads++;
					return 1;
				},
			});
			results = [object, array, { nested: object }, { price: 1 }].map(
				isBoundedPricingInput,
			);
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", previous);
		}
		expect(results).toEqual([false, false, false, false]);
		expect(inputReads).toBe(0);
		expect(inheritedReads).toBe(0);
		expect(isBoundedPricingInput({ price: 1 })).toBe(true);
	});

	it("does not read inherited type metadata while comparing protobuf data", () => {
		const scenario = create(QuoteScenarioSchema);
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"$typeName",
		);
		let inheritedReads = 0;
		let result: boolean;
		try {
			Object.defineProperty(Object.prototype, "$typeName", {
				configurable: true,
				get() {
					inheritedReads++;
					return undefined;
				},
			});
			result = isExactProtoMessage(QuoteScenarioSchema, scenario);
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "$typeName");
			else Object.defineProperty(Object.prototype, "$typeName", previous);
		}
		expect(result).toBe(false);
		expect(inheritedReads).toBe(0);
	});

	it("does not read inherited metadata from pricing descriptor maps", () => {
		const inventory = {
			targetId: "target",
			tenantId: "tenant",
			planDigest: `sha256:${"a".repeat(64)}`,
			complete: true,
			evidenceRef: "evidence",
			resources: [],
		};
		const model = {
			modelId: "model",
			revision: "1",
			planDigest: inventory.planDigest,
			scenario: create(QuoteScenarioSchema),
			bindings: [],
		};
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"$unknown",
		);
		let inheritedReads = 0;
		let refusals = 0;
		try {
			Object.defineProperty(Object.prototype, "$unknown", {
				configurable: true,
				get() {
					inheritedReads++;
					return undefined;
				},
			});
			for (const call of [
				() => createTargetPricingInventory(inventory),
				() => targetPricingModel(model),
			]) {
				try {
					call();
				} catch {
					refusals++;
				}
			}
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "$unknown");
			else Object.defineProperty(Object.prototype, "$unknown", previous);
		}
		expect(refusals).toBe(2);
		expect(inheritedReads).toBe(0);
		expect(isSupportedPricingRealm()).toBe(true);
		expect(createTargetPricingInventory(inventory).targetId).toBe("target");
		expect(targetPricingModel(model).state.case).toBe("model");
	});

	it("refuses inherited optional fields and identifies an unsupported realm", () => {
		const inventory = {
			targetId: "target",
			tenantId: "tenant",
			planDigest: `sha256:${"a".repeat(64)}`,
			complete: true,
			evidenceRef: "evidence",
			resources: [],
		};
		const target = createTargetPricingInventory(inventory);
		const targetAvailability = targetPricingUnavailable("unpriced");
		const providerAvailability = pricingUnavailable("unpriced");
		const scenario = create(QuoteScenarioSchema);
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"operation",
		);
		let inheritedReads = 0;
		let refused = false;
		let supported = true;
		let results: string[] = [];
		try {
			Object.defineProperty(Object.prototype, "operation", {
				configurable: true,
				get() {
					inheritedReads++;
					return "deploy";
				},
			});
			supported = isSupportedPricingRealm();
			try {
				createTargetPricingInventory(inventory);
			} catch {
				refused = true;
			}
			const targetQuote = quoteTargetPricing(target, targetAvailability);
			const providerQuote = quoteAvailablePricing(
				"provider",
				providerAvailability,
			);
			const directQuote = quoteScenario(scenario);
			const jsonQuote = quoteScenarioJson(undefined);
			results = [
				targetQuote.ok ? "ok" : targetQuote.code,
				providerQuote.ok ? "ok" : providerQuote.code,
				directQuote.$typeName === "hobo.pricing.v1.PricingRejected"
					? directQuote.code
					: "ok",
				jsonQuote.$typeName === "hobo.pricing.v1.PricingRejected"
					? jsonQuote.code
					: "ok",
			];
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "operation");
			else Object.defineProperty(Object.prototype, "operation", previous);
		}
		expect(refused).toBe(true);
		expect(supported).toBe(false);
		expect(inheritedReads).toBe(0);
		expect(results).toEqual(Array(4).fill("PRICING_REALM_UNSUPPORTED"));
		expect(createTargetPricingInventory(inventory).operation).toBeUndefined();
	});

	it("rejects changed intrinsic descriptors without invoking their getters", () => {
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"toString",
		);
		if (previous === undefined)
			throw new Error("missing Object prototype method");
		let inheritedReads = 0;
		let supported = true;
		try {
			Object.defineProperty(Object.prototype, "toString", {
				configurable: true,
				get() {
					inheritedReads++;
					return () => "unexpected";
				},
			});
			supported = isSupportedPricingRealm();
		} finally {
			Object.defineProperty(Object.prototype, "toString", previous);
		}
		expect(supported).toBe(false);
		expect(inheritedReads).toBe(0);
		expect(isSupportedPricingRealm()).toBe(true);
	});

	it("cannot hide a polluted prototype by replacing reflection after import", () => {
		const originalNames = Object.getOwnPropertyDescriptor(
			Object,
			"getOwnPropertyNames",
		);
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"operation",
		);
		if (originalNames === undefined)
			throw new Error("missing reflection method");
		let spoofCalls = 0;
		let supported = true;
		try {
			Object.defineProperty(Object.prototype, "operation", {
				configurable: true,
				value: "destroy",
			});
			Object.defineProperty(Object, "getOwnPropertyNames", {
				...originalNames,
				value: (value: Parameters<typeof Object.getOwnPropertyNames>[0]) => {
					spoofCalls++;
					return originalNames
						.value(value)
						.filter((key: string) => key !== "operation");
				},
			});
			supported = isSupportedPricingRealm();
		} finally {
			Object.defineProperty(Object, "getOwnPropertyNames", originalNames);
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "operation");
			else Object.defineProperty(Object.prototype, "operation", previous);
		}
		expect(supported).toBe(false);
		expect(spoofCalls).toBe(0);
		expect(isSupportedPricingRealm()).toBe(true);
	});

	it("rejects a replaced reflection intrinsic without invoking it", () => {
		const original = Object.getOwnPropertyDescriptor(Object, "hasOwn");
		if (original === undefined) throw new Error("missing reflection method");
		let calls = 0;
		let supported = true;
		try {
			Object.defineProperty(Object, "hasOwn", {
				...original,
				value: () => {
					calls++;
					return true;
				},
			});
			supported = isSupportedPricingRealm();
		} finally {
			Object.defineProperty(Object, "hasOwn", original);
		}
		expect(supported).toBe(false);
		expect(calls).toBe(0);
		expect(isSupportedPricingRealm()).toBe(true);
	});

	it("accepts removal of the legacy proto accessor after initialization", () => {
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"__proto__",
		);
		if (previous === undefined) return;
		let supported = false;
		try {
			Reflect.deleteProperty(Object.prototype, "__proto__");
			supported = isSupportedPricingRealm();
		} finally {
			Object.defineProperty(Object.prototype, "__proto__", previous);
		}
		expect(supported).toBe(true);
	});

	it("rejects hostile developer models and detaches legitimate input", () => {
		const scope = {
			modelId: "model",
			revision: "1",
			tenantId: "tenant",
			providerId: "provider",
			providerAccountRef: "account",
			productId: "product",
		};
		const scenario = create(QuoteScenarioSchema, { action: "initial" });
		let reads = 0;
		const hostile = new Proxy(scope, {
			get() {
				reads++;
				throw new Error("untrusted scope getter");
			},
		});
		const accessorScope = { ...scope };
		Object.defineProperty(accessorScope, "modelId", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("untrusted scope accessor");
			},
		});
		expect(() => developerPricing(hostile, scenario)).toThrow();
		expect(() => developerPricing(accessorScope, scenario)).toThrow();
		expect(reads).toBe(0);
		const model = developerPricing(scope, scenario);
		scope.modelId = "changed";
		scenario.action = "changed";
		if (model.state.case !== "developerModel") throw new Error("missing model");
		expect(model.state.value.scope?.modelId).toBe("model");
		expect(model.state.value.scenario?.action).toBe("initial");
	});

	it("rechecks the realm after a host callback changes a dynamic map key", () => {
		const target = createTargetPricingInventory({
			targetId: "target",
			tenantId: "tenant",
			planDigest: `sha256:${"a".repeat(64)}`,
			complete: true,
			evidenceRef: "evidence",
			resources: [
				{
					resourceId: "resource",
					providerId: "provider",
					providerAccountRef: "account",
					productId: "product",
				},
			],
		});
		const availability = targetPricingUnavailable("no model");
		const before = quoteTargetPricing(target, availability);
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "seats");
		let during: ReturnType<typeof quoteTargetPricing>;
		try {
			const hostCallback = () => {
				Object.defineProperty(Object.prototype, "seats", {
					configurable: true,
					value: "100",
				});
			};
			hostCallback();
			during = quoteTargetPricing(target, availability);
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "seats");
			else Object.defineProperty(Object.prototype, "seats", previous);
		}
		const after = quoteTargetPricing(target, availability);
		expect(before).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_UNAVAILABLE",
		});
		expect(during).toMatchObject({
			ok: false,
			code: "PRICING_REALM_UNSUPPORTED",
		});
		expect(after).toEqual(before);
	});

	it.each([
		"--disable-proto=delete",
		"--frozen-intrinsics",
	])("supports the hardened Node realm %s", (flag) => {
		const result = spawnSync(
			process.execPath,
			[
				flag,
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import { isSupportedPricingRealm } from "./src/json.ts";
import { createTargetPricingInventory, targetPricingUnavailable, quoteTargetPricing } from "./src/target-pricing.ts";
const target = createTargetPricingInventory({ targetId: "target", tenantId: "tenant", planDigest: "sha256:" + "a".repeat(64), complete: true, evidenceRef: "evidence", resources: [{ resourceId: "resource", providerId: "provider", providerAccountRef: "account", productId: "product" }] });
const quote = quoteTargetPricing(target, targetPricingUnavailable("no model"));
if (!isSupportedPricingRealm() || quote.ok || quote.code !== "PRICING_MODEL_UNAVAILABLE") process.exitCode = 1;`,
			],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				encoding: "utf8",
				timeout: 15_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	});
});
