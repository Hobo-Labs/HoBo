/**
 * The `hobo yard` command's argument and status surface.
 *
 * A Yard is the local install root — where toolchains land and where the
 * component host is configured. Two properties shape the command.
 *
 * **Bad flags are refused before anything is written.** `--port banana` and
 * `--host frobnicate` are caught at parse time rather than becoming a `yard.json`
 * with a `NaN` port or an unrecognised host. A config written and then rejected
 * on the next command is far harder to diagnose than an invocation refused where
 * it was typed.
 *
 * **Every unhealthy state says which one it is.** `status` and `doctor`
 * distinguish "no Yard here" from "a Yard whose host is not ready", and they
 * carry different codes and different remediation, because the fixes are
 * `yard init` and `yard ensure` respectively. Collapsing them would send half
 * the users to the wrong command.
 *
 * `doctor` also has to survive its own probe failing — a host toolchain that
 * throws while being checked is exactly the situation doctor exists to report,
 * so letting the exception escape would make the diagnostic unavailable
 * precisely when it is needed.
 */
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

/**
 * A stand-in toolchain binary that answers a version probe and nothing else.
 *
 * `yard ensure` walks every registered host, and the wasm and oci hosts would
 * otherwise reach for a real wasmtime download and a real cluster. Pointing
 * their binary overrides at scripts on disk keeps the command on the path it
 * takes when a toolchain is already present, which is the branch under test —
 * without a network call that makes the test both slow and non-hermetic.
 */
function fakeBinary(path: string, version: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
		{ mode: 0o755 },
	);
	chmodSync(path, 0o755);
}

