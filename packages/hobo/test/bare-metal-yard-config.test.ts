/**
 * The local Yard's `yard.json` — parse, scaffold, init, open.
 *
 * `yard.json` is the first thing HoBo writes on a machine and the thing every
 * later command reads to learn where the durable log lives and which component
 * host to serve on. It is small, hand-editable, and load-bearing.
 *
 * **The parser refuses rather than defaults on identity fields.** Schema
 * version, kind, name, dataDir, and providerId all throw when wrong or
 * missing. A config that silently defaulted its `dataDir` would point a second
 * install at a different durable log than the one holding the user's
 * deployments — data loss that reads as "my deployments disappeared".
 *
 * **`defaultPort` and `componentHost` do default**, because both are
 * recoverable: a wrong port fails visibly at bind time, and an unrecognised
 * host is refused by `normalizeComponentHostKind` anyway. The legacy `host`
 * field is still read, so a config written by an older build keeps working.
 *
 * **`init` refuses to overwrite without `--force`.** An existing `yard.json`
 * means first-run already happened, and re-scaffolding would point the machine
 * at a fresh empty dataDir while the old one still holds everything.
 */
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

/** A config document that parses, for tests that vary one field at a time. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

	it("maps the legacy spellings onto their current kinds", () => {
		// Configs written by older builds are still on disk. Refusing them would
		// break machines that have simply not re-run `yard init`.
		expect(normalizeComponentHostKind("isolated-wasm")).toBe("wasm");
		expect(normalizeComponentHostKind("bare-metal")).toBe("local");
		expect(normalizeComponentHostKind("runtime-local")).toBe("local");
	});

	it("defaults an absent value rather than throwing", () => {
		// A config that predates the field is not a broken config.
		expect(normalizeComponentHostKind(undefined)).toBe(DEFAULT_COMPONENT_HOST);
		expect(normalizeComponentHostKind(null)).toBe(DEFAULT_COMPONENT_HOST);
	});

	it("refuses a host it does not recognise", () => {
		// An unrecognised host written to config would be read back by every
		// later command and fail there instead of here.
		for (const raw of ["frobnicate", "docker", "", 7]) {
			expect(() => normalizeComponentHostKind(raw)).toThrow();
		}
	});
});

describe("path helpers", () => {
	it("takes HOBO_HOME from the environment when it is non-empty", () => {
		// An exported-but-empty variable is how a shell leaves a value that was
		// never set — honouring it would put the install root at the filesystem
		// root.
		expect(defaultHoboHome({ HOBO_HOME: "/custom/home" })).toBe("/custom/home");
		expect(defaultHoboHome({ HOBO_HOME: "" })).toContain(".hobo");
		expect(defaultHoboHome({})).toContain(".hobo");
	});

	it("puts the config beside the home and the data under a named yard", () => {
		// Two yards on one machine must not share a dataDir, which is why the
		// name is part of the path rather than a field inside one directory.
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
		// Reading a future document with today's shape would discard fields this
		// version does not know and write them away on the next save.
		expect(() =>
			parseBareMetalYardConfig(doc({ schemaVersion: "hobo.yard/v2" })),
		).toThrow(/schemaVersion/);
		expect(() => parseBareMetalYardConfig(doc({ kind: "cloud" }))).toThrow(
			/kind/,
		);
	});

	it("requires a non-empty name and dataDir", () => {
		// A defaulted `dataDir` would point a second install at a different
		// durable log than the one holding the user's deployments.
		for (const [override, field] of [
			[{ name: "" }, "name"],
			[{ name: 7 }, "name"],
			[{ name: undefined }, "name"],
			[{ dataDir: "" }, "dataDir"],
			[{ dataDir: null }, "dataDir"],
		] as const) {
			expect(() => parseBareMetalYardConfig(doc(override))).toThrow(
				new RegExp(field),
			);
		}
	});

	it("refuses a providerId that is not the bare-metal one", () => {
		// This file describes a local Yard specifically. A cloud provider id
		// here would be read as one and drive placement against a provider the
		// machine cannot reach.
		expect(() =>
			parseBareMetalYardConfig(doc({ providerId: "vercel" })),
		).toThrow(/providerId/);
	});

	it("defaults a missing or non-integer port instead of refusing", () => {
		// A wrong port fails visibly at bind time, so it is recoverable in a way
		// a wrong dataDir is not — the parser does not need to be strict here.
		for (const defaultPort of [undefined, "4000", 3.5, null]) {
			expect(parseBareMetalYardConfig(doc({ defaultPort })).defaultPort).toBe(
				DEFAULT_DEV_PORT,
			);
		}
		expect(
			parseBareMetalYardConfig(doc({ defaultPort: 8080 })).defaultPort,
		).toBe(8080);
	});

	it("reads the legacy host field when componentHost is absent", () => {
		// Older configs carry `host`. Dropping it would silently move every
		// deploy on that machine to the default host.
		const parsed = parseBareMetalYardConfig(
			doc({ componentHost: undefined, host: "isolated-wasm" }),
		);
		expect(parsed.componentHost).toBe("wasm");
	});

	it("prefers componentHost when both fields are present", () => {
		// `componentHost` is the current spelling; a stale `host` left behind by
		// a partial edit must not win over the field the user just wrote.
		expect(
			parseBareMetalYardConfig(doc({ componentHost: "oci", host: "local" }))
				.componentHost,
		).toBe("oci");
	});

	it("writes both spellings back so an older reader still works", () => {
		// A machine that alternates between builds must not lose its host on
		// every round trip.
		const parsed = parseBareMetalYardConfig(doc({ componentHost: "wasm" }));
		expect(parsed.componentHost).toBe("wasm");
		expect(parsed.host).toBe("wasm");
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

	it("accepts the host under either spelling, preferring componentHost", () => {
		expect(
			scaffoldBareMetalYardConfig({ hoboHome: "/h", host: "oci" })
				.componentHost,
		).toBe("oci");
		expect(
			scaffoldBareMetalYardConfig({
				hoboHome: "/h",
				componentHost: "wasm",
				host: "oci",
			}).componentHost,
		).toBe("wasm");
	});

	it("produces a document its own parser accepts", () => {
		// Scaffold and parse are two halves of one contract. A scaffold the
		// parser rejects would make `yard init` write a file no command can read.
		const config = scaffoldBareMetalYardConfig({ hoboHome: "/home/x" });
		expect(parseBareMetalYardConfig(config)).toEqual(config);
	});
});

describe("initBareMetalYard", () => {
	it("writes the config and creates both directories", () => {
		// The dataDir has to exist before the first append, and nothing else
		// creates it — a config pointing at a missing directory would fail on
		// the first deploy rather than at install time.
		const dir = home();
		const { config, configPath } = initBareMetalYard({ hoboHome: dir });
		expect(existsSync(configPath)).toBe(true);
		expect(existsSync(config.dataDir)).toBe(true);
		expect(readFileSync(configPath, "utf8").endsWith("\n")).toBe(true);
	});

	it("refuses to overwrite an existing config, saying first-run already happened", () => {
		// Re-scaffolding would point the machine at a fresh empty dataDir while
		// the old one still holds every deployment. The message says so rather
		// than reporting a bare file conflict.
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

	it("carries the legacy host option through to the written config", () => {
		const dir = home();
		expect(
			initBareMetalYard({ hoboHome: dir, host: "wasm" }).config.componentHost,
		).toBe("wasm");
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
		// A first run has none, and that is the signal to init — not an error.
		expect(loadBareMetalYardConfig(home())).toBeNull();
	});

	it("throws on a config that exists but does not parse", () => {
		// Unlike a missing file, a present-but-invalid one means someone edited
		// it. Returning null would silently re-init over their edit; throwing
		// puts the mistake in front of them.
		const dir = home();
		initBareMetalYard({ hoboHome: dir });
		writeFileSync(yardConfigPath(dir), JSON.stringify({ kind: "cloud" }));
		expect(() => loadBareMetalYardConfig(dir)).toThrow();
	});
});

describe("openBareMetalYard", () => {
	it("initializes a Yard when none exists", () => {
		// Zero-config is the product: `hobo up` on a fresh machine must not stop
		// to ask the user to run an install command first.
		const dir = home();
		const yard = openBareMetalYard({ hoboHome: dir });
		closers.push(yard.close);
		expect(existsSync(yardConfigPath(dir))).toBe(true);
		expect(yard.config.name).toBe(DEFAULT_BARE_METAL_YARD_NAME);
	});

	it("refuses to auto-init when explicitly told not to, naming the command", () => {
		// A caller that wants to observe rather than install needs the refusal —
		// and the user reading it needs to know which command creates one.
		expect(() =>
			openBareMetalYard({ hoboHome: home(), autoInit: false }),
		).toThrow(/hobo yard init/);
	});

	it("opens the existing Yard's own dataDir rather than a fresh one", () => {
		// The runtime is what holds deployments. Opening a different dataDir
		// than the config names would present an empty machine to a user who
		// has deployed.
		const dir = home();
		const { config } = initBareMetalYard({ hoboHome: dir, name: "alpha" });
		const yard = openBareMetalYard({ hoboHome: dir });
		closers.push(yard.close);
		expect(yard.config.dataDir).toBe(config.dataDir);
		expect(yard.runtime.store).toBeDefined();
	});

	it("closes the underlying store, and is not idempotent", () => {
		// `close` reaches through to the store's own `close` when it has one, so
		// a second call lands on an already-closed database and throws. Pinned
		// as-is rather than smoothed over: a caller that closes twice has a
		// lifetime bug, and hiding it here would move the failure to whichever
		// later append found the handle gone.
		const yard = openBareMetalYard({ hoboHome: home() });
		expect(() => yard.close()).not.toThrow();
		expect(() => yard.close()).toThrow(/not open/);
	});
});
