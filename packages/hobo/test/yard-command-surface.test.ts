import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PINNED_WASMTIME_VERSION } from "@hobo/runtime-wasm";
import { afterEach, describe, expect, it } from "vitest";

import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { createYardCommand } from "../src/yard-command.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-yard-cmd-"));
	dirs.push(dir);
	return dir;
}

function fakeBinary(path: string, version: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
		{ mode: 0o755 },
	);
	chmodSync(path, 0o755);
}

function toolchainEnv(hoboHome: string): NodeJS.ProcessEnv {
	const wasmtime = join(hoboHome, "wasmtime");
	const kubectl = join(hoboHome, "kubectl");
	fakeBinary(wasmtime, `wasmtime ${PINNED_WASMTIME_VERSION}`);
	fakeBinary(kubectl, "Client Version: v1.31.0");
	return {
		HOBO_HOME: hoboHome,
		HOBO_WASMTIME_BIN: wasmtime,
		HOBO_KUBECTL_BIN: kubectl,
		PATH: `${hoboHome}:${dirname(process.execPath)}`,
	};
}

function unavailableToolchainEnv(hoboHome: string): NodeJS.ProcessEnv {
	const env = toolchainEnv(hoboHome);
	const kubectl = join(hoboHome, "kubectl");
	writeFileSync(
		kubectl,
		'#!/usr/bin/env node\nif (process.argv[2] !== "version") process.exit(1);\nconsole.log("Client Version: v1.31.0");\n',
		{ mode: 0o755 },
	);
	chmodSync(kubectl, 0o755);
	return env;
}

