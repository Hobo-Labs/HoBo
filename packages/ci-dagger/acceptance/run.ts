import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	type CheckConfig,
	CheckConfigSchema,
} from "../dist/_generated/checks_pb.js";

const { values } = parseArgs({
	options: {
		dagger: { type: "string", default: "dagger" },
		engine: { type: "string", default: "local" },
		version: { type: "string", default: "1.0.0-beta.21" },
		output: { type: "string" },
	},
});
const root = await mkdtemp(join(tmpdir(), "hobo-dagger-acceptance-"));
const workspace = join(root, "workspace");
const configPath = join(root, ".hobo", "dagger.json");
const cli = fileURLToPath(new URL("../dist/check-cli.js", import.meta.url));
const lines = [
	"# Dagger native CLI acceptance",
	"",
	`- CLI version: ${values.version}`,
	`- Engine: ${values.engine}`,
	"- Real Dagger engine and container commands; no Cloud account.",
	"",
];
try {
	await cp(new URL("./workspace/", import.meta.url), workspace, {
		recursive: true,
	});
	await mkdir(join(root, ".hobo"));
	await mkdir(join(root, "account", "dagger"), { recursive: true });
	await writeFile(
		join(root, "account", "dagger", "credentials.json"),
		"invalid acceptance login",
	);
	await writeFile(join(root, "account", "config.toml"), "[modules]\n");
	execFileSync("git", ["init", "--quiet", root]);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		INIT_CWD: root,
		XDG_CONFIG_HOME: join(root, "account"),
		DAGGER_CONFIG: join(root, "account", "config.toml"),
		DAGGER_CLOUD_TOKEN: "invalid-local-acceptance-sentinel",
		DAGGER_CLOUD_ENGINE: "1",
		DAGGER_ENGINE: "cloud",
		DAGGER_ENV: "nonexistent-parent-overlay",
		DAGGER_SESSION_PORT: "1",
		DAGGER_SESSION_TOKEN: "invalid-session-sentinel",
	};

	async function invoke(
		args: string[],
		interrupt?: NodeJS.Signals,
	): Promise<{ code: number; output: string }> {
		return new Promise((done, reject) => {
			const child = spawn(
				process.execPath,
				[cli, "--dagger", values.dagger, ...args],
				{
					cwd: root,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			let signalled = false;
			let escalation: ReturnType<typeof setTimeout> | undefined;
			const watchdog = setTimeout(() => {
				child.kill("SIGTERM");
				escalation = setTimeout(() => child.kill("SIGKILL"), 10_000);
			}, 180_000);
			const observe = (chunk: Buffer) => {
				output += chunk.toString();
				if (output.length > 8 * 1024 * 1024) child.kill("SIGTERM");
				if (
					interrupt &&
					!signalled &&
					/\|\s*HOBO_DAGGER_SLOW(?:\r?\n|$)/.test(output)
				) {
					signalled = true;
					child.kill(interrupt);
				}
			};
			child.stdout.on("data", observe);
			child.stderr.on("data", observe);
			child.once("error", reject);
			child.once("close", (code) => {
				clearTimeout(watchdog);
				clearTimeout(escalation);
				if (interrupt && !signalled) {
					reject(
						new Error(
							`slow check did not start before interruption: ${output.slice(-4000)}`,
						),
					);
				} else {
					done({ code: code ?? 1, output });
				}
			});
		});
	}

	async function check(
		name: string,
		changes: Partial<Omit<CheckConfig, "$typeName" | "$unknown">>,
		expectedCode: number,
		interrupt?: NodeJS.Signals,
	): Promise<string> {
		await writeFile(
			configPath,
			toJsonString(
				CheckConfigSchema,
				create(CheckConfigSchema, {
					engine: values.engine,
					cliVersion: values.version,
					workspace: "workspace",
					filters: ["dag://smoke/passing"],
					parallel: 1,
					timeoutSeconds: 90,
					...changes,
				}),
			),
		);
		const result = await invoke([], interrupt);
		assert.equal(
			result.code,
			expectedCode,
			`${name}\n${result.output.slice(-6000)}`,
		);
		const line = `PASS: ${name} (exit ${result.code})`;
		lines.push(`- ${line}`);
		console.log(line);
		return result.output;
	}

	await writeFile(
		configPath,
		toJsonString(
			CheckConfigSchema,
			create(CheckConfigSchema, {
				engine: values.engine,
				cliVersion: values.version,
				workspace: "workspace",
			}),
		),
	);
	const plan = await invoke(["--plan"]);
	assert.equal(plan.code, 0, plan.output);
	assert.ok(JSON.parse(plan.output).args.includes("check"));
	lines.push("- PASS: compiled CLI plan");
	console.log("PASS: compiled CLI plan");

	const passing = await check(
		"real container check with isolated Cloud/session credentials",
		{},
		0,
	);
	assert.match(passing, /HOBO_DAGGER_PASS/);
	await check(
		"failing container check preserves Dagger failure",
		{ filters: ["dag://smoke/failing"] },
		1,
	);
	await check(
		"excluded failures do not execute",
		{
			filters: [],
			skip: ["dag://smoke/failing", "dag://smoke/slow", "dag://smoke/overlay"],
		},
		0,
	);
	await check(
		"missing check filter fails closed",
		{ filters: ["dag://smoke/missing"] },
		1,
	);
	await check(
		"named CI environment overlay",
		{ environment: "ci", filters: ["dag://smoke/overlay"] },
		0,
	);
	await check(
		"omitted overlay retains workspace defaults",
		{ filters: ["dag://smoke/overlay"] },
		1,
	);
	await writeFile(join(workspace, "input.txt"), "changed uncommitted input\n");
	await check("uncommitted workspace changes are checked", {}, 1);
	await writeFile(join(workspace, "input.txt"), "hobo acceptance\n");
	await check("check succeeds after restoring workspace input", {}, 0);
	await check(
		"overall timeout stops the CLI",
		{ timeoutSeconds: 2, filters: ["dag://smoke/slow"] },
		124,
	);
	await check(
		"SIGINT forwards cancellation",
		{ timeoutSeconds: 30, filters: ["dag://smoke/slow"] },
		130,
		"SIGINT",
	);
	await check(
		"SIGTERM forwards cancellation",
		{ timeoutSeconds: 30, filters: ["dag://smoke/slow"] },
		143,
		"SIGTERM",
	);
	await writeFile(join(workspace, "dagger.toml"), "[modules]\n");
	await check("workspace without checks fails closed", { filters: [] }, 1);
	assert.equal(
		await readFile(join(root, "account", "dagger", "credentials.json"), "utf8"),
		"invalid acceptance login",
	);
	lines.push("", "All acceptance scenarios passed.");
	if (values.output)
		await writeFile(resolve(values.output), `${lines.join("\n")}\n`);
	console.log("All native Dagger acceptance scenarios passed.");
} finally {
	await rm(root, { recursive: true, force: true });
}