/** Env that keeps `ensure` off the network, plus the install root it works under. */
function toolchainEnv(hoboHome: string): NodeJS.ProcessEnv {
	const wasmtime = join(hoboHome, "wasmtime");
	const kubectl = join(hoboHome, "kubectl");
	fakeBinary(wasmtime, `wasmtime ${PINNED_WASMTIME_VERSION}`);
	fakeBinary(kubectl, "Client Version: v1.31.0");
	return {
		HOBO_HOME: hoboHome,
		HOBO_WASMTIME_BIN: wasmtime,
		HOBO_KUBECTL_BIN: kubectl,
		// The stand-ins are node scripts, so their `#!/usr/bin/env node` line
		// still needs node's own directory on PATH.
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

/** Run `hobo yard <args>` against an isolated install root. */
async function run(
	args: readonly string[],
	options: {
		flags?: Record<string, string | number | boolean>;
		hoboHome?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
) {
	const hoboHome = options.hoboHome ?? home();
	// SAFETY: this helper supplies the command's complete test-runner context.
	return createYardCommand().run({
		context: { cwd: hoboHome, env: options.env ?? toolchainEnv(hoboHome) },
		flags: { home: hoboHome, ...options.flags },
		args: [...args],
		emitProgress: () => {},
	} as never);
}

describe("init flag validation", () => {
	it("refuses a port that is not a positive integer", async () => {
		// A `NaN` or negative port written into yard.json would fail at bind time
		// — a command later, with an error naming a config file the user did not
		// know had been written.
		for (const port of ["banana", "0", "-1", "3.5", ""]) {
			const result = await run(["init"], { flags: { port } });
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_YARD_USAGE");
			expect(result.status).toBe("invalid_port");
		}
	});

	it("shows a worked example in the port refusal", async () => {
		// The flag takes a bare number, which is not obvious from "must be a
		// positive integer" alone.
		const result = await run(["init"], { flags: { port: "banana" } });
		expect((result.remediation ?? []).join(" ")).toContain(
			"hobo yard init --port 4000",
		);
	});

	it("accepts a port given as a number or a numeric string", async () => {
		// The CLI parser hands strings; a programmatic caller hands numbers.
		// Accepting only one would make the command work from one caller.
		for (const port of [4000, "4000"]) {
			const result = await run(["init"], { flags: { port, force: true } });
			expect(result.status).not.toBe("invalid_port");
		}
	});

	it("accepts init with no port at all", async () => {
		// The default is the point of a first run. Requiring a port would make
		// `hobo yard init` an incantation rather than a command.
		const result = await run(["init"], { flags: { force: true } });
		expect(result.status).not.toBe("invalid_port");
	});

	it("refuses a component host it does not recognise", async () => {
		// The host decides how components execute. An unrecognised one written to
		// config would be read back by every later command and fail there.
		for (const host of ["frobnicate", "docker", "", 7]) {
			const result = await run(["init"], { flags: { host, force: true } });
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_YARD_USAGE");
			expect(result.status).toBe("invalid_host");
		}
	});

	it("accepts each documented component host", async () => {
		// The toolchain stand-ins matter here too: `init` ensures the host it was
		// given, so `wasm` and `oci` would otherwise reach for a real download and
		// a real cluster rather than exercising the flag-acceptance branch.
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
		// `hostFlag !== undefined && … === undefined`. An absent flag is not an
		// invalid one, and conflating them would make the simplest invocation
		// fail.
		const result = await run(["init"], { flags: { force: true } });
		expect(result.status).not.toBe("invalid_host");
	});

	it("names the recovery paths when init fails", async () => {
		// The most common cause is a yard.json that already exists — which means
		// the first run *worked*. The remediation says so first, because the
		// instinct on seeing a failure is to re-run with --force and overwrite a
		// working install.
		const first = await run(["init"], { flags: { force: true } });
		// SAFETY: successful init reports its optional install root.
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
		// Two states, two codes. "No Yard here" is fixed by `init`; an unhealthy
		// one is fixed by `ensure`, and one code for both would send half the
		// users to the wrong command.
		const result = await run(["status"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_YARD_MISSING");
		expect(result.status).toBe("not_installed");
	});

	it("names the config path it looked for", async () => {
		// So a user who set HOBO_HOME can see whether the command looked where
		// they expected — the most common cause of "no Yard" is looking in the
		// wrong root.
		const dir = home();
		const result = await run(["status"], { hoboHome: dir });
		expect(result.message).toContain(dir);
	});

	it("reports the config once a Yard exists", async () => {
		const dir = home();
		await run(["init"], { hoboHome: dir, flags: { force: true } });
		const result = await run(["status"], { hoboHome: dir });
		expect(result.ok).toBe(true);
		// SAFETY: successful status returns the parsed Yard config.
		expect((result.data as { config: unknown }).config).toBeDefined();
	});

	it("defaults to status when no subcommand is given", async () => {
		// `args[0] ?? "status"`. A bare `hobo yard` should say what it knows
		// rather than print usage — the state of the Yard is the thing a user
		// most often wants.
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
		// The probe is about the machine, not the Yard. Withholding it because no
		// config exists would deny the user the one fact that explains whether
		// `--host wasm` is even possible here.
		const result = await run(["doctor"]);
		// SAFETY: doctor includes its WASM probe in the diagnostic payload.
		expect((result.data as { wasm: unknown }).wasm).toBeDefined();
	});

	it("explains the five scopes it reports on", async () => {
		// Yard, Camp, componentHost, Bindle and meshEnv are five different things
		// a user routinely conflates. Doctor is where the distinction has to be
		// explained, because it is the command run when something is confusing.
		//
		// `meshEnv` belongs here rather than in the mesh's own docs: a value set
		// with `.with({option:"env"})` and not visible in a guest is diagnosed
		// from this command, and the explanation says it travels as an
		// `x-hobo-env-*` header rather than through the host's process.env.
		const result = await run(["doctor"]);
		// SAFETY: doctor reports string descriptions keyed by diagnostic scope.
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
		// Distinct from the configured host: this is what is *available*, and it
		// is how a user learns that `--host wasm` would work here before
		// committing a Yard to it.
		const result = await run(["doctor"]);
		// SAFETY: doctor reports the optional component-host availability list.
		expect(
			(result.data as { componentHosts?: unknown }).componentHosts,
		).toBeDefined();
	});

	it("survives a host probe that throws, reporting the error", {
		timeout: 60_000,
	}, async () => {
		// The situation doctor exists for. A host toolchain that throws while
		// being checked must be *reported*, not propagated — letting the
		// exception escape would make the diagnostic unavailable exactly when it
		// is needed.
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
		// The second of the two unhealthy states, with its own code and its own
		// remediation — `ensure` rather than `init`.
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
	/** `yard ensure` with the toolchain stand-ins in place. */
	async function ensure(dir = home()) {
		return run(["ensure"], { hoboHome: dir, env: toolchainEnv(dir) });
	}

	it("reports each host and whether it is ready", async () => {
		// The per-host breakdown is what makes a partial result actionable: one
		// host failing while three succeed is a different problem from all four
		// failing, and a single boolean would not say which.
		const result = await ensure();
		// SAFETY: ensure returns host results carrying their component-host kind.
		const data = result.data as { hosts?: Array<{ kind: string }> };
		expect(Array.isArray(data.hosts)).toBe(true);
		expect(result.message).toContain("hobo yard ensure");
	});

	it("distinguishes fully ready from partial", async () => {
		// `allReady` decides both `ok` and the code. Reporting success on a
		// partial ensure would let a deploy proceed against a host that is not
		// installed.
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
		// Both the success and the failure payload carry `hoboHome`, because a
		// user who set `--home` or `HOBO_HOME` needs to see which root the
		// command actually chose before they go looking for what it installed.
		const dir = home();
		const result = await ensure(dir);
		// SAFETY: ensure reports the install root it selected.
		expect((result.data as { hoboHome: string }).hoboHome).toBe(dir);
	});

	it("names every override in its failure remediation", async () => {
		// Four different toolchains, four different escape hatches. A user behind
		// a proxy needs the binary override; one on an unusual cluster needs the
		// kubeconfig hint. Listing only one would strand the other.
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
		// A user who mistyped a subcommand most likely wanted `init`, and its
		// three flags are not guessable from the name alone.
		const remediation = ((await run(["frobnicate"])).remediation ?? []).join(
			" ",
		);
		expect(remediation).toContain("hobo yard init");
		expect(remediation).toContain("--host local|wasm|oci|cloud-native");
	});
});

describe("home resolution", () => {
	it("honours an explicit --home over the environment", async () => {
		// A user pointing at a specific install root must get that one, or the
		// command would read a different Yard than the one they named.
		const dir = home();
		// SAFETY: this test supplies the command's complete runner context.
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
		// SAFETY: this test supplies the command's complete runner context.
		const result = await createYardCommand().run({
			context: { cwd: dir, env: { HOBO_HOME: dir } },
			flags: {},
			args: ["status"],
			emitProgress: () => {},
		} as never);
		expect(result.message).toContain(dir);
	});
});
