import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	BARE_METAL_YARD_KIND,
	BARE_METAL_YARD_SCHEMA,
	COMPONENT_HOST_KINDS,
	DEFAULT_BARE_METAL_YARD_NAME,
	DEFAULT_COMPONENT_HOST,
	DEFAULT_DEV_PORT,
	defaultHoboHome,
	defaultYardDataDir,
	initBareMetalYard,
	loadBareMetalYardConfig,
	normalizeComponentHostKind,
	openBareMetalYard,
	parseBareMetalYardConfig,
	scaffoldBareMetalYardConfig,
	yardConfigPath,
} from "../src/bare-metal-yard.js";
import type { JsonObject } from "../src/json.js";

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-yard-config-"));
	dirs.push(dir);
	return dir;
}

function doc(overrides: JsonObject = {}) {
	return {
		schemaVersion: BARE_METAL_YARD_SCHEMA,
		kind: BARE_METAL_YARD_KIND,
		name: "local",
		dataDir: "/tmp/yards/local",
		providerId: "local",
		defaultPort: 4000,
		componentHost: "local",
		...overrides,
	};
}

describe("normalizeComponentHostKind", () => {
	it("accepts every documented host kind unchanged", () => {
		for (const kind of COMPONENT_HOST_KINDS) {
			expect(normalizeComponentHostKind(kind)).toBe(kind);
		}
	});

	it("defaults an absent value rather than throwing", () => {
		expect(normalizeComponentHostKind(undefined)).toBe(DEFAULT_COMPONENT_HOST);
		expect(normalizeComponentHostKind(null)).toBe(DEFAULT_COMPONENT_HOST);
	});

	it("refuses a host it does not recognise", () => {
		for (const raw of ["frobnicate", "docker", "", 7, {}, ["local"]]) {
			expect(() => normalizeComponentHostKind(raw)).toThrow();
		}
	});
});

describe("path helpers", () => {
	it("takes HOBO_HOME from the environment when it is non-empty", () => {
		expect(defaultHoboHome({ HOBO_HOME: "/custom/home" })).toBe("/custom/home");
		expect(defaultHoboHome({ HOBO_HOME: "" })).toContain(".hobo");
		expect(defaultHoboHome({})).toContain(".hobo");
	});

	it("puts the config beside the home and the data under a named yard", () => {
		expect(yardConfigPath("/home/x")).toBe(join("/home/x", "yard.json"));
		expect(defaultYardDataDir("/home/x", "alpha")).not.toBe(
			defaultYardDataDir("/home/x", "beta"),
		);
	});
});

describe("parseBareMetalYardConfig", () => {
	it("refuses anything that is not a plain object", () => {
		for (const raw of [null, "yard", 7, [], undefined]) {
			expect(() => parseBareMetalYardConfig(raw)).toThrow(TypeError);
		}
	});

	it("refuses a wrong schema version or kind, naming the expected value", () => {
		expect(() =>
			parseBareMetalYardConfig(doc({ schemaVersion: "hobo.yard/v2" })),
		).toThrow(/schemaVersion/);
		expect(() => parseBareMetalYardConfig(doc({ kind: "cloud" }))).toThrow(
			/kind/,
		);
	});

	it("requires a component host and rejects unknown configuration fields", () => {
		const { componentHost: _componentHost, ...missingHost } = doc();
		expect(() => parseBareMetalYardConfig(missingHost)).toThrow(
			/componentHost is required/,
		);
		expect(() =>
			parseBareMetalYardConfig(doc({ unexpected: "local" })),
		).toThrow(/unknown property: unexpected/);
	});

	it("requires a non-empty name and dataDir", () => {
		for (const [override, field] of [
			[{ name: "" }, "name"],
			[{ name: 7 }, "name"],
			[{ name: null }, "name"],
			[{ dataDir: "" }, "dataDir"],
			[{ dataDir: null }, "dataDir"],
		] as const) {
			expect(() => parseBareMetalYardConfig(doc(override))).toThrow(
				new RegExp(field),
			);
		}
	});

	it("refuses a providerId that is not the bare-metal one", () => {
		expect(() =>
			parseBareMetalYardConfig(doc({ providerId: "vercel" })),
		).toThrow(/providerId/);
	});

	it("defaults a missing or non-integer port instead of refusing", () => {
		const { defaultPort: _defaultPort, ...missingPort } = doc();
		expect(parseBareMetalYardConfig(missingPort).defaultPort).toBe(
			DEFAULT_DEV_PORT,
		);
		for (const defaultPort of ["4000", 3.5, null]) {
			expect(parseBareMetalYardConfig(doc({ defaultPort })).defaultPort).toBe(
				DEFAULT_DEV_PORT,
			);
		}
		expect(
			parseBareMetalYardConfig(doc({ defaultPort: 8080 })).defaultPort,
		).toBe(8080);
	});
});

