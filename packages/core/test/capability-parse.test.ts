/**
 * Capability grant parsing and the capability denial error.
 *
 * A `CapabilityGrant` is the record that says a component may call one
 * interface for one resource with one set of operations. Everything downstream
 * — `evaluateCapabilityGrants`, the link table, the denial events — trusts that
 * this parser refused anything it should not have accepted. A grant that got
 * through with an unrecognised key, a duplicated operation, or an empty
 * resource is an authorization decision made on a record nobody wrote, so the
 * refusals below are the security-relevant half of this file.
 */
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
		// SAFETY: toBeInstanceOf above establishes the caught error's class.
		return error as CapabilityParseError;
	}
	// SAFETY: every reachable path above returns a CapabilityParseError.
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
		// Sorted so two grants that authorize the same thing compare equal and
		// hash the same. Authoring order is not meaning, and letting it leak into
		// the parsed record would make grant deduplication order-dependent.
		const grant = parseCapabilityGrant({
			...GRANT,
			operations: ["set", "delete", "get"],
		});
		expect(grant.operations).toEqual(["delete", "get", "set"]);
	});

	it("freezes the grant and its operations", () => {
		// A grant handed to the evaluator must not be mutable by whoever holds a
		// reference afterwards: widening `operations` in place would be a silent
		// privilege escalation with no parse step to catch it.
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
		// Arrays are objects to `typeof`, so this is the case a naive object check
		// lets through — and `source.componentId` on an array is `undefined`,
		// which would then be reported as the wrong field.
		expect(parseError(() => parseCapabilityGrant([])).expected).toBe("object");
	});

	it("refuses an unrecognised key, naming it", () => {
		// Not ignored. An unknown key means the author believed they were saying
		// something the parser does not implement — `tenant: "acme"` on a grant
		// reads like a scope restriction and would silently be none.
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
		// Empty is not a name. An empty `resource` would match nothing and read in
		// a denial event as though the field were absent.
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
		// `minLength: 1` is passed, so an empty array is a refusal rather than a
		// grant of nothing. A grant that authorizes no operation is almost
		// certainly a truncated record, not an intentional null grant.
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
		// Duplicates are refused rather than deduplicated, because a repeated
		// operation is a sign the record was merged from two sources and the
		// merge may have dropped something else.
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
		// The code is what callers switch on; `name` and `message` are for humans.
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
		// Distinct from an empty `operations`: a component with no grants at all
		// is a legitimate state (it imports nothing), and refusing it would force
		// callers to special-case the empty manifest.
		expect(parseCapabilityGrantList([])).toEqual([]);
	});

	it("refuses a non-array", () => {
		const error = parseError(() => parseCapabilityGrantList({}));
		expect(error.path).toBe("grants");
		expect(error.expected).toBe("array");
	});

	it("re-paths an element failure to its index", () => {
		// Without the re-path the message would say `resource`, and an author
		// staring at a hundred-grant manifest would have no idea which one. The
		// original `expected` and `received` survive the rewrite.
		const error = parseError(() =>
			parseCapabilityGrantList([GRANT, { ...GRANT, resource: "" }]),
		);
		expect(error.path).toBe("grants[1]");
		expect(error.expected).toBe("non-empty string");
		expect(error.received).toBe("");
	});

	it("lets a non-parse error through untouched", () => {
		// The catch narrows on `instanceof CapabilityParseError` before
		// rewriting. A `RangeError` from somewhere unexpected must not be
		// laundered into a parse error that blames the author's input.
		const hostile = {
			operations: ["get"],
			importInterface: "hobo:kv/store",
			resource: "orders",
			// `Object.keys` does not invoke getters, so the allowed-key sweep
			// passes and the throw happens where the parser reads the field.
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
		// The listing matters: a denial code is what an operator greps for, and a
		// typo'd one that parsed would produce an audit record naming a reason
		// that does not exist.
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
		// The default `{}` argument plus the `?? "unknown"` pair. A message
		// reading `undefined:undefined` looks like a bug in the error path and
		// sends the reader chasing the wrong thing.
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
		// Pinning a truth I got wrong first: the constructor assigns each field
		// behind a `!== undefined` guard, which reads as "an absent detail is an
		// absent property". It is not. The `readonly resource?: string` class
		// field declarations are emitted as definite class fields, so every one
		// of them exists as an own property set to `undefined` before the
		// constructor body runs, and the guards cannot remove them.
		//
		// That matters for anything that serializes the error: `JSON.stringify`
		// skips `undefined` values, but `Object.keys`, structured-clone-style
		// walkers, and log shippers that enumerate own properties will emit six
		// empty keys on every denial. Recorded rather than changed — dropping the
		// declarations or switching to `declare` is a call for whoever owns the
		// capability error shape.
		const error = new CapabilityDeniedError("capability.no-linked-route", {
			operation: "get",
		});
		expect(Object.hasOwn(error, "resource")).toBe(true);
		expect(Object.hasOwn(error, "componentId")).toBe(true);
		// The guards do still buy this much: the value is undefined rather than
		// a stringified "undefined", so a reader is not told a wrong resource.
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
