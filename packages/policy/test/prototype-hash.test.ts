import { expect, it } from "vitest";
import {
	canonicalJson,
	createDecisionRequest,
	POLICY_IR_SCHEMA_VERSION,
} from "../src/policy-ir.js";

it("preserves prototype-named keys without changing object prototypes", () => {
	const context = JSON.parse(
		'{"__proto__":{"injected":true},"constructor":{"name":"valid"},"nested":{"__proto__":{"nested":true}}}',
	);
	const request = createDecisionRequest({
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: { kind: "agent", id: "sre" },
		action: "deploy",
		resource: { kind: "service", id: "api" },
		phase: "apply",
		context,
	});
	expect(Object.getPrototypeOf(request.context)).toBe(Object.prototype);
	expect(Object.hasOwn(request.context, "__proto__")).toBe(true);
	expect(Object.hasOwn(request.context.nested, "__proto__")).toBe(true);
	expect(JSON.parse(canonicalJson(request.context))).toEqual(context);
	const changed = createDecisionRequest({
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: { kind: "agent", id: "sre" },
		action: "deploy",
		resource: { kind: "service", id: "api" },
		phase: "apply",
		context: JSON.parse(
			'{"__proto__":{"injected":false},"constructor":{"name":"valid"},"nested":{"__proto__":{"nested":true}}}',
		),
	});
	expect(request.inputHash).not.toBe(changed.inputHash);
});
