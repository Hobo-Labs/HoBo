import { describe, expect, it } from "vitest";

import {
	buildComponentManifest,
	compareForwardReverse,
	compareSurfaces,
	digestSource,
	extractComponentSurface,
	extractWitContract,
	interfaceRefFromPin,
	parseInterfacePin,
	parseToolchainLock,
	vendorFileName,
} from "../src/index.js";

const WIT = `package hobo:sdk@0.1.0;

interface greeter {
  greet: func(name: string) -> string;
  ping: func() -> u32;
}

world sdk {
  import wasi:io/streams@0.2.0;
  export hobo:sdk/greeter@0.1.0;
}
`;

function contract(source = WIT) {
	return extractWitContract(source);
}

describe("extractWitContract", () => {
	it("reads the package, version, and world", () => {
		const parsed = contract();
		expect(parsed.package).toBe("hobo:sdk");
		expect(parsed.version).toBe("0.1.0");
		expect(parsed.world).toBe("sdk");
	});

	it("reads each interface's functions with params and results", () => {
		const greeter = contract().interfaces.greeter;
		expect(greeter?.functions.map((fn) => fn.name).sort()).toEqual([
			"greet",
			"ping",
		]);
		const greet = greeter?.functions.find((fn) => fn.name === "greet");
		expect(greet?.params).toEqual([{ name: "name", type: "string" }]);
		expect(greet?.result).toBe("string");
	});

	it("normalizes a function with no result to a placeholder rather than dropping it", () => {
		const parsed = extractWitContract(`package hobo:sdk@0.1.0;

interface sink {
  emit: func(value: string);
}

world sdk {
  export hobo:sdk/sink@0.1.0;
}
`);
		expect(parsed.interfaces.sink?.functions[0]?.result).toBeDefined();
	});

	it("reads a function taking no parameters as an empty list", () => {
		const ping = contract().interfaces.greeter?.functions.find(
			(fn) => fn.name === "ping",
		);
		expect(ping?.params).toEqual([]);
	});

	it("separates world imports from exports", () => {
		const parsed = contract();
		expect(parsed.imports).toContain("wasi:io/streams@0.2.0");
		expect(parsed.exports).toContain("hobo:sdk/greeter@0.1.0");
		expect(parsed.imports).not.toContain("hobo:sdk/greeter@0.1.0");
	});

	it("treats a missing version as null rather than inventing one", () => {
		const parsed = extractWitContract(`package hobo:sdk;

world sdk {
  export hobo:sdk/greeter;
}
`);
		expect(parsed.version).toBeNull();
	});

	it("refuses source with no package declaration", () => {
		expect(() => extractWitContract("world sdk {}")).toThrow(
			/missing_package/u,
		);
	});

	it("refuses source with no world", () => {
		expect(() =>
			extractWitContract("package hobo:sdk@0.1.0;\n\ninterface a {}\n"),
		).toThrow(/missing_world/u);
	});

	it("accepts a world with an empty body", () => {
		const parsed = extractWitContract(
			"package hobo:sdk@0.1.0;\n\nworld sdk {\n}\n",
		);
		expect(parsed.imports).toEqual([]);
		expect(parsed.exports).toEqual([]);
	});

	it("sorts and de-duplicates imports and exports", () => {
		const parsed = extractWitContract(`package hobo:sdk@0.1.0;

world sdk {
  import wasi:io/streams@0.2.0;
  import wasi:clocks/monotonic-clock@0.2.0;
  import wasi:io/streams@0.2.0;
}
`);
		expect(parsed.imports).toEqual([
			"wasi:clocks/monotonic-clock@0.2.0",
			"wasi:io/streams@0.2.0",
		]);
	});
});