describe("scaffoldBareMetalYardConfig", () => {
	it("fills every field from defaults when given nothing", () => {
		const config = scaffoldBareMetalYardConfig({ hoboHome: "/home/x" });
		expect(config.name).toBe(DEFAULT_BARE_METAL_YARD_NAME);
		expect(config.defaultPort).toBe(DEFAULT_DEV_PORT);
		expect(config.componentHost).toBe(DEFAULT_COMPONENT_HOST);
		expect(config.dataDir).toBe(
			defaultYardDataDir("/home/x", DEFAULT_BARE_METAL_YARD_NAME),
		);
	});

	it("derives the dataDir from the name unless one is given", () => {
		expect(
			scaffoldBareMetalYardConfig({ hoboHome: "/home/x", name: "alpha" })
				.dataDir,
		).toBe(defaultYardDataDir("/home/x", "alpha"));
		expect(
			scaffoldBareMetalYardConfig({
				hoboHome: "/home/x",
				dataDir: "/elsewhere",
			}).dataDir,
		).toBe("/elsewhere");
	});

	it("uses the selected component host", () => {
		expect(
			scaffoldBareMetalYardConfig({ hoboHome: "/h", componentHost: "oci" })
				.componentHost,
		).toBe("oci");
	});

	it("produces a document its own parser accepts", () => {
		const config = scaffoldBareMetalYardConfig({ hoboHome: "/home/x" });
		expect(parseBareMetalYardConfig(config)).toEqual(config);
	});
});

describe("initBareMetalYard", () => {
	it("writes the config and creates both directories", () => {
		const dir = home();
		const { config, configPath } = initBareMetalYard({ hoboHome: dir });
		expect(existsSync(configPath)).toBe(true);
		expect(existsSync(config.dataDir)).toBe(true);
		expect(readFileSync(configPath, "utf8").endsWith("\n")).toBe(true);
	});

	it("refuses to overwrite an existing config, saying first-run already happened", () => {
		const dir = home();
		initBareMetalYard({ hoboHome: dir });
		expect(() => initBareMetalYard({ hoboHome: dir })).toThrow(
			/already configured/,
		);
		expect(() => initBareMetalYard({ hoboHome: dir })).toThrow(/--force/);
	});

	it("overwrites when forced", () => {
		const dir = home();
		initBareMetalYard({ hoboHome: dir, defaultPort: 4000 });
		const second = initBareMetalYard({
			hoboHome: dir,
			defaultPort: 5000,
			force: true,
		});
		expect(second.config.defaultPort).toBe(5000);
		expect(loadBareMetalYardConfig(dir)?.defaultPort).toBe(5000);
	});

	it("round-trips through load", () => {
		const dir = home();
		const { config } = initBareMetalYard({
			hoboHome: dir,
			name: "alpha",
			componentHost: "oci",
			defaultPort: 9000,
		});
		expect(loadBareMetalYardConfig(dir)).toEqual(config);
	});
});

describe("loadBareMetalYardConfig", () => {
	it("reports no config when none was written", () => {
		expect(loadBareMetalYardConfig(home())).toBeNull();
	});

	it("throws on a config that exists but does not parse", () => {
		const dir = home();
		initBareMetalYard({ hoboHome: dir });
		writeFileSync(yardConfigPath(dir), JSON.stringify({ kind: "cloud" }));
		expect(() => loadBareMetalYardConfig(dir)).toThrow();
	});
});

describe("openBareMetalYard", () => {
	it("initializes a Yard when none exists", () => {
		const dir = home();
		const yard = openBareMetalYard({ hoboHome: dir });
		closers.push(yard.close);
		expect(existsSync(yardConfigPath(dir))).toBe(true);
		expect(yard.config.name).toBe(DEFAULT_BARE_METAL_YARD_NAME);
	});

	it("refuses to auto-init when explicitly told not to, naming the command", () => {
		expect(() =>
			openBareMetalYard({ hoboHome: home(), autoInit: false }),
		).toThrow(/hobo yard init/);
	});

	it("opens the existing Yard's own dataDir rather than a fresh one", () => {
		const dir = home();
		const { config } = initBareMetalYard({ hoboHome: dir, name: "alpha" });
		const yard = openBareMetalYard({ hoboHome: dir });
		closers.push(yard.close);
		expect(yard.config.dataDir).toBe(config.dataDir);
		expect(yard.runtime.store).toBeDefined();
	});

	it("closes the underlying store, and is not idempotent", () => {
		const yard = openBareMetalYard({ hoboHome: home() });
		expect(() => yard.close()).not.toThrow();
		expect(() => yard.close()).toThrow(/not open/);
	});
});
