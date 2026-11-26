import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	describe as describeProc,
	end,
	identify,
	type ProcId,
	running,
} from "./support/procs.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures/fake-opensesame.mts");
const RUNNER = join(here, "fixtures/run-adapter.mts");
const PACKAGE = join(here, "..");

let work = "";
let out = "";
let tmp = "";
/** The command and the stand-in as processes (not as pid numbers, which are recycled within seconds), once the command is up. */
let command: ProcId | undefined;
let standIn: ProcId | undefined;
beforeEach(() => {
	command = undefined;
	standIn = undefined;
	work = mkdtempSync(join(tmpdir(), "hobo-signals-process-"));
	out = join(work, "out");
	tmp = join(work, "tmp");
	mkdirSync(out);
	mkdirSync(tmp);
});
afterEach(() => {
	end(command);
	end(standIn);
	rmSync(work, { recursive: true, force: true });
});

function pidIn(path: string): number | undefined {
	return existsSync(path) ? Number(readFileSync(path, "utf8")) : undefined;
}

async function until(condition: () => boolean, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

type Ended = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
};

/**
 * Run the adapter in a process of its own, signal it once the command is up, and say how it ended.
 * With `hold`, the stand-in is held right after it starts the command (see the fixture) until the
 * signal has been sent and passed on, so the signal reaches it before it has done anything else.
 */
async function signalled(
	signal: NodeJS.Signals,
	hold?: string,
): Promise<Ended> {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		NODE_NO_WARNINGS: "1",
		TMPDIR: tmp,
		RUNNER_PASS_ENV:
			"FAKE_OPENSESAME_SIGNALS,FAKE_OPENSESAME_PIDFILE,FAKE_OPENSESAME_HOLD_AFTER_SPAWN",
		FAKE_OPENSESAME_SIGNALS: join(work, "signals.log"),
		FAKE_OPENSESAME_PIDFILE: join(out, "fake.pid"),
		FAKE_OPENSESAME_HOLD_AFTER_SPAWN: hold,
	};
	const runner = spawn(
		process.execPath,
		["--import", "tsx", RUNNER, FAKE, out],
		{
			cwd: PACKAGE,
			env,
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
	await until(
		() =>
			(pidIn(join(out, "child.pid")) ?? 0) > 1 &&
			(pidIn(join(out, "fake.pid")) ?? 0) > 1,
	);
	command = identify(pidIn(join(out, "child.pid")));
	standIn = identify(pidIn(join(out, "fake.pid")));
	runner.kill(signal);
	if (hold !== undefined) {
		// Long enough for the adapter, which is idle, to pass the signal on; the held stand-in cannot have moved.
		await new Promise((resolve) => setTimeout(resolve, 400));
		writeFileSync(hold, "");
	}
	return await exited;
}

function received(): string[] {
	const log = join(work, "signals.log");
	return existsSync(log)
		? readFileSync(log, "utf8").split("\n").filter(Boolean)
		: [];
}

function schemaDirs(): string[] {
	return readdirSync(tmp).filter((n) => n.startsWith("hobo-opensesame-"));
}

/** Nothing if that process is gone within ten seconds, else what it is (the number alone could be a newer process's by then). */
async function survivor(id: ProcId | undefined): Promise<string | undefined> {
	try {
		await until(() => !running(id), 10_000);
		return undefined;
	} catch {
		return describeProc(id);
	}
}

describe("a real process running the adapter, signalled while its command runs", () => {
	for (const [signal, exitCode] of [
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const) {
		it(`${signal}: OpenSesame is told ${signal}, the command stops, the schema is gone, and the caller gets the outcome`, async () => {
			const ended = await signalled(signal);
			expect(ended.signal).toBeNull();
			expect(ended.code).toBe(0);
			expect(ended.stdout).toContain('"kind":"signalled"');
			expect(ended.stdout).toContain(`"exitCode":${exitCode}`);
			expect(received()).toEqual([signal]);
			expect(schemaDirs()).toEqual([]);
			expect(await survivor(command)).toBeUndefined();
			expect(await survivor(standIn)).toBeUndefined();
		}, 90_000);
	}

	for (const signal of ["SIGINT", "SIGQUIT"] as const) {
		it(`${signal}: OpenSesame is told SIGTERM, the command stops, the schema is gone, and the process still ends by ${signal}`, async () => {
			const ended = await signalled(signal);
			expect(ended.signal).toBe(signal);
			expect(ended.stdout).not.toContain("OUTCOME");
			expect(received()).toEqual(["SIGTERM"]);
			expect(schemaDirs()).toEqual([]);
			expect(await survivor(command)).toBeUndefined();
			expect(await survivor(standIn)).toBeUndefined();
		}, 90_000);
	}

	it("SIGKILL cannot be handled: the schema stays behind, as references only, and OpenSesame and its command keep running", async () => {
		const ended = await signalled("SIGKILL");
		expect(ended.signal).toBe("SIGKILL");
		const left = schemaDirs();
		expect(left).toHaveLength(1);
		const dir = join(tmp, left[0] ?? "missing");
		const schema = join(dir, ".env.schema");
		expect((statSync(schema).mode & 0o777).toString(8)).toBe("600");
		expect((statSync(dir).mode & 0o777).toString(8)).toBe("700");
		const text = readFileSync(schema, "utf8");
		expect(text).toContain("opensesameConnection(conn://acme/vercel");
		expect(text).not.toMatch(/osr_|ostest_|vtok_|Bearer|PASSWORD/u);
		expect(running(command)).toBe(true);
		expect(running(standIn)).toBe(true);
		expect(received()).toEqual([]);
	}, 90_000);
});

describe("a stand-in that is held right after it started the command still hears the signal", () => {
	// The real tool installs its handlers before it starts the command. A stand-in that installs them after is
	// killed by the default action of a signal that arrives in between, which is what a busy machine does to it.
	for (const [signal, heard] of [
		["SIGTERM", "SIGTERM"],
		["SIGHUP", "SIGHUP"],
		["SIGINT", "SIGTERM"],
		["SIGQUIT", "SIGTERM"],
	] as const) {
		it(`${signal}, sent while the stand-in is held: it notes ${heard}, the command stops and the schema is gone`, async () => {
			const ended = await signalled(signal, join(work, "release"));
			if (signal === "SIGTERM" || signal === "SIGHUP") {
				expect(ended.code).toBe(0);
				expect(ended.stdout).toContain('"kind":"signalled"');
			} else {
				expect(ended.signal).toBe(signal);
			}
			expect(received()).toEqual([heard]);
			expect(schemaDirs()).toEqual([]);
			expect(await survivor(command)).toBeUndefined();
			expect(await survivor(standIn)).toBeUndefined();
		}, 90_000);
	}
});
