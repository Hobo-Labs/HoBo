import { describe, expect, it } from "vitest";

import { parseInterfaceId, parseWireVersion } from "../src/ports/wrpc-link.js";

describe("wrpc-link parse boundaries", () => {
	it("parseWireVersion accepts valid semver", () => {
		expect(parseWireVersion("1.2.3")).toEqual({
			raw: "1.2.3",
			major: 1,
			minor: 2,
			patch: 3,
		});
		expect(parseWireVersion("1.2.3-rc.1").raw).toBe("1.2.3-rc.1");
	});

	it("parseWireVersion rejects malformed semver", () => {
		expect(() => parseWireVersion("1.2")).toThrow(/invalid_semver/);
		expect(() => parseWireVersion("v1.2.3")).toThrow(/invalid_semver/);
		expect(() => parseWireVersion("")).toThrow(/invalid_semver/);
	});

	it("parseInterfaceId accepts versioned WIT interface ids", () => {
		const id = parseInterfaceId("wasi:keyvalue/store@0.2.0");
		expect(id).toBe("wasi:keyvalue/store@0.2.0");
	});

	it("parseInterfaceId rejects malformed ids", () => {
		expect(() => parseInterfaceId("")).toThrow(/interface_id_required/);
		expect(() => parseInterfaceId("not-an-interface")).toThrow(
			/invalid_interface_id/,
		);
	});
});