async function run(
	args: readonly string[],
	options: {
		flags?: Record<string, string | number | boolean>;
		hoboHome?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
) {
	const hoboHome = options.hoboHome ?? home();
	return createYardCommand().run({
		context: { cwd: hoboHome, env: options.env ?? toolchainEnv(hoboHome) },
		flags: { home: hoboHome, ...options.flags },
		args: [...args],
		emitProgress: () => {},
	} as never);
}

describe("init flag validation", () => {
	it("refuses a port that is not a positive integer", async () => {
		for (const port of ["banana", "0", "-1", "3.5", ""]) {
			const result = await run(["init"], { flags: { port } });
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_YARD_USAGE");
			expect(result.status).toBe("invalid_port");
		}
	});

	it("shows a worked example in the port refusal", async () => {
		const result = await run(["init"], { flags: { port: "banana" } });
		expect((result.remediation ?? []).join(" ")).toContain(
			"hobo yard init --port 4000",
		);
	});

	it("accepts a port given as a number or a numeric string", async () => {
		for (const port of [4000, "4000"]) {
			const result = await run(["init"], { flags: { port, force: true } });
			expect(result.status).not.toBe("invalid_port");
		}
	});

	it("accepts init with no port at all", async () => {
		const result = await run(["init"], { flags: { force: true } });
		expect(result.status).not.toBe("invalid_port");
	});

	it("refuses a component host it does not recognise", async () => {
		for (const host of ["frobnicate", "docker", "", 7]) {
			const result = await run(["init"], { flags: { host, force: true } });
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_YARD_USAGE");
			expect(result.status).toBe("invalid_host");
		}
	});

	it("accepts each documented component host", async () => {
		for (const host of ["local", "wasm", "oci", "cloud-native"]) {
			const dir = home();
			const result = await run(["init"], {
				hoboHome: dir,
				env: toolchainEnv(dir),
				flags: { host, force: true },
			});
			expect(result.status).not.toBe("invalid_host");
		}
	});

	it("accepts init with no host, defaulting rather than refusing", async () => {
		const result = await run(["init"], { flags: { force: true } });
		expect(result.status).not.toBe("invalid_host");
	});

	it("names the recovery paths when init fails", async () => {
		const first = await run(["init"], { flags: { force: true } });
		const firstHome = first.data as { hoboHome?: string } | undefined;
		const second = await run(["init"], {
			hoboHome: firstHome?.hoboHome ?? home(),
		});
		if (!second.ok) {
			expect((second.remediation ?? []).join(" ")).toContain(
				"hobo yard status",
			);
		}
	});
});

describe("status", () => {
	it("reports a missing Yard distinctly from an unhealthy one", async () => {
		const result = await run(["status"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_YARD_MISSING");
		expect(result.status).toBe("not_installed");
	});

	it("names the config path it looked for", async () => {
		const dir = home();
		const result = await run(["status"], { hoboHome: dir });
		expect(result.message).toContain(dir);
	});

	it("reports the config once a Yard exists", async () => {
		const dir = home();
		await run(["init"], { hoboHome: dir, flags: { force: true } });
		const result = await run(["status"], { hoboHome: dir });
		expect(result.ok).toBe(true);
		expect((result.data as { config: unknown }).config).toBeDefined();
	});

	it("defaults to status when no subcommand is given", async () => {
		const bare = await run([]);
		const explicit = await run(["status"]);
		expect(bare.code).toBe(explicit.code);
	});
});

describe("doctor", () => {
	it("reports a missing config as such, pointing at init", async () => {
		const result = await run(["doctor"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_YARD_MISSING");
		expect(result.status).toBe("missing_config");
		expect((result.remediation ?? []).join(" ")).toContain("hobo yard init");
	});

	it("carries the wasm engine probe even when the Yard is missing", async () => {
		const result = await run(["doctor"]);
		expect((result.data as { wasm: unknown }).wasm).toBeDefined();
	});

	it("explains the five scopes it reports on", async () => {
		const result = await run(["doctor"]);
		const scopes = (result.data as { scopes: Record<string, string> }).scopes;
		expect(Object.keys(scopes).sort()).toEqual([
			"bindle",
			"camp",
			"componentHost",
			"meshEnv",
			"yard",
		]);
		expect(scopes.meshEnv).toContain("x-hobo-env-");
	});

	it("reports the component hosts the machine can actually run", async () => {
		const result = await run(["doctor"]);
		expect(
			(result.data as { componentHosts?: unknown }).componentHosts,
		).toBeDefined();
	});

	it("survives a host probe that throws, reporting the error", {
		timeout: 60_000,
	}, async () => {
		const dir = home();
		initBareMetalYard({ hoboHome: dir, componentHost: "oci" });
		const result = await run(["doctor"], {
			hoboHome: dir,
			env: unavailableToolchainEnv(dir),
		});
		expect(result).toBeDefined();
		expect(result.data).toBeDefined();
	});

	it("distinguishes a not-ready host from a missing config", {
		timeout: 60_000,
	}, async () => {
		const dir = home();
		initBareMetalYard({ hoboHome: dir, componentHost: "oci" });
		const result = await run(["doctor"], {
			hoboHome: dir,
			env: unavailableToolchainEnv(dir),
		});
		if (!result.ok) {
			expect(result.code).not.toBe("HOBO_YARD_MISSING");
			expect((result.remediation ?? []).join(" ")).toContain(
				"hobo yard ensure",
			);
		}
	});
});

describe("ensure", () => {
	async function ensure(dir = home()) {
		return run(["ensure"], { hoboHome: dir, env: toolchainEnv(dir) });
	}

	it("reports each host and whether it is ready", async () => {
		const result = await ensure();
		const data = result.data as { hosts?: Array<{ kind: string }> };
		expect(Array.isArray(data.hosts)).toBe(true);
		expect(result.message).toContain("hobo yard ensure");
	});

	it("distinguishes fully ready from partial", async () => {
		const result = await ensure();
		expect([
			"HOBO_YARD_ENSURE",
			"HOBO_YARD_ENSURE_PARTIAL",
			"HOBO_YARD_ENSURE_FAILED",
		]).toContain(result.code);
		if (result.code !== "HOBO_YARD_ENSURE") {
			expect(result.ok).toBe(false);
		}
	});

	it("names the install root it worked under", async () => {
		const dir = home();
		const result = await ensure(dir);
		expect((result.data as { hoboHome: string }).hoboHome).toBe(dir);
	});

	it("names every override in its failure remediation", async () => {
		const result = await ensure();
		if (result.code === "HOBO_YARD_ENSURE_FAILED") {
			const remediation = (result.remediation ?? []).join(" ");
			expect(remediation).toContain("HOBO_WASMTIME_BIN");
			expect(remediation).toContain("HOBO_KUBECTL_BIN");
			expect(remediation).toContain("HOBO_HOME");
		}
	});
});

describe("unknown subcommands", () => {
	it("refuses one it does not recognise, naming it", async () => {
		const result = await run(["frobnicate"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_YARD_USAGE");
		expect(result.status).toBe("unknown_subcommand");
		expect(result.message).toContain("frobnicate");
	});

	it("shows the full init usage, including its flags", async () => {
		const remediation = ((await run(["frobnicate"])).remediation ?? []).join(
			" ",
		);
		expect(remediation).toContain("hobo yard init");
		expect(remediation).toContain("--host local|wasm|oci|cloud-native");
	});
});

describe("home resolution", () => {
	it("honours an explicit --home over the environment", async () => {
		const dir = home();
		const result = await createYardCommand().run({
			context: { cwd: dir, env: { HOBO_HOME: "/somewhere/else" } },
			flags: { home: dir },
			args: ["status"],
			emitProgress: () => {},
		} as never);
		expect(result.message).toContain(dir);
	});

	it("falls back to the environment when no flag is given", async () => {
		const dir = home();
		const result = await createYardCommand().run({
			context: { cwd: dir, env: { HOBO_HOME: dir } },
			flags: {},
			args: ["status"],
			emitProgress: () => {},
		} as never);
		expect(result.message).toContain(dir);
	});
});