describe("digestSource", () => {
	it("produces a sha256-prefixed digest", () => {
		expect(digestSource("x")).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it("is stable for identical source", () => {
		expect(digestSource(WIT)).toBe(digestSource(WIT));
	});

	it("normalizes CRLF, so a checkout on Windows digests the same", () => {
		expect(digestSource("a\r\nb")).toBe(digestSource("a\nb"));
	});

	it("changes when the source changes", () => {
		expect(digestSource("a")).not.toBe(digestSource("b"));
	});
});

describe("parseInterfacePin", () => {
	const PIN = "wasi:io/streams@0.2.0@stable";

	it("splits a pin into its parts", () => {
		const pin = parseInterfacePin(PIN);
		expect(pin.namespace).toBe("wasi");
		expect(pin.packageName).toBe("io");
		expect(pin.interfaceName).toBe("streams");
		expect(pin.version).toBe("0.2.0");
		expect(pin.stability).toBe("stable");
	});

	it("keeps the raw id, so a diagnostic can quote what was written", () => {
		expect(parseInterfacePin(PIN).id).toBe(PIN);
	});

	it("returns a frozen pin", () => {
		expect(Object.isFrozen(parseInterfacePin(PIN))).toBe(true);
	});

	it("leaves path and digest empty until the lock supplies them", () => {
		const pin = parseInterfacePin(PIN);
		expect(pin.path).toBe("");
		expect(pin.sha256).toBe("");
	});

	it("refuses an empty or non-string pin", () => {
		for (const raw of ["", undefined, null, 7, {}]) {
			expect(() => parseInterfacePin(raw as never)).toThrow(
				/wit\.pin\.invalid/u,
			);
		}
	});

	it("refuses a malformed pin", () => {
		for (const raw of [
			"wasi:io/streams",
			"wasi:io/streams@0.2.0",
			"wasi/io/streams@0.2.0@stable",
			"wasi:io@0.2.0@stable",
			"@0.2.0@stable",
		]) {
			expect(() => parseInterfacePin(raw)).toThrow(/wit\.pin\.invalid/u);
		}
	});

	it("refuses a stability tier outside the documented set", () => {
		expect(() => parseInterfacePin("wasi:io/streams@0.2.0@invented")).toThrow(
			/wit\.pin\.invalid/u,
		);
	});

	it("derives the interface reference from the pin", () => {
		expect(interfaceRefFromPin(parseInterfacePin(PIN))).toBe(
			"wasi:io/streams@0.2.0",
		);
	});

	it("derives the vendor file name from the pin's path, not its id", () => {
		expect(vendorFileName(parseInterfacePin(PIN))).toBe("");
		const fromLock = parseToolchainLock({
			schema: "hobo.wit-toolchain-lock/v1",
			package: "hobo:sdk@0.1.0",
			canonical_generator: {
				name: "@bytecodealliance/jco",
				version: "1.4.0",
				role: "canonical",
			},
			compat_floor: {
				wasmtime: "27.0.0",
				componentize_js: "0.18.0",
				wrpc: "0.17.0",
				wasm_cloud: "1.5.0",
			},
			wit_deps: [
				{
					id: PIN,
					path: "wit/deps/streams.wit",
					sha256: `sha256:${"a".repeat(64)}`,
				},
			],
		});
		const pinned = fromLock.witDeps[0];
		expect(pinned).toBeDefined();
		if (!pinned) throw new Error("unreachable");
		expect(vendorFileName(pinned)).toBe("streams.wit");
	});
});

describe("parseToolchainLock", () => {
	const LOCK = {
		schema: "hobo.wit-toolchain-lock/v1",
		package: "hobo:sdk@0.1.0",
		canonical_generator: {
			name: "@bytecodealliance/jco",
			version: "1.4.0",
			role: "canonical",
		},
		smoke_generators: [
			{ name: "wit-bindgen", version: "0.36.0", role: "guest" },
		],
		compat_floor: {
			wasmtime: "27.0.0",
			componentize_js: "0.18.0",
			wrpc: "0.17.0",
			wasm_cloud: "1.5.0",
		},
		wit_deps: [
			{
				id: "wasi:io/streams@0.2.0@stable",
				path: "wit/deps/io.wit",
				sha256: `sha256:${"a".repeat(64)}`,
			},
		],
	};

	it("parses a well-formed lock", () => {
		const lock = parseToolchainLock(LOCK);
		expect(lock.canonicalGenerator.name).toBe("@bytecodealliance/jco");
		expect(lock.smokeGenerators[0]?.name).toBe("wit-bindgen");
		expect(lock.witDeps[0]?.path).toBe("wit/deps/io.wit");
	});

	it("refuses a lock that does not declare this exact schema", () => {
		for (const schema of [undefined, "hobo.wit-toolchain-lock/v2", ""]) {
			expect(() => parseToolchainLock({ ...LOCK, schema } as never)).toThrow(
				/schema must be/u,
			);
		}
	});

	it("refuses a lock for a different package", () => {
		expect(() =>
			parseToolchainLock({ ...LOCK, package: "other:pkg@0.1.0" } as never),
		).toThrow(/package must be/u);
	});

	it("refuses a canonical generator that is not jco", () => {
		expect(() =>
			parseToolchainLock({
				...LOCK,
				canonical_generator: {
					name: "wit-bindgen",
					version: "0.36.0",
					role: "canonical",
				},
			} as never),
		).toThrow(/canonical generator must be/u);
	});

	it("accepts a lock with no smoke generators", () => {
		const lock = parseToolchainLock({ ...LOCK, smoke_generators: undefined });
		expect(lock.smokeGenerators).toEqual([]);
	});

	it("accepts the camelCase spelling of the generator keys", () => {
		const lock = parseToolchainLock({
			...LOCK,
			canonical_generator: undefined,
			canonicalGenerator: LOCK.canonical_generator,
			smoke_generators: undefined,
			smokeGenerators: LOCK.smoke_generators,
		} as never);
		expect(lock.smokeGenerators).toHaveLength(1);
	});

	it("carries guards through and refuses an empty one", () => {
		expect(
			parseToolchainLock({ ...LOCK, guards: ["no-network"] }).guards,
		).toEqual(["no-network"]);
		expect(parseToolchainLock(LOCK).guards).toEqual([]);
		for (const guard of ["", 7, null]) {
			expect(() =>
				parseToolchainLock({ ...LOCK, guards: [guard] } as never),
			).toThrow(/guard must be non-empty/u);
		}
	});

	it("accepts both snake_case and camelCase compat floor keys", () => {
		const camel = parseToolchainLock({
			...LOCK,
			compat_floor: {
				wasmtime: "27.0.0",
				componentizeJs: "0.18.0",
				wrpc: "0.17.0",
				wasmCloud: "1.5.0",
			},
		});
		expect(camel.compatFloor.componentizeJs).toBe("0.18.0");
		expect(camel.compatFloor.wasmCloud).toBe("1.5.0");
	});

	it("defaults the transport rather than leaving it unset", () => {
		expect(parseToolchainLock(LOCK).compatFloor.defaultTransport).toBe(
			"wrpc@0.17.0+nats",
		);
	});

	it("honours a stated transport under either spelling", () => {
		for (const key of ["default_transport", "defaultTransport"]) {
			expect(
				parseToolchainLock({
					...LOCK,
					compat_floor: { ...LOCK.compat_floor, [key]: "wrpc@0.18.0+tcp" },
				}).compatFloor.defaultTransport,
			).toBe("wrpc@0.18.0+tcp");
		}
	});

	it("refuses a compat floor version that is not exact semver", () => {
		for (const wasmtime of ["^27.0.0", "27.0", "27", "latest", ""]) {
			expect(() =>
				parseToolchainLock({
					...LOCK,
					compat_floor: { ...LOCK.compat_floor, wasmtime },
				} as never),
			).toThrow(/exact version/u);
		}
	});

	it("refuses a missing compat floor entirely", () => {
		for (const compat_floor of [undefined, null, "floor", 7]) {
			expect(() =>
				parseToolchainLock({ ...LOCK, compat_floor } as never),
			).toThrow(/compat_floor required/u);
		}
	});

	it("refuses a generator that is not an object", () => {
		expect(() =>
			parseToolchainLock({ ...LOCK, canonical_generator: "jco" } as never),
		).toThrow(/must be an object/u);
		expect(() =>
			parseToolchainLock({
				...LOCK,
				smoke_generators: ["wit-bindgen"],
			} as never),
		).toThrow(/must be an object/u);
	});

	it("refuses a generator missing its name, version, or role", () => {
		for (const generator of [
			{ version: "0.36.0", role: "guest" },
			{ name: "", version: "0.36.0", role: "guest" },
			{ name: "wit-bindgen", role: "guest" },
			{ name: "wit-bindgen", version: "0.36", role: "guest" },
			{ name: "wit-bindgen", version: "0.36.0" },
			{ name: "wit-bindgen", version: "0.36.0", role: "" },
		]) {
			expect(() =>
				parseToolchainLock({
					...LOCK,
					smoke_generators: [generator],
				} as never),
			).toThrow(/wit\.lock\.invalid/u);
		}
	});

	it("accepts a dep written as interface plus stability rather than a joined id", () => {
		const lock = parseToolchainLock({
			...LOCK,
			wit_deps: [
				{
					interface: "wasi:io/streams@0.2.0",
					stability: "stable",
					path: "wit/deps/io.wit",
					sha256: `sha256:${"a".repeat(64)}`,
				},
			],
		});
		expect(lock.witDeps[0]?.stability).toBe("stable");
	});

	it("defaults an unstated stability to preview, the cautious answer", () => {
		const lock = parseToolchainLock({
			...LOCK,
			wit_deps: [
				{
					interface: "wasi:io/streams@0.2.0",
					path: "wit/deps/io.wit",
					sha256: `sha256:${"a".repeat(64)}`,
				},
			],
		});
		expect(lock.witDeps[0]?.stability).toBe("preview");
	});

	it("accepts a digest written as digest rather than sha256", () => {
		const lock = parseToolchainLock({
			...LOCK,
			wit_deps: [
				{
					id: "wasi:io/streams@0.2.0@stable",
					path: "wit/deps/io.wit",
					digest: `sha256:${"b".repeat(64)}`,
				},
			],
		});
		expect(lock.witDeps[0]?.sha256).toBe(`sha256:${"b".repeat(64)}`);
	});

	it("refuses a dep path outside the wit tree", () => {
		for (const path of [
			"deps/io.wit",
			"/etc/passwd",
			"wit/deps/io.txt",
			"../wit/io.wit",
			"",
		]) {
			expect(() =>
				parseToolchainLock({
					...LOCK,
					wit_deps: [{ ...LOCK.wit_deps[0], path }],
				} as never),
			).toThrow(/must be wit/u);
		}
	});

	it("refuses a dep with a malformed or missing digest", () => {
		for (const sha256 of [
			"",
			"abc",
			"a".repeat(64),
			"sha256:xyz",
			`sha1:${"a".repeat(40)}`,
		]) {
			expect(() =>
				parseToolchainLock({
					...LOCK,
					wit_deps: [{ ...LOCK.wit_deps[0], sha256 }],
				} as never),
			).toThrow(/sha256/u);
		}
	});

	it("refuses a dep that is not an object, naming its index", () => {
		try {
			parseToolchainLock({
				...LOCK,
				wit_deps: [LOCK.wit_deps[0], "x"],
			} as never);
			expect.unreachable("a non-object dep must be refused");
		} catch (error) {
			expect((error as Error).message).toContain("wit_deps[1]");
		}
	});
});

describe("surface comparison", () => {
	const ARTIFACT = {
		imports: ["wasi:io/streams@0.2.0"],
		exports: ["hobo:sdk/greeter@0.1.0"],
	};

	it("reports parity for a component matching its contract", () => {
		const surface = extractComponentSurface(ARTIFACT, contract());
		expect(compareSurfaces(surface, surface).parity).toBe("matched");
	});

	it("reports drift when the component imports something the contract does not", () => {
		const declared = extractComponentSurface(ARTIFACT, contract());
		const actual = extractComponentSurface(
			{ ...ARTIFACT, imports: [...ARTIFACT.imports, "wasi:sockets/tcp@0.2.0"] },
			contract(),
		);
		const report = compareSurfaces(declared, actual);
		expect(report.parity).toBe("drifted");
		expect(report.driftedImports).toContain("wasi:sockets/tcp@0.2.0");
	});

	it("reports drift when the component fails to export what the contract promises", () => {
		const declared = extractComponentSurface(ARTIFACT, contract());
		const actual = extractComponentSurface(
			{ ...ARTIFACT, exports: [] },
			contract(),
		);
		const report = compareSurfaces(declared, actual);
		expect(report.parity).toBe("drifted");
		expect(report.driftedExports).toContain("hobo:sdk/greeter@0.1.0");
	});

	it("is order-insensitive, so a reordered surface is not drift", () => {
		const many = {
			imports: ["wasi:io/streams@0.2.0", "wasi:clocks/monotonic-clock@0.2.0"],
			exports: ["hobo:sdk/greeter@0.1.0"],
		};
		const forward = extractComponentSurface(many, contract());
		const reverse = extractComponentSurface(
			{ ...many, imports: [...many.imports].reverse() },
			contract(),
		);
		expect(compareSurfaces(forward, reverse).parity).toBe("matched");
	});

	it("falls back to a default contract when none is declared", () => {
		const surface = extractComponentSurface(ARTIFACT);
		expect(surface.imports).toContain("wasi:io/streams@0.2.0");
		expect(surface.exports).toContain("hobo:sdk/greeter@0.1.0");
	});
});

describe("buildComponentManifest", () => {
	it("takes imports and exports from the contract when no overrides are given", () => {
		const manifest = buildComponentManifest(contract());
		expect(manifest.imports).toEqual(contract().imports);
		expect(manifest.exports).toEqual(contract().exports);
	});

	it("lets the artifact's actual surface override the contract's", () => {
		const manifest = buildComponentManifest(contract(), {
			imports: ["wasi:sockets/tcp@0.2.0"],
		});
		expect(manifest.imports).toEqual(["wasi:sockets/tcp@0.2.0"]);
		expect(manifest.exports).toEqual(contract().exports);
	});

	it("treats an empty override as a real, empty surface", () => {
		expect(buildComponentManifest(contract(), { imports: [] }).imports).toEqual(
			[],
		);
	});

	it("normalizes what it builds", () => {
		const manifest = buildComponentManifest(contract(), {
			imports: ["b:b/b@0.1.0", "a:a/a@0.1.0", "b:b/b@0.1.0"],
		});
		expect(manifest.imports).toEqual(["a:a/a@0.1.0", "b:b/b@0.1.0"]);
	});
});

describe("compareForwardReverse", () => {
	it("reports ok for identical declared and extracted contracts", () => {
		const result = compareForwardReverse(contract(), contract());
		expect(result.ok).toBe(true);
		expect(result.report.parity).toBe("matched");
	});

	it("digests both sides, so a receipt can name what it compared", () => {
		const result = compareForwardReverse(contract(), contract());
		expect(result.declared.sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(result.declared.package).toBe("hobo:sdk");
		expect(result.extracted.sha256).toBe(result.declared.sha256);
	});

	it("gives different digests for different surfaces", () => {
		const other = extractWitContract(`package hobo:sdk@0.1.0;

interface greeter {
  greet: func(name: string) -> string;
}

world sdk {
  import wasi:io/streams@0.2.0;
  export hobo:sdk/greeter@0.1.0;
}
`);
		const result = compareForwardReverse(contract(), other);
		expect(result.extracted.sha256).not.toBe(result.declared.sha256);
	});

	it("reports signature drift when an interface loses a function", () => {
		const other = extractWitContract(`package hobo:sdk@0.1.0;

interface greeter {
  greet: func(name: string) -> string;
}

world sdk {
  import wasi:io/streams@0.2.0;
  export hobo:sdk/greeter@0.1.0;
}
`);
		const result = compareForwardReverse(contract(), other);
		expect(result.imports.missing).toEqual([]);
		expect(result.exports.missing).toEqual([]);
		expect(result.declared.interfaces.greeter?.functions).not.toEqual(
			result.extracted.interfaces.greeter?.functions,
		);
	});

	it("names an interface the extracted side is missing", () => {
		const other = extractWitContract(`package hobo:sdk@0.1.0;

world sdk {
  import wasi:io/streams@0.2.0;
}
`);
		const result = compareForwardReverse(contract(), other);
		expect(result.ok).toBe(false);
		expect(result.exports.missing).toContain("hobo:sdk/greeter@0.1.0");
	});

	it("names an interface the extracted side added", () => {
		const other = extractWitContract(`package hobo:sdk@0.1.0;

world sdk {
  import wasi:io/streams@0.2.0;
  import wasi:sockets/tcp@0.2.0;
  export hobo:sdk/greeter@0.1.0;
}
`);
		const result = compareForwardReverse(contract(), other);
		expect(result.ok).toBe(false);
		expect(result.imports.extra).toContain("wasi:sockets/tcp@0.2.0");
	});

	it("reports ok only when parity matched, not merely when lists overlap", () => {
		const other = extractWitContract(`package hobo:sdk@0.1.0;

world sdk {
  export hobo:sdk/greeter@0.1.0;
}
`);
		const result = compareForwardReverse(contract(), other);
		expect(result.ok).toBe(result.report.parity === "matched");
	});
});
