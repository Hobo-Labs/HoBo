/**
 * A real process running the adapter against the real opensesame, signalled
 * while the command runs. The unit tests pass a signal to a stub; only this says
 * what the real binary and the real child do with it, and what is left behind.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { end, identify, type ProcId } from "../support/procs.js";
import { type Kit, resolveKit } from "./kit.js";
import { SANDBOX_PASS_ENV, Sandbox } from "./sandbox.js";
import { canReadProcesses, processesNaming } from "./sweep.js";
import { startUpstream, type Upstream } from "./tls.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(here, "../fixtures/run-adapter.mts");
const PACKAGE = join(here, "../..");

let kit: Kit;
const sandboxes: Sandbox[] = [];
const upstreams: Upstream[] = [];
const leftovers = new Set<ProcId>();

beforeAll(() => {
	kit = resolveKit(process.env);
});

afterEach(async () => {
	// By process, not by number: a pid is recycled within seconds, and a stranger must not be killed for it.
	for (const id of leftovers) end(id);
	leftovers.clear();
	for (const upstream of upstreams.splice(0)) await upstream.close();
	for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

async function until(condition: () => boolean, ms = 60_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

type Ended = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
};

/** Pids of every process that names the run's private temp directory. */
function around(tmp: string): number[] {
	const pids = processesNaming(tmp).map((entry) => Number(entry.split(" ")[0]));
	return [...new Set(pids)];
}

async function run(signal: NodeJS.Signals) {
	expect(canReadProcesses(), "this lane reads /proc").toBe(true);
	const sandbox = Sandbox.create(kit);
	sandboxes.push(sandbox);
	const upstream = await startUpstream(sandbox.pki);
	upstreams.push(upstream);
	sandbox.setUp();
	const tmp = sandbox.path("tmp");
	const out = sandbox.path("out");
	mkdirSync(tmp);
	const runner = spawn(
		process.execPath,
		["--import", "tsx", RUNNER, kit.opensesame, out],
		{
			cwd: PACKAGE,
			env: {
				...sandbox.runEnv(upstream),
				TMPDIR: tmp,
				RUNNER_PASS_ENV: SANDBOX_PASS_ENV.join(","),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	runner.stderr.resume();
	let stdout = "";
	runner.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	const exited = new Promise<Ended>((resolve) => {
		runner.on("exit", (code, exitSignal) =>
			resolve({ code, signal: exitSignal, stdout }),
		);
	});
	await until(() => existsSync(join(out, "child.pid")));
	for (const pid of around(tmp)) {
		const id = identify(pid);
		if (id !== undefined) leftovers.add(id);
	}
	runner.kill(signal);
	const ended = await exited;
	const gone = async () => {
		try {
			await until(() => around(tmp).length === 0, 20_000);
			return true;
		} catch {
			return false;
		}
	};
	return {
		ended,
		tmp,
		out,
		gone,
		schemaDirs: () =>
			readdirSync(tmp).filter((n) => n.startsWith("hobo-opensesame-")),
	};
}

describe("a real process running the adapter under the real opensesame, signalled while its command runs", () => {
	for (const [signal, exitCode] of [
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const) {
		it(`${signal}: the run is revoked, the command stops, the schema is gone, and the caller gets the outcome`, async () => {
			const result = await run(signal);
			expect(result.ended.signal).toBeNull();
			expect(result.ended.code).toBe(0);
			expect(result.ended.stdout).toContain('"kind":"signalled"');
			expect(result.ended.stdout).toContain(`"exitCode":${exitCode}`);
			expect(result.schemaDirs()).toEqual([]);
			expect(await result.gone()).toBe(true);
		});
	}

	for (const signal of ["SIGINT", "SIGQUIT"] as const) {
		it(`${signal}: passed on as SIGTERM, so the run is revoked and the command stops, the schema is gone, and the process still ends by ${signal}`, async () => {
			const result = await run(signal);
			expect(result.ended.signal).toBe(signal);
			expect(result.ended.stdout).not.toContain("OUTCOME");
			expect(result.schemaDirs()).toEqual([]);
			// No OpenSesame, no plugin and no command left holding a surrogate.
			expect(await result.gone()).toBe(true);
		});
	}

	it("SIGKILL cannot be handled: the schema directory stays, as references only, and OpenSesame and its command keep running", async () => {
		const result = await run("SIGKILL");
		expect(result.ended.signal).toBe("SIGKILL");
		const left = result.schemaDirs();
		expect(left).toHaveLength(1);
		const dir = join(result.tmp, left[0] ?? "missing");
		const schema = join(dir, ".env.schema");
		expect((statSync(schema).mode & 0o777).toString(8)).toBe("600");
		expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
		const text = readFileSync(schema, "utf8");
		expect(text).toContain("opensesameConnection(conn://acme/vercel");
		expect(text).not.toMatch(/osr_|ostest_|vtok_|Bearer|PASSWORD/u);
		expect(text).not.toContain(sandboxes[0]?.token ?? "no token");
		expect(around(result.tmp).length).toBeGreaterThan(0);
	});
});
