import { spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CREDENTIAL_BINDINGS_FILE,
	relaunchInputFor,
} from "../src/credentials-opensesame.js";
import { isJsonObject, isJsonString, parseJsonValue } from "../src/json.js";
import { nodeOptionsForRun } from "../src/relaunch-node-options.js";

// C-1 of the #1593 review: the relaunch passed `process.execArgv` on as it was,
// so `node --env-file=.env hobo` re-read the file into the command OpenSesame
// ran, and the command held the file's CLOUDFLARE_API_TOKEN beside its surrogate.

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const FAKE_OPENSESAME = fileURLToPath(
	new URL(
		"../../adapters/adapter-opensesame/test/fixtures/fake-opensesame.mts",
		import.meta.url,
	),
);
const PROBE = fileURLToPath(
	new URL("./fixtures/relaunch-probe.mts", import.meta.url),
);
const CAN_TRUST_PATH =
	process.platform !== "win32" &&
	[0, process.geteuid?.()].includes(statSync("/").uid);
const describeTrustedPath = CAN_TRUST_PATH ? describe : describe.skip;
const ENV_FILE_RELAUNCH = "a relaunch started with node --env-file";

function forRun(execArgv: readonly string[], nodeOptions?: string) {
	return nodeOptionsForRun({
		execArgv,
		nodeOptions,
		cwd: HERE,
		typeScriptLoader: TSX_LOADER,
	});
}

describe("nodeOptionsForRun", () => {
	it("leaves out every option that loads environment or code, by name only", () => {
		const given = [
			"--env-file=/secret/.env",
			"--env-file",
			"/secret/.env",
			"--env-file-if-exists=/secret/.env",
			"-r",
			"dotenv/config",
			"--require=dotenv/config",
			"--import",
			"./instrument.mjs",
			"--loader",
			"tsx",
			"--experimental-loader=tsx",
			"--inspect=0.0.0.0:9229",
			"--experimental-config-file=node.config.json",
		];
		const run = forRun(given);
		expect(run.execArgv).toEqual([]);
		expect(run.left).toEqual([
			"--env-file",
			"--env-file",
			"--env-file-if-exists",
			"-r",
			"--require",
			"--import",
			"--loader",
			"--experimental-loader",
			"--inspect",
			"--experimental-config-file",
		]);
		expect(run.left.join(" ")).not.toMatch(/secret|dotenv|instrument|json/u);
	});

	it("passes on the options that read nothing, and a size only as --name=value", () => {
		const run = forRun([
			"--no-warnings",
			"--enable-source-maps",
			"--max-old-space-size=4096",
			"--use-openssl-ca",
			"--stack-size",
			"2000",
		]);
		expect(run.execArgv).toEqual([
			"--no-warnings",
			"--enable-source-maps",
			"--max-old-space-size=4096",
			"--use-openssl-ca",
		]);
		expect(run.left).toEqual(["--stack-size"]);
	});

	it("passes on --import of hobo's own TypeScript loader, however it is named", () => {
		for (const given of [
			["--import", "tsx"],
			["--import", TSX_LOADER],
			[`--import=${pathToFileURL(TSX_LOADER).href}`],
		]) {
			expect(forRun(given)).toEqual({
				execArgv: given,
				nodeOptions: undefined,
				left: [],
			});
		}
		// Without a loader to match, no --import is passed on.
		expect(
			nodeOptionsForRun({
				execArgv: ["--import", "tsx"],
				nodeOptions: undefined,
				cwd: HERE,
				typeScriptLoader: undefined,
			}).left,
		).toEqual(["--import"]);
	});

	it("reduces NODE_OPTIONS the same way, and leaves out one it would have to unquote", () => {
		expect(forRun([], "--use-openssl-ca  -r dotenv/config")).toEqual({
			execArgv: [],
			nodeOptions: "--use-openssl-ca",
			left: ["-r"],
		});
		expect(forRun([], "--require dotenv/config")).toEqual({
			execArgv: [],
			nodeOptions: undefined,
			left: ["--require"],
		});
		expect(forRun([], '--title "a b"').left).toEqual(["NODE_OPTIONS"]);
		expect(forRun([], "   ").nodeOptions).toBeUndefined();
	});

	it("relaunchInputFor builds the relaunch from the reduced options and environment", () => {
		const input = relaunchInputFor({
			execPath: "/usr/bin/node",
			execArgv: ["--env-file=.env", "--no-warnings"],
			argv: ["/usr/bin/node", "/opt/hobo/bin/hobo.js", "up"],
			env: { NODE_OPTIONS: "--require dotenv/config", PATH: "/usr/bin" },
			cwd: () => HERE,
		});
		expect(input.argv).toEqual([
			"/usr/bin/node",
			"--no-warnings",
			"/opt/hobo/bin/hobo.js",
			"up",
		]);
		expect(input.env).toEqual({ PATH: "/usr/bin" });
		expect(input.leftOut).toEqual(["--env-file", "--require"]);
		expect(input.cwd).toBe(HERE);
	});
});

