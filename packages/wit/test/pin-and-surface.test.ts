import { describe, expect, it } from "vitest";

import {
	compareSurfaces,
	digestSource,
	extractWitContract,
	interfaceRefFromPin,
	parseInterfacePin,
	parseToolchainLock,
	vendorFileName,
} from "../src/index.js";

const PIN = "wasi:http/incoming-handler@0.2.0@stable";

const lock = (overrides: Record<string, unknown> = {}) => ({
	schema: "hobo.wit-toolchain-lock/v1",
	package: "hobo:sdk@0.1.0",
	canonical_generator: {
		name: "@bytecodealliance/jco",
		version: "1.4.0",
		role: "canonical",
	},
	compat_floor: {
		wasmtime: "26.0.0",
		componentize_js: "0.10.0",
		wrpc: "0.17.0",
		wasm_cloud: "1.0.0",
	},
	...overrides,
});

const surface = (
	imports: string[] = [],
	exports: string[] = [],
	functionSignatures: { name: string; signature: string }[] = [],
) => ({ imports, exports, functionSignatures }) as never;

describe("parseInterfacePin", () => {
	it("parses a fully qualified pin", () => {
		expect(parseInterfacePin(PIN)).toMatchObject({
			namespace: "wasi",
			packageName: "http",
			interfaceName: "incoming-handler",
			version: "0.2.0",
			stability: "stable",
		});
	});

	it("keeps the raw id on the parsed pin", () => {
		expect(parseInterfacePin(PIN).id).toBe(PIN);
	});

	it("freezes the pin", () => {
		expect(Object.isFrozen(parseInterfacePin(PIN))).toBe(true);
	});

	it.each([
		"stable",
		"preview",
		"experimental",
		"deprecated",
	])("accepts the stability tier %s", (tier) => {
		expect(
			parseInterfacePin(`wasi:http/incoming-handler@0.2.0@${tier}`).stability,
		).toBe(tier);
	});

	it.each(["", null, undefined, 7])("rejects the non-string pin %s", (raw) => {
		expect(() => parseInterfacePin(raw as string)).toThrow(
			/wit\.pin\.invalid/u,
		);
	});

	it("rejects a pin with no stability tier", () => {
		expect(() => parseInterfacePin("wasi:http/incoming-handler@0.2.0")).toThrow(
			/wit\.pin\.invalid/u,
		);
	});

	it("rejects an unknown stability tier", () => {
		expect(() =>
			parseInterfacePin("wasi:http/incoming-handler@0.2.0@alpha"),
		).toThrow(/wit\.pin\.invalid/u);
	});

	it("rejects a pin with no version", () => {
		expect(() =>
			parseInterfacePin("wasi:http/incoming-handler@stable"),
		).toThrow(/wit\.pin\.invalid/u);
	});

	it.each([
		"0.2",
		"0.2.0.1",
		"v0.2.0",
		"latest",
	])("rejects the inexact version %s", (version) => {
		expect(() =>
			parseInterfacePin(`wasi:http/incoming-handler@${version}@stable`),
		).toThrow(/wit\.pin\.invalid/u);
	});

	it("rejects a pin with no namespace", () => {
		expect(() =>
			parseInterfacePin("http/incoming-handler@0.2.0@stable"),
		).toThrow(/wit\.pin\.invalid/u);
	});

	it("rejects a pin with no interface", () => {
		expect(() => parseInterfacePin("wasi:http@0.2.0@stable")).toThrow(
			/wit\.pin\.invalid/u,
		);
	});

	it.each([
		"WASI:http/h@0.2.0@stable",
		"wasi:HTTP/h@0.2.0@stable",
	])("rejects the uppercase pin %s", (raw) => {
		expect(() => parseInterfacePin(raw)).toThrow(/wit\.pin\.invalid/u);
	});

	it("names the offending pin in the error", () => {
		expect(() => parseInterfacePin("nonsense")).toThrow(/nonsense/u);
	});
});

describe("interfaceRefFromPin and vendorFileName", () => {
	it("builds a reference without the stability tier", () => {
		expect(interfaceRefFromPin(parseInterfacePin(PIN))).toBe(
			"wasi:http/incoming-handler@0.2.0",
		);
	});

	it("takes the vendor file name from the pin's recorded path", () => {
		expect(
			vendorFileName({
				...parseInterfacePin(PIN),
				path: "wit/deps/wasi-http-incoming-handler.wit",
			}),
		).toBe("wasi-http-incoming-handler.wit");
	});

	it("reports nothing for a pin that carries no path", () => {
		expect(vendorFileName(parseInterfacePin(PIN))).toBe("");
	});
});

