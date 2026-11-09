import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { runHostProcess, runnerEnvironment } from "../src/bootstrap.js";

it("passes a minimal host environment without outer GitHub context or credentials", () => {
	expect(
		runnerEnvironment({
			PATH: "/bin",
			HOME: "/tmp/test",
			GITHUB_TOKEN: "secret",
			GITHUB_WORKSPACE: "outer",
			RUNNER_TRACKING_ID: "outer",
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
			AWS_ACCESS_KEY_ID: "secret",
			HOBO_CI_WEBHOOK_SECRET: "secret",
		}),
	).toEqual({ PATH: "/bin", HOME: "/tmp/test" });
});
it("terminates a timed-out process group and removes cancellation listeners", async () => {
	const term = process.listenerCount("SIGTERM");
	await expect(
		runHostProcess(
			process.execPath,
			["-e", "setInterval(()=>{},1000)"],
			process.cwd(),
			runnerEnvironment(process.env),
			50,
		),
	).rejects.toThrow(/timed out/);
	expect(process.listenerCount("SIGTERM")).toBe(term);
});
it("allows a persistent listener without timing out based on registration age", async () => {
	await expect(
		runHostProcess(
			process.execPath,
			["-e", "setTimeout(() => {}, 75)"],
			process.cwd(),
			runnerEnvironment(process.env),
			undefined,
		),
	).resolves.toBeUndefined();
});
it("cancels a running host through its abort signal before its execution deadline", async () => {
	const controller = new AbortController();
	const started = Date.now();
	const abort = setTimeout(() => controller.abort(), 50);
	try {
		await expect(
			runHostProcess(
				process.execPath,
				["-e", "setInterval(()=>{},1000)"],
				process.cwd(),
				runnerEnvironment(process.env),
				2000,
				controller.signal,
			),
		).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(1500);
	} finally {
		clearTimeout(abort);
	}
});
it("does not launch a host when its signal is already aborted", async () => {
	await expect(
		runHostProcess(
			"/hobo-missing-command",
			[],
			process.cwd(),
			{},
			undefined,
			AbortSignal.abort(new Error("cancelled before launch")),
		),
	).rejects.toThrow("cancelled before launch");
});
it("forwards parent cancellation to the detached child and waits for shutdown", async () => {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "test/fixtures/cancel-host.ts"],
		{ cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	const stopped = once(child, "exit");
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			if (output.includes("READY")) resolve();
		});
		child.once("error", reject);
		child.once("exit", () => {
			if (!output.includes("READY"))
				reject(new Error("host fixture exited before ready"));
		});
	});
	try {
		await ready;
		child.kill("SIGTERM");
		expect((await stopped)[0]).toBe(1);
		expect(output).toContain("STOPPED");
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});

const TERM_IGNORING_DESCENDANT = `
		process.on("SIGTERM", () => {});
		require("node:fs").writeFileSync(process.argv[1], String(process.pid));
		setInterval(() => {}, 1000);
	`;
const TERM_HONOURING_PARENT = `
		process.on("SIGTERM", () => process.exit(0));
		require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(TERM_IGNORING_DESCENDANT)}, process.argv[1]], {stdio:"ignore"});
		setInterval(() => {
			if (process.argv[2] === "success" && require("node:fs").existsSync(process.argv[1])) process.exit(0);
		}, 10);
	`;
// Production waits 10s before SIGKILL; the escalation is the same at any grace.
const TEST_SHUTDOWN = { graceMs: 300 };

async function withTermIgnoringGroup(
	run: (marker: string, directory: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "hobo-host-group-"));
	const marker = join(directory, "descendant");
	const term = process.listenerCount("SIGTERM");
	const interrupt = process.listenerCount("SIGINT");
	try {
		await run(marker, directory);
		const pid = Number(await readFile(marker, "utf8"));
		const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(
			() => undefined,
		);
		// Killed orphan zombies cannot execute; some container PID 1 processes reap them later.
		if (status)
			expect(
				status.slice(status.lastIndexOf(")") + 2, status.lastIndexOf(")") + 3),
			).toMatch(/[ZX]/);
		expect(process.listenerCount("SIGTERM")).toBe(term);
		expect(process.listenerCount("SIGINT")).toBe(interrupt);
	} finally {
		const pid = Number(await readFile(marker, "utf8").catch(() => "0"));
		if (pid > 0) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* Already stopped. */
			}
		}
		await rm(directory, { recursive: true, force: true });
	}
}

it.each([
	"timeout",
	"success",
])("waits for TERM-ignoring descendants after parent %s", (outcome) =>
	withTermIgnoringGroup(async (marker, directory) => {
		const operation = runHostProcess(
			process.execPath,
			["-e", TERM_HONOURING_PARENT, marker, outcome],
			directory,
			runnerEnvironment(process.env),
			outcome === "timeout" ? 1000 : 15000,
			undefined,
			TEST_SHUTDOWN,
		);
		if (outcome === "timeout")
			await expect(operation).rejects.toThrow(/timed out/);
		else await operation;
	}));

// The stall below must outlast the grace and the confirmation window together.
// Production confirms for 2 s; 1 s still leaves the killed group far more time
// than it takes to go, and stalls 1 s less.
const STALL_SHUTDOWN = { graceMs: 300, confirmMs: 1000 };

it("confirms the killed group even when the event loop stalls across SIGKILL", () =>
	withTermIgnoringGroup(async (marker, directory) => {
		const cancel = new AbortController();
		const operation = runHostProcess(
			process.execPath,
			["-e", TERM_HONOURING_PARENT, marker, "cancel"],
			directory,
			runnerEnvironment(process.env),
			undefined,
			cancel.signal,
			STALL_SHUTDOWN,
		);
		const settled = expect(operation).rejects.toThrow(/timed out/);
		while (!existsSync(marker)) await sleep(10);
		cancel.abort(new Error("cancelled"));
		// A CPU-starved or paused host: no timer runs until both the SIGKILL and
		// the confirmation window have expired, so they come due in one turn.
		const stalledUntil =
			performance.now() +
			STALL_SHUTDOWN.graceMs +
			STALL_SHUTDOWN.confirmMs +
			500;
		while (performance.now() < stalledUntil) {
			/* Block the event loop. */
		}
		await settled;
	}));

it("cleans up cancellation handlers when spawning fails", async () => {
	const term = process.listenerCount("SIGTERM");
	const interrupt = process.listenerCount("SIGINT");
	await expect(
		runHostProcess("/hobo-missing-command", [], process.cwd(), {}, 30000),
	).rejects.toThrow(/ENOENT/);
	expect(process.listenerCount("SIGTERM")).toBe(term);
	expect(process.listenerCount("SIGINT")).toBe(interrupt);
});

it("keeps handling repeated cancellation signals until shutdown is acknowledged", async () => {
	const target =
		'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),250));process.stdout.write("READY");setInterval(()=>{},1000)';
	const program = `
		import {runHostProcess, runnerEnvironment} from "./src/bootstrap.ts";
		try { await runHostProcess(process.execPath, ["-e", ${JSON.stringify(target)}], process.cwd(), runnerEnvironment(process.env), 30000); }
		catch { process.stdout.write("ACK"); process.exitCode = 1; }
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", program],
		{ cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	const stopped = once(child, "exit");
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			if (output.includes("READY")) resolve();
		});
		child.once("error", reject);
		child.once("exit", () => {
			if (!output.includes("READY"))
				reject(new Error("host exited before ready"));
		});
	});
	try {
		await ready;
		child.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 25));
		child.kill("SIGTERM");
		expect((await stopped)[0]).toBe(1);
		expect(output).toContain("ACK");
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});