describeTrustedPath(ENV_FILE_RELAUNCH, () => {
	let root = "";
	let work = "";
	let binDir = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hobo-relaunch-env-file-"));
		work = join(root, "work");
		binDir = join(root, "bin");
		for (const directory of [work, binDir]) {
			mkdirSync(directory, { mode: 0o755 });
			chmodSync(directory, 0o755);
		}
		writeFileSync(
			join(binDir, "node"),
			`#!/bin/sh\nexec '${process.execPath}' "$@"\n`,
		);
		chmodSync(join(binDir, "node"), 0o755);
		writeFileSync(
			join(work, CREDENTIAL_BINDINGS_FILE),
			JSON.stringify({
				bindings: [
					{
						locator: "hobo-token://vercel/deploy",
						connection: "conn://acme/vercel",
						provider: "vercel",
						env_name: "VERCEL_TOKEN",
						paths: ["/v9/projects"],
						methods: ["GET"],
						projection: "legacy-token",
					},
				],
			}),
		);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("gives the command none of the file's variables", async () => {
		const fixture = join(work, "fixture.env");
		const fileVars = {
			CLOUDFLARE_API_TOKEN: "cf_dummy_marker_not_a_secret",
			CLOUDFLARE_ACCOUNT_ID: "acct_dummy",
			ENV_FILE_ONLY_MARKER: "read-from-the-file",
		};
		writeFileSync(
			fixture,
			Object.entries(fileVars)
				.map(([name, value]) => `${name}=${value}\n`)
				.join(""),
		);
		const out = join(work, "command-env.json");
		const stderr: string[] = [];
		const status = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					`--env-file=${fixture}`,
					"--import",
					TSX_LOADER,
					PROBE,
					FAKE_OPENSESAME,
					out,
				],
				{
					cwd: work,
					env: {
						PATH: `${binDir}:${process.env.PATH ?? ""}`,
						HOME: work,
						TMPDIR: work,
						NODE_NO_WARNINGS: "1",
						HOBO_CREDENTIALS: "opensesame",
						FAKE_OPENSESAME_SCENARIO: "surrogate-delivered",
					},
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
			child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
			child.on("error", reject);
			child.on("close", resolve);
		});
		expect(status).toBe(0);
		expect(stderr.join("")).toMatch(
			/^hobo: not passed to the run under OpenSesame: --env-file /mu,
		);
		const parsed = parseJsonValue(readFileSync(out, "utf8"));
		const env = isJsonObject(parsed) ? parsed.env : undefined;
		expect(isJsonObject(env)).toBe(true);
		if (!isJsonObject(env)) return;
		expect(env.HOBO_OPENSESAME_CHILD).toBe("1");
		expect(isJsonString(env.VERCEL_TOKEN)).toBe(true);
		for (const name of Object.keys(fileVars)) {
			expect(env[name], name).toBeUndefined();
		}
	}, 120_000);
});
