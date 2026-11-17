import { describe, expect, it } from "vitest";

import {
	assertCapabilityDenialCode,
	CapabilityDeniedError,
	CapabilityParseError,
	parseCapabilityGrant,
	parseCapabilityGrantList,
} from "../src/capability/index.js";

const GRANT = {
	componentId: "checkout",
	importInterface: "hobo:kv/store",
	resource: "orders",
	operations: ["get", "set"],
};

function parseError(thunk: () => void): CapabilityParseError {
	try {
		thunk();
	} catch (error) {
		expect(error).toBeInstanceOf(CapabilityParseError);
		return error as CapabilityParseError;
	}
	return expect.unreachable("expected a CapabilityParseError") as never;
}

describe("parseCapabilityGrant", () => {
	it("parses a well-formed grant", () => {
		const grant = parseCapabilityGrant(GRANT);
		expect(grant.componentId).toBe("checkout");
		expect(grant.importInterface).toBe("hobo:kv/store");
		expect(grant.resource).toBe("orders");
		expect(grant.operations).toEqual(["get", "set"]);
	});

	it("sorts the operations", () => {
		const grant = parseCapabilityGrant({
			...GRANT,
			operations: ["set", "delete", "get"],
		});
		expect(grant.operations).toEqual(["delete", "get", "set"]);
	});

	it("freezes the grant and its operations", () => {
		const grant = parseCapabilityGrant(GRANT);
		expect(Object.isFrozen(grant)).toBe(true);
		expect(Object.isFrozen(grant.operations)).toBe(true);
	});

	it("refuses a non-object", () => {
		for (const input of [null, undefined, 7, "grant", true]) {
			expect(parseError(() => parseCapabilityGrant(input)).expected).toBe(
				"object",
			);
		}
	});

	it("refuses an array", () => {
		expect(parseError(() => parseCapabilityGrant([])).expected).toBe("object");
	});

	it("refuses an unrecognised key, naming it", () => {
		const error = parseError(() =>
			parseCapabilityGrant({ ...GRANT, tenant: "acme" }),
		);
		expect(error.received).toBe("tenant");
		expect(error.expected).toContain("componentId");
		expect(error.expected).toContain("operations");
	});

	it("refuses each missing required field by name", () => {
		for (const key of ["componentId", "importInterface", "resource"] as const) {
			const input = { ...GRANT, [key]: undefined };
			expect(parseError(() => parseCapabilityGrant(input)).path).toBe(key);
		}
	});

	it("refuses an empty string in a required field", () => {
		expect(
			parseError(() => parseCapabilityGrant({ ...GRANT, resource: "" })).path,
		).toBe("resource");
	});

	it("refuses a non-string in a required field", () => {
		expect(
			parseError(() => parseCapabilityGrant({ ...GRANT, componentId: 7 }))
				.received,
		).toBe(7);
	});

	it("refuses an empty operations list", () => {
		expect(
			parseError(() => parseCapabilityGrant({ ...GRANT, operations: [] })).path,
		).toBe("operations");
	});

	it("refuses a missing or non-array operations field", () => {
		expect(
			parseError(() => parseCapabilityGrant({ ...GRANT, operations: "get" }))
				.expected,
		).toBe("non-empty array");
		const input = { ...GRANT, operations: undefined };
		expect(parseError(() => parseCapabilityGrant(input)).expected).toBe(
			"non-empty array",
		);
	});

	it("refuses a duplicated operation", () => {
		const error = parseError(() =>
			parseCapabilityGrant({ ...GRANT, operations: ["get", "get"] }),
		);
		expect(error.expected).toBe("unique strings");
		expect(error.received).toBe("get");
	});

	it("refuses an empty or non-string operation, reporting its index", () => {
		expect(
			parseError(() =>
				parseCapabilityGrant({ ...GRANT, operations: ["get", ""] }),
			).path,
		).toBe("operations[1]");
		expect(
			parseError(() => parseCapabilityGrant({ ...GRANT, operations: [1] }))
				.path,
		).toBe("operations[0]");
	});

	it("carries the parse code on every refusal", () => {
		expect(parseError(() => parseCapabilityGrant(null)).code).toBe(
			"HOBO_CORE_CAPABILITY_PARSE",
		);
		expect(parseError(() => parseCapabilityGrant(null)).name).toBe(
			"CapabilityParseError",
		);
	});
});