describe("parseToolchainLock", () => {
	it("parses a minimal lock", () => {
		expect(parseToolchainLock(lock()).schema).toBe(
			"hobo.wit-toolchain-lock/v1",
		);
	});

	it("rejects an unknown schema rather than migrating it", () => {
		expect(() =>
			parseToolchainLock(lock({ schema: "hobo.wit-toolchain-lock/v2" })),
		).toThrow(/schema must be/u);
	});

	it("rejects a lock for a different package", () => {
		expect(() =>
			parseToolchainLock(lock({ package: "other:sdk@0.1.0" })),
		).toThrow(/package must be/u);
	});

	it("rejects a lock naming a different canonical generator", () => {
		expect(() =>
			parseToolchainLock(
				lock({
					canonical_generator: {
						name: "wit-bindgen",
						version: "1.0.0",
						role: "canonical",
					},
				}),
			),
		).toThrow(/canonical generator must be/u);
	});

	it("accepts the camelCase spelling of the generator key", () => {
		const { canonical_generator, ...rest } = lock();
		expect(() =>
			parseToolchainLock({ ...rest, canonicalGenerator: canonical_generator }),
		).not.toThrow();
	});

	it("defaults smoke generators to empty", () => {
		expect(parseToolchainLock(lock()).smokeGenerators).toEqual([]);
	});

	it("treats a non-array smoke-generator field as empty", () => {
		expect(
			parseToolchainLock(lock({ smoke_generators: "jco" })).smokeGenerators,
		).toEqual([]);
	});

	it("defaults wit deps to empty", () => {
		expect(parseToolchainLock(lock()).witDeps).toEqual([]);
	});

	it("defaults guards to empty", () => {
		expect(parseToolchainLock(lock()).guards).toEqual([]);
	});

	it("keeps declared guards", () => {
		expect(parseToolchainLock(lock({ guards: ["no-wasi-nn"] })).guards).toEqual(
			["no-wasi-nn"],
		);
	});

	it("rejects an empty guard string", () => {
		expect(() => parseToolchainLock(lock({ guards: [""] }))).toThrow(
			/guard must be non-empty/u,
		);
	});

	it("rejects a non-string guard", () => {
		expect(() => parseToolchainLock(lock({ guards: [7] }))).toThrow(
			/guard must be non-empty/u,
		);
	});

	it("treats a non-array guards field as empty", () => {
		expect(parseToolchainLock(lock({ guards: "no-wasi-nn" })).guards).toEqual(
			[],
		);
	});

	it("freezes the parsed lock", () => {
		expect(Object.isFrozen(parseToolchainLock(lock()))).toBe(true);
	});
});

describe("extractWitContract", () => {
	it("reads the package and version from a WIT source", () => {
		const contract = extractWitContract(
			"package hobo:sdk@0.1.0;\n\nworld sdk {\n}\n",
		);
		expect(contract.package).toBe("hobo:sdk");
		expect(contract.version).toBe("0.1.0");
	});

	it("rejects a source with no world declaration", () => {
		expect(() => extractWitContract("package hobo:sdk@0.1.0;\n")).toThrow(
			/wit\.surface\.missing_world/u,
		);
	});

	it("rejects a source with no package declaration", () => {
		expect(() => extractWitContract("world sdk {\n}\n")).toThrow(
			/wit\.surface\.missing_package/u,
		);
	});

	it("finds the package declaration after leading comments", () => {
		expect(
			extractWitContract(
				"// a note\npackage hobo:sdk@0.1.0;\n\nworld sdk {\n}\n",
			).package,
		).toBe("hobo:sdk");
	});
});

describe("compareSurfaces", () => {
	it("reports parity when both sides agree", () => {
		const s = surface(["wasi:io/streams"], ["hobo:sdk/handler"]);
		expect(compareSurfaces(s, s).parity).toBe("matched");
	});

	it("reports an import the component does not have", () => {
		const report = compareSurfaces(surface(["wasi:io/streams"]), surface([]));
		expect(report.parity).toBe("drifted");
		expect(report.driftedImports).toContain("wasi:io/streams");
	});

	it("reports an import the component has but the contract does not declare", () => {
		const report = compareSurfaces(surface([]), surface(["wasi:sockets/tcp"]));
		expect(report.driftedImports).toContain("wasi:sockets/tcp");
	});

	it("reports export drift separately from import drift", () => {
		const report = compareSurfaces(
			surface([], ["hobo:sdk/handler"]),
			surface([], []),
		);
		expect(report.driftedExports).toContain("hobo:sdk/handler");
		expect(report.driftedImports).toEqual([]);
	});

	it("reports both directions at once rather than stopping at the first", () => {
		const report = compareSurfaces(
			surface(["a"], ["x"]),
			surface(["b"], ["y"]),
		);
		expect(report.driftedImports.length).toBeGreaterThan(1);
		expect(report.driftedExports.length).toBeGreaterThan(1);
	});

	it("matches two empty surfaces", () => {
		expect(compareSurfaces(surface(), surface()).parity).toBe("matched");
	});

	it("freezes the report", () => {
		expect(Object.isFrozen(compareSurfaces(surface(), surface()))).toBe(true);
	});

	it("is symmetric in its verdict", () => {
		const a = surface(["wasi:io/streams"]);
		const b = surface([]);
		expect(compareSurfaces(a, b).parity).toBe(compareSurfaces(b, a).parity);
	});
});

describe("digestSource", () => {
	it("prefixes the digest with its algorithm", () => {
		expect(digestSource("package hobo:sdk@0.1.0;")).toMatch(
			/^sha256:[0-9a-f]{64}$/u,
		);
	});

	it("is stable for the same source", () => {
		expect(digestSource("abc")).toBe(digestSource("abc"));
	});

	it("differs for different sources", () => {
		expect(digestSource("abc")).not.toBe(digestSource("abd"));
	});

	it("differs on whitespace, since a vendored file is byte-pinned", () => {
		expect(digestSource("a b")).not.toBe(digestSource("a  b"));
	});
});
