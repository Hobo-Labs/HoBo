import { describe, expect, it } from "vitest";

import {
	CapabilityParseError,
	parseCapabilityGrant,
} from "../../src/capability/parse.js";

describe("parseCapabilityGrant", () => {
	it("sorts operations", () => {
		const grant = parseCapabilityGrant({
			componentId: "api",
			importInterface: "wasi:keyvalue",
			resource: "todos",
			operations: ["set", "get"],
		});
		expect(grant.operations).toEqual(["get", "set"]);
	});

	it("rejects unknown fields", () => {
		expect(() =>
			parseCapabilityGrant({
				componentId: "api",
				importInterface: "wasi:keyvalue",
				resource: "todos",
				operations: ["get"],
				extra: true,
			}),
		).toThrow(CapabilityParseError);
	});
});