describe("parseCapabilityGrantList", () => {
	it("parses a list", () => {
		const grants = parseCapabilityGrantList([
			GRANT,
			{ ...GRANT, resource: "b" },
		]);
		expect(grants).toHaveLength(2);
		expect(Object.isFrozen(grants)).toBe(true);
	});

	it("accepts an empty list", () => {
		expect(parseCapabilityGrantList([])).toEqual([]);
	});

	it("refuses a non-array", () => {
		const error = parseError(() => parseCapabilityGrantList({}));
		expect(error.path).toBe("grants");
		expect(error.expected).toBe("array");
	});

	it("re-paths an element failure to its index", () => {
		const error = parseError(() =>
			parseCapabilityGrantList([GRANT, { ...GRANT, resource: "" }]),
		);
		expect(error.path).toBe("grants[1]");
		expect(error.expected).toBe("non-empty string");
		expect(error.received).toBe("");
	});

	it("lets a non-parse error through untouched", () => {
		const hostile = {
			operations: ["get"],
			importInterface: "hobo:kv/store",
			resource: "orders",
			get componentId(): string {
				throw new RangeError("boom");
			},
		};
		expect(() => parseCapabilityGrantList([hostile])).toThrow(RangeError);
	});
});

describe("assertCapabilityDenialCode", () => {
	const CODES = [
		"capability.import-not-declared",
		"capability.export-not-found",
		"capability.no-inferred-grant",
		"capability.operation-not-granted",
		"capability.no-linked-route",
		"capability.fabricated-handle",
		"capability.operation-not-found",
		"capability.component-not-registered",
		"capability.provider-not-registered",
	];

	it("accepts every declared code", () => {
		for (const code of CODES) {
			expect(assertCapabilityDenialCode(code, "code")).toBe(code);
		}
	});

	it("refuses an undeclared code and lists the alternatives", () => {
		const error = parseError(() =>
			assertCapabilityDenialCode("capability.nope", "code"),
		);
		expect(error.path).toBe("code");
		expect(error.expected).toContain("capability.import-not-declared");
	});

	it("refuses a non-string", () => {
		expect(
			parseError(() => assertCapabilityDenialCode(undefined, "code")).received,
		).toBeUndefined();
	});

	it("reports the caller's field name", () => {
		expect(
			parseError(() => assertCapabilityDenialCode("x", "denial.reasonCode"))
				.path,
		).toBe("denial.reasonCode");
	});
});

describe("CapabilityDeniedError", () => {
	it("builds a message from the component and interface", () => {
		const error = new CapabilityDeniedError(
			"capability.operation-not-granted",
			{
				componentId: "checkout",
				importInterface: "hobo:kv/store",
			},
		);
		expect(error.message).toBe(
			"capability.operation-not-granted: checkout:hobo:kv/store",
		);
		expect(error.code).toBe("capability.operation-not-granted");
		expect(error.name).toBe("CapabilityDeniedError");
	});

	it("says unknown rather than undefined for absent identifiers", () => {
		const error = new CapabilityDeniedError("capability.export-not-found");
		expect(error.message).toBe("capability.export-not-found: unknown:unknown");
	});

	it("leaves the details it was not given undefined", () => {
		const error = new CapabilityDeniedError("capability.no-linked-route", {
			operation: "get",
		});
		expect(error.operation).toBe("get");
		expect(error.resource).toBeUndefined();
		expect(error.providerId).toBeUndefined();
		expect(error.exportInterface).toBeUndefined();
	});

	it("still declares the optional fields as own properties", () => {
		const error = new CapabilityDeniedError("capability.no-linked-route", {
			operation: "get",
		});
		expect(Object.hasOwn(error, "resource")).toBe(true);
		expect(Object.hasOwn(error, "componentId")).toBe(true);
		expect(JSON.stringify({ ...error })).not.toContain("undefined");
	});

	it("carries every detail when given every detail", () => {
		const error = new CapabilityDeniedError("capability.fabricated-handle", {
			componentId: "c",
			importInterface: "i",
			operation: "o",
			resource: "r",
			providerId: "p",
			exportInterface: "e",
		});
		expect(error.resource).toBe("r");
		expect(error.providerId).toBe("p");
		expect(error.exportInterface).toBe("e");
	});

	it("is an Error, so it survives a throw/catch boundary", () => {
		expect(
			new CapabilityDeniedError("capability.import-not-declared"),
		).toBeInstanceOf(Error);
	});
});
