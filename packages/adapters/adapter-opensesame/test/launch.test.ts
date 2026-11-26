import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenSesameAdapterError } from "../src/errors.js";
import { buildLaunch, type RunInput, runProxied } from "../src/launch.js";
import { parsed } from "./fixtures/bindings.js";
import { commandOf, end, identify } from "./support/procs.js";
import { KIT, memoryTrust, SYSTEM } from "./support/trust-fs.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures/fake-opensesame.mts");
const CHILD = join(here, "fixtures/child.mts");

let work = "";
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "hobo-launch-test-"));
});
afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

function codeOf<T>(run: () => T): string {
	try {
		run();
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error.code;
		throw error;
	}
	return "no error";
}

async function codeOfAsync<T>(run: () => Promise<T>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error.code;
		throw error;
	}
	return "no error";
}

const baseEnv = { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" };

/** What the stand-in is told through the environment; the allowlist would leave these behind. */
const FAKE_KNOBS = [
	"FAKE_OPENSESAME_RECORD",
	"FAKE_OPENSESAME_SCENARIO",
	"FAKE_OPENSESAME_STORE_TOKEN",
	"OPENSESAME_STORE_PASSWORD",
];

function launchOf(overrides: Partial<Parameters<typeof buildLaunch>[0]> = {}) {
	return buildLaunch({
		bin: "/opt/opensesame/opensesame",
		schemaPath: "/tmp/x/.env.schema",
		argv: ["node", "app.js", "--flag"],
		bindings: parsed(),
		env: baseEnv,
		nodeVersion: "22.22.0",
		...overrides,
	});
}

function stubInput(overrides: Partial<RunInput> = {}): RunInput {
	return {
		bin: FAKE,
		bindings: parsed(),
		argv: [process.execPath, "--no-warnings", CHILD, join(work, "child.json")],
		env: {
			...baseEnv,
			FAKE_OPENSESAME_RECORD: join(work, "record.json"),
		},
		passEnv: FAKE_KNOBS,
		// Most runs do not need the real `--version` round trip; opensesame-bin.test.ts and the pact do.
		probe: () => ({ status: 0, stdout: "opensesame 0.1.0\n" }),
		stderr: new PassThrough(),
		...overrides,
	};
}

describe("buildLaunch", () => {
	it("argv is exactly [bin, dev, --agent, --schema, file, run, --, ...cmd]", () => {
		const launch = launchOf();
		expect(launch.command).toBe("/opt/opensesame/opensesame");
		expect(launch.args).toEqual([
			"dev",
			"--agent",
			"--schema",
			"/tmp/x/.env.schema",
			"run",
			"--",
			"node",
			"app.js",
			"--flag",
		]);
	});

	it("keeps a command that begins with a dash after the separator", () => {
		const launch = launchOf({ argv: ["-e", "1"] });
		expect(launch.args.slice(-3)).toEqual(["--", "-e", "1"]);
	});

	it("sets NODE_USE_ENV_PROXY=1 and the child marker on the environment it keeps, and adds nothing else", () => {
		const launch = launchOf({
			env: { PATH: "/usr/bin", NODE_NO_WARNINGS: "1", KEEP: "1" },
			trust: memoryTrust(SYSTEM, { cwd: "/work/checkout" }),
		});
		expect(launch.env).toEqual({
			PATH: "/usr/bin",
			NODE_NO_WARNINGS: "1",
			NODE_USE_ENV_PROXY: "1",
			HOBO_OPENSESAME_CHILD: "1",
		});
	});

	it("passes OPENSESAME_ENV_PARSE through when its file exists in a trusted place", () => {
		const launch = launchOf({
			env: { ...baseEnv, OPENSESAME_ENV_PARSE: "/kit/bridge/parse.mjs" },
			trust: memoryTrust(KIT, { cwd: "/work/checkout" }),
		});
		expect(launch.env.OPENSESAME_ENV_PARSE).toBe("/kit/bridge/parse.mjs");
	});

	it("never adds the store passphrase", () => {
		const launch = launchOf();
		expect(JSON.stringify(launch)).not.toMatch(/PASSWORD|PASSPHRASE/iu);
	});

	it("refuses to re-launch inside a child it launched", () => {
		expect(
			codeOf(() =>
				launchOf({ env: { ...baseEnv, HOBO_OPENSESAME_CHILD: "1" } }),
			),
		).toBe("recursion_guard");
	});

	it("refuses a Node that cannot send fetch through HTTPS_PROXY", () => {
		for (const nodeVersion of ["22.20.0", "22.4.1", "20.19.0", "23.11.0"]) {
			expect(
				codeOf(() => launchOf({ nodeVersion })),
				nodeVersion,
			).toBe("node_proxy_unsupported");
		}
		for (const nodeVersion of ["22.21.0", "22.22.0", "24.0.0", "25.1.0"]) {
			expect(
				codeOf(() => launchOf({ nodeVersion })),
				nodeVersion,
			).toBe("no error");
		}
	});

	it("refuses an env-spec bridge that does not exist", () => {
		expect(
			codeOf(() =>
				launchOf({
					env: { ...baseEnv, OPENSESAME_ENV_PARSE: "/nowhere/parse.mjs" },
				}),
			),
		).toBe("bridge_missing");
	});

	it("refuses an empty command", () => {
		expect(codeOf(() => launchOf({ argv: [] }))).toBe("launch_invalid");
	});

	it("refuses a NUL in the command as a typed error, not a TypeError from spawn", () => {
		for (const argv of [["node", "a\0b"], ["no\0de"], ["node", "\0"]]) {
			expect(
				codeOf(() => launchOf({ argv })),
				JSON.stringify(argv),
			).toBe("launch_invalid");
		}
	});

	it("refuses a NUL in a value it would pass on, and does not echo the value", () => {
		const secret = "tok\0en-looking-value";
		let message = "";
		try {
			launchOf({ env: { ...baseEnv, FAKE_X: secret }, passEnv: ["FAKE_X"] });
		} catch (error) {
			message = error instanceof Error ? error.message : "";
		}
		expect(message).not.toBe("");
		expect(message).not.toContain("token-looking");
		expect(message).toContain("FAKE_X");
	});
});

describe("runProxied with a stand-in binary", () => {
	it("writes the schema 0600 in a 0700 directory of its own and removes it after the run", async () => {
		await runProxied(stubInput());
		const record = JSON.parse(readFileSync(join(work, "record.json"), "utf8"));
		expect(record.schemaMode).toBe("600");
		expect(record.schemaDirMode).toBe("700");
		expect(record.schema).toContain("opensesameConnection(conn://acme/vercel");
		expect(existsSync(record.schemaPath)).toBe(false);
		expect(existsSync(dirname(record.schemaPath))).toBe(false);
	});

	it("hands OpenSesame the exact argv and the launch environment", async () => {
		await runProxied(stubInput());
		const record = JSON.parse(readFileSync(join(work, "record.json"), "utf8"));
		expect(record.argv.slice(0, 3)).toEqual(["dev", "--agent", "--schema"]);
		expect(record.argv.slice(4, 6)).toEqual(["run", "--"]);
		expect(record.sawNodeUseEnvProxy).toBe("1");
		expect(record.sawChildMarker).toBe("1");
	});

	it("the passphrase reaches OpenSesame to unlock the store, and never the child, argv or schema", async () => {
		const passphrase = "store-passphrase-for-tests";
		const input = stubInput();
		await runProxied({
			...input,
			env: { ...input.env, OPENSESAME_STORE_PASSWORD: passphrase },
		});
		const record = JSON.parse(readFileSync(join(work, "record.json"), "utf8"));
		const child = JSON.parse(readFileSync(join(work, "child.json"), "utf8"));
		expect(record.sawStorePassword).toBe(true);
		expect(JSON.stringify(record.argv)).not.toContain(passphrase);
		expect(record.schema).not.toContain(passphrase);
		expect(JSON.stringify(child)).not.toContain(passphrase);
		expect(child.env.OPENSESAME_STORE_PASSWORD).toBeUndefined();
	});

	it("the child holds none of the credentials the caller's environment holds, and not the one it listed for OpenSesame", async () => {
		const input = stubInput();
		await runProxied({
			...input,
			env: {
				...input.env,
				OPENSESAME_STORE_PASSWORD: "store-passphrase-for-tests",
				AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
				AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				GITHUB_TOKEN: "ghp_not_a_real_token_0123456789",
				CLOUDFLARE_API_TOKEN: "cf-not-a-real-token",
				NPM_TOKEN: "npm_not_a_real_token",
			},
		});
		const child = JSON.parse(readFileSync(join(work, "child.json"), "utf8"));
		const held = Object.keys(child.env);
		for (const name of [
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"GITHUB_TOKEN",
			"CLOUDFLARE_API_TOKEN",
			"NPM_TOKEN",
			"OPENSESAME_STORE_PASSWORD",
		]) {
			expect(held, name).not.toContain(name);
		}
		expect(JSON.stringify(child)).not.toContain("not-a-real");
	});

	it("OpenSesame is not given the passphrase unless the caller lists it", async () => {
		const input = stubInput();
		await runProxied({
			...input,
			passEnv: ["FAKE_OPENSESAME_RECORD"],
			env: {
				...input.env,
				OPENSESAME_STORE_PASSWORD: "store-passphrase-for-tests",
			},
		});
		const record = JSON.parse(readFileSync(join(work, "record.json"), "utf8"));
		expect(record.sawStorePassword).toBe(false);
	});

	it("refuses to start beside a real credential for the provider it brokers", async () => {
		const input = stubInput({ tmpRoot: work });
		expect(
			await codeOfAsync(() =>
				runProxied({
					...input,
					env: {
						...input.env,
						VERCEL_API_TOKEN: "vtok_dummy_marker_0123456789abcdef",
					},
				}),
			),
		).toBe("real_credential_in_env");
		expect(existsSync(join(work, "record.json"))).toBe(false);
		expect(
			readdirSync(work).filter((n) => n.startsWith("hobo-opensesame-")),
		).toEqual([]);
	});

	it("the child holds an osr_ surrogate and the run exits as the child does", async () => {
		const outcome = await runProxied(stubInput());
		const child = JSON.parse(readFileSync(join(work, "child.json"), "utf8"));
		expect(child.env.VERCEL_TOKEN).toMatch(/^osr_[0-9a-f]{32}$/u);
		expect(child.env.HTTPS_PROXY).toMatch(/^http:\/\//u);
		expect(outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
	});

	it("passes the child's own failing status through", async () => {
		const input = stubInput();
		const outcome = await runProxied({
			...input,
			argv: [...input.argv, "3"],
		});
		expect(outcome).toMatchObject({ kind: "child_exit", exitCode: 3 });
	});

	for (const [scenario, kind, exitCode] of [
		["plugin-absent", "placeholders_only", 0],
		["no-sealed-entry", "placeholders_only", 0],
		["misdirected", "tripwire", 77],
		["sigterm", "signalled", 143],
		["sighup", "signalled", 129],
		["plugin-changed", "plugin_pin_mismatch", 1],
		["wrong-passphrase", "store_unreadable", 1],
		["bridge-no-parser", "bridge_missing", 1],
	] as const) {
		it(`classifies the ${scenario} run as ${kind}`, async () => {
			const input = stubInput();
			const outcome = await runProxied({
				...input,
				env: { ...input.env, FAKE_OPENSESAME_SCENARIO: scenario },
			});
			expect(outcome).toMatchObject({ kind, exitCode });
		});
	}

	// One test per case: each starts OpenSesame's stand-in and the command, which a heavily loaded machine
	// does slowly, and four of them in one test were slower than the lane's deadline for the machine.
	for (const [scenario, kind, exitCode, tail] of [
		["misdirected", "tripwire", 77, "partial"],
		["misdirected", "tripwire", 77, "Working... 40%\r"],
		["sigterm", "signalled", 143, "partial"],
		["sighup", "signalled", 129, "|\r/\r-\r"],
	] as const) {
		it(`a child's unterminated last write does not hide OpenSesame's ${scenario} line, which is printed with no newline before it: ${JSON.stringify(tail)}`, async () => {
			const unterminated = join(work, "unterminated.txt");
			writeFileSync(unterminated, tail);
			const input = stubInput();
			const outcome = await runProxied({
				...input,
				argv: [...input.argv, "0", unterminated],
				env: { ...input.env, FAKE_OPENSESAME_SCENARIO: scenario },
			});
			expect(outcome).toMatchObject({ kind, exitCode });
		});
	}

	it("does not hang on a descendant that holds the stderr pipe open after OpenSesame has ended", async () => {
		const grandchild = join(work, "grandchild.pid");
		const script = `const { spawn } = require("node:child_process");
const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
require("node:fs").writeFileSync(${JSON.stringify(grandchild)}, String(held.pid));
held.unref();`;
		const started = Date.now();
		try {
			const outcome = await runProxied({
				...stubInput(),
				argv: [process.execPath, "-e", script],
				stderrGraceMs: 300,
			});
			expect(outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			try {
				const pid = Number(readFileSync(grandchild, "utf8"));
				// It ends by itself after 20 s and a pid is recycled within seconds: signal it only while it is still the sleeper.
				if (commandOf(pid).includes("20000")) end(identify(pid));
			} catch {
				// Already gone.
			}
		}
	});

	it("a placeholder run leaves the child an ostest_ value, which is not a surrogate", async () => {
		const input = stubInput();
		await runProxied({
			...input,
			env: { ...input.env, FAKE_OPENSESAME_SCENARIO: "plugin-absent" },
		});
		const child = JSON.parse(readFileSync(join(work, "child.json"), "utf8"));
		expect(child.env.VERCEL_TOKEN).toMatch(/^ostest_/u);
		expect(child.env.HTTPS_PROXY).toBeUndefined();
	});

	it("tees OpenSesame's stderr to the caller's stream", async () => {
		const sink = new PassThrough();
		const seen: string[] = [];
		sink.on("data", (chunk) => seen.push(String(chunk)));
		const input = stubInput();
		await runProxied({
			...input,
			stderr: sink,
			env: { ...input.env, FAKE_OPENSESAME_SCENARIO: "plugin-absent" },
		});
		expect(seen.join("")).toContain("delivering placeholders");
	});

	it("reports opensesame_bin_missing when the binary cannot be started", async () => {
		expect(
			await codeOfAsync(() =>
				runProxied(stubInput({ bin: join(work, "no-such-opensesame") })),
			),
		).toBe("opensesame_bin_missing");
	});

	it("removes the schema even when the binary cannot be started", async () => {
		const input = stubInput({
			bin: join(work, "no-such-opensesame"),
			tmpRoot: work,
		});
		await codeOfAsync(() => runProxied(input));
		expect(
			readdirSync(work).filter((n) => n.startsWith("hobo-opensesame-")),
		).toEqual([]);
	});

	it("refuses to run inside a child before writing anything", async () => {
		const input = stubInput({ tmpRoot: work });
		expect(
			await codeOfAsync(() =>
				runProxied({
					...input,
					env: { ...input.env, HOBO_OPENSESAME_CHILD: "1" },
				}),
			),
		).toBe("recursion_guard");
		expect(existsSync(join(work, "record.json"))).toBe(false);
		expect(
			readdirSync(work).filter((n) => n.startsWith("hobo-opensesame-")),
		).toEqual([]);
	});
});
