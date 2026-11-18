import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	buildDeploymentRequestFromParts,
	contentHashOf,
	createYardInventory,
	decodeBindleDeploymentRequest,
	encodeBindleDeploymentRequest,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	matchYard,
	parseBindleDeploymentRequest,
	parseYardLayout,
} from "../src/index.js";
import {
	cloneAsJson,
	isJsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const base = buildDeploymentRequestFromParts({
	bindleName: "shop",
	yardId: "yard:main",
	providerId: LOCAL_HOST_PROVIDER_ID,
	resources: [],
});

function matchProperty(requested: JsonValue, offered: JsonValue) {
	const yard = localYardInstance({
		yardId: "yard:main",
		ownerTenantId: "local",
		providerId: LOCAL_HOST_PROVIDER_ID,
	});
	const inventory = createYardInventory("broker:test");
	inventory.apply({
		type: "yard.Registered",
		yard: {
			...yard,
			layout: { ...yard.layout, properties: { config: offered } },
		},
	});
	return matchYard(
		{
			...base.yard,
			requestedLayout: {
				...base.yard.requestedLayout,
				properties: { config: requested },
			},
		},
		inventory.snapshot(),
		{ ownerTenantId: "local" },
	);
}

describe("Yard JSON placement properties", () => {
	it("matches equivalent nested JSON values regardless of object key order", () => {
		const requested = parseJsonObject(
			'{"z":[1,{"a":true}],"a":{"mode":"safe"}}',
		);
		const offered = parseJsonObject('{"a":{"mode":"safe"},"z":[1,{"a":true}]}');
		const decision = matchProperty(requested, offered);
		expect(decision.outcome).toBe("existing-yard");
		expect(decision.candidates[0]?.specificity.exactProperties).toBe(1);
	});

	it("still refuses different nested JSON values and array order", () => {
		for (const offered of [
			{ nested: [2, 1] },
			{ nested: [1, 3] },
			{ nested: [1, 2], extra: true },
		]) {
			const decision = matchProperty({ nested: [1, 2] }, offered);
			expect(decision.outcome).toBe("rejected");
			expect(decision.candidates[0]?.hardFailures).toContain(
				"property-mismatch:config",
			);
		}
	});

	it("recognizes separately decoded JSON values as equal", () => {
		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 2 }), (value) => {
				const decision = matchProperty(cloneAsJson(value), cloneAsJson(value));
				expect(decision.outcome).toBe("existing-yard");
				expect(decision.candidates[0]?.specificity.exactProperties).toBe(1);
			}),
			{ seed: 614_580, numRuns: 100 },
		);
	});

	it("retains special own keys without changing prototypes", () => {
		const labels = parseJsonObject(
			'{"__proto__":"prod","constructor":"service"}',
		);
		const properties = parseJsonObject(
			'{"__proto__":{"isolation":"private"},"nested":{"__proto__":["eu"]}}',
		);
		const parsed = parseBindleDeploymentRequest(
			cloneAsJson({
				...base,
				bindleRequirements: { ...base.bindleRequirements, labels },
				yard: {
					...base.yard,
					requestedLayout: { ...base.yard.requestedLayout, labels, properties },
				},
				camp: { selectionMode: "compatible", layout: { labels } },
			}),
		);
		for (const map of [
			parsed.bindleRequirements.labels,
			parsed.yard.requestedLayout.labels,
			parsed.camp?.layout.labels,
			parsed.yard.requestedLayout.properties,
		]) {
			if (!map) throw new Error("labels missing");
			expect(Object.hasOwn(map, "__proto__")).toBe(true);
			expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
		}
		const nested = parsed.yard.requestedLayout.properties.nested;
		if (!isJsonObject(nested)) throw new Error("nested object missing");
		expect(Object.hasOwn(nested, "__proto__")).toBe(true);
		expect(contentHashOf(parsed.yard.requestedLayout.properties)).toBe(
			contentHashOf(properties),
		);
	});

	it("keeps nested array constraints immutable after parsing", () => {
		const layout = parseYardLayout({
			properties: { config: { rules: [{ names: ["alice"] }] } },
		});
		const config = layout.properties.config;
		if (
			!isJsonObject(config) ||
			!Array.isArray(config.rules) ||
			!isJsonObject(config.rules[0]) ||
			!Array.isArray(config.rules[0].names)
		)
			throw new Error("unexpected parsed JSON");
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.rules)).toBe(true);
		expect(Object.isFrozen(config.rules[0])).toBe(true);
		expect(Object.isFrozen(config.rules[0].names)).toBe(true);
		const rules = config.rules;
		expect(() => rules.push(null)).toThrow();
	});

	it("treats inherited property names as absent when a Yard does not declare them", () => {
		const yard = localYardInstance({
			yardId: "yard:main",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const inventory = createYardInventory("broker:test");
		inventory.apply({ type: "yard.Registered", yard });
		const properties = parseJsonObject(
			'{"__proto__":{"tier":"gold"},"constructor":"host"}',
		);
		const decision = matchYard(
			{
				...base.yard,
				requestedLayout: { ...base.yard.requestedLayout, properties },
			},
			inventory.snapshot(),
			{ ownerTenantId: "local" },
		);
		expect(decision.outcome).toBe("existing-yard");
		expect(decision.candidates[0]?.specificity.exactProperties).toBe(0);
	});

	it("round-trips special keys without changing work", () => {
		const labels = parseJsonObject('{"__proto__":"prod"}');
		const properties = parseJsonObject(
			'{"__proto__":{"nested":{"__proto__":["eu"]}}}',
		);
		const request = parseBindleDeploymentRequest(
			cloneAsJson({
				...base,
				bindleRequirements: { ...base.bindleRequirements, labels },
				yard: {
					...base.yard,
					requestedLayout: {
						...base.yard.requestedLayout,
						labels,
						properties,
						camps: [{ id: "camp", labels }],
					},
				},
				camp: { selectionMode: "compatible", layout: { labels } },
			}),
		);
		expect(Object.hasOwn(request.bindleRequirements.labels, "__proto__")).toBe(
			true,
		);
		const decoded = decodeBindleDeploymentRequest(
			encodeBindleDeploymentRequest(request),
		);
		expect(decoded).toEqual(request);
		expect(contentHashOf(decoded)).toBe(contentHashOf(request));
	});

	it("round-trips generated label maps with inherited-name keys", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.constantFrom("__proto__", "constructor", "toString", "", "team"),
						fc.constantFrom("", "prod", "east"),
					),
					{ maxLength: 8 },
				),
				(entries) => {
					const labels = Object.fromEntries(entries);
					const request = parseBindleDeploymentRequest(
						cloneAsJson({
							...base,
							bindleRequirements: { ...base.bindleRequirements, labels },
							yard: {
								...base.yard,
								requestedLayout: {
									...base.yard.requestedLayout,
									labels,
									camps: [{ labels }],
								},
							},
							camp: { selectionMode: "compatible", layout: { labels } },
						}),
					);
					expect(
						decodeBindleDeploymentRequest(
							encodeBindleDeploymentRequest(request),
						),
					).toEqual(request);
				},
			),
			{ seed: 614_581, numRuns: 100 },
		);
	});
});
