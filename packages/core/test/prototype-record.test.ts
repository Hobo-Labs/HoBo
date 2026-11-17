import { expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import { slotBinding } from "../src/ports/capability-slot.js";
import { parseRealizationResult } from "../src/ports/realization-result.js";
import { parseResolveRequest } from "../src/ports/resource-resolver.js";

const bag = () =>
	JSON.parse(
		'{"__proto__":{"marker":"retained"},"constructor":{"name":"owned"},"nested":{"__proto__":{"nested":true}}}',
	);
function expectOwnRecord(value: JsonObject) {
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	expect(Object.hasOwn(value, "__proto__")).toBe(true);
	expect(JSON.parse(JSON.stringify(value))).toEqual(bag());
}

it("preserves prototype-named slot properties and nested properties", () => {
	const slot = slotBinding({
		slot: "data",
		profile: "data.postgres/v1",
		productId: "aws.rds-postgres/v1",
		properties: bag(),
	});
	expectOwnRecord(slot.properties);
});

it("preserves prototype-named resolver properties", () => {
	const result = parseResolveRequest({
		ref: { slot: "data", productId: "vercel.postgres", logicalId: "orders-db" },
		desired: bag(),
		credentialRef: "secretref://vault/hobo/prod/vercel",
	});
	expectOwnRecord(result.desired);
});

it("preserves prototype-named realization values, outputs and secret references", () => {
	const parsed = parseRealizationResult({
		schema: "hobo.realization-result/v1",
		resources: [
			{
				name: "db",
				resourceClass: "kv",
				providerId: "provider",
				outputs: bag(),
			},
		],
		values: bag(),
		secrets: JSON.parse('{"__proto__":{"secretRef":"broker://tenant/key"}}'),
	});
	expectOwnRecord(parsed.values);
	expectOwnRecord(parsed.resources[0].outputs);
	expect(Object.getPrototypeOf(parsed.secrets)).toBe(Object.prototype);
	expect(Object.hasOwn(parsed.secrets, "__proto__")).toBe(true);
	expect(parsed.secrets.__proto__.secretRef).toBe("broker://tenant/key");
});
