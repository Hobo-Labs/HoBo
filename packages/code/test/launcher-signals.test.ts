import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ENDING_SIGNALS } from "../bin/ending-signals.mjs";
import { forwardSignal, launcherSignals } from "../bin/launcher-signals.mjs";
import { testEnv } from "./test-env.js";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

describe("the signals that end hobo-code", () => {
	it("are the four its declaration names, in its order", () => {
		const declared: readonly ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] =
			ENDING_SIGNALS;
		expect(declared).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
		expect(Object.isFrozen(ENDING_SIGNALS)).toBe(true);
	});
});

describe("which signals hobo-code's launcher passes on", () => {
	it("passes on the four that end hobo-code where its child has a session of its own", () => {
		for (const platform of ["linux", "darwin", "freebsd"] as const) {
			expect(launcherSignals(platform)).toEqual({
				listen: ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"],
				forward: true,
			});
		}
	});

	it("passes nothing on on Windows, where passing one on is a forced kill, and only waits for its child", () => {
		// The child shares the console and gets Ctrl-C itself. The launcher
		// listens only so that the console's Ctrl-C and Ctrl-Break, which would
		// end it, leave it waiting instead.
		expect(launcherSignals("win32")).toEqual({
			listen: ["SIGINT", "SIGBREAK"],
			forward: false,
		});
	});
});

const roots: string[] = [];
const pids: number[] = [];
afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone, as it should be.
		}
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function until(done: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

interface Launched {
	/** The ending signals the stand-in child got, in order. */
	readonly got: readonly string[];
	/** The launcher's status. */
	readonly code: number | null;
	readonly output: string;
}

/**
 * Run the real launcher (this package's `bin/`, copied beside a stand-in
 * `dist/bin/hobo-code.js`) as `platform` would, send it SIGINT, and then end
 * the child by sending it SIGTERM directly. The stand-in records each ending
 * signal it gets and exits 3 on SIGTERM.
 *
 * The launcher's own listener runs first; a marker listener added after it
 * says it has run, so the SIGINT it passed on, if any, was sent before the
 * child's SIGTERM, and is recorded first. With no listener of its own the
 * launcher would have ended by the SIGINT.
 */
async function launchThenInterrupt(
	platform: "linux" | "win32",
): Promise<Launched> {
	const root = mkdtempSync(join(tmpdir(), "hobo-code-launcher-"));
	roots.push(root);
	const pkg = join(root, "pkg");
	cpSync(bin, join(pkg, "bin"), { recursive: true });
	mkdirSync(join(pkg, "dist", "bin"), { recursive: true });
	writeFileSync(join(pkg, "dist", "cli.js"), "");
	const at = (name: string): string => join(root, name);
	writeFileSync(
		join(pkg, "dist", "bin", "hobo-code.js"),
		`import { appendFileSync, writeFileSync } from "node:fs";
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
	process.on(signal, () => {
		appendFileSync(${JSON.stringify(at("got"))}, \`\${signal}\\n\`);
		if (signal === "SIGTERM") process.exit(3);
	});
}
writeFileSync(${JSON.stringify(at("child"))}, String(process.pid));
setInterval(() => {}, 1000);
`,
	);
	const preload = at("preload.mjs");
	writeFileSync(
		preload,
		`import { writeFileSync } from "node:fs";
${platform === "win32" ? 'Object.defineProperty(process, "platform", { value: "win32" });\n' : ""}// Once the launcher listens for SIGINT, listen after it.
const waiting = setInterval(() => {
	if (process.listenerCount("SIGINT") === 0) return;
	clearInterval(waiting);
	process.on("SIGINT", () => writeFileSync(${JSON.stringify(at("handled"))}, ""));
	writeFileSync(${JSON.stringify(at("listening"))}, "");
}, 10);
`,
	);
	const run = spawn(
		process.execPath,
		["--import", preload, join(pkg, "bin", "hobo-code.mjs")],
		{
			env: testEnv({
				PATH: process.env.PATH ?? "",
				HOBO_CODE_SKIP_STALE_REBUILD: "1",
				NODE_NO_WARNINGS: "1",
			}),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (run.pid !== undefined) pids.push(run.pid);
	let output = "";
	run.stdout.on("data", (chunk) => {
		output = `${output}${chunk}`;
	});
	run.stderr.on("data", (chunk) => {
		output = `${output}${chunk}`;
	});
	let code: number | null = null;
	let closed = false;
	run.once("close", (status) => {
		code = status;
		closed = true;
	});
	const started = await until(
		() => closed || (existsSync(at("child")) && existsSync(at("listening"))),
		30_000,
	);
	if (!started || closed)
		throw new Error(`the launcher did not start:\n${output}`);
	const child = Number(readFileSync(at("child"), "utf8"));
	pids.push(child);
	run.kill("SIGINT");
	if (!(await until(() => closed || existsSync(at("handled")), 30_000)))
		throw new Error(`the launcher never handled SIGINT:\n${output}`);
	process.kill(child, "SIGTERM");
	await until(() => closed, 30_000);
	return {
		got: existsSync(at("got"))
			? readFileSync(at("got"), "utf8").split("\n").filter(Boolean)
			: [],
		code,
		output,
	};
}

describe.skipIf(process.platform === "win32")(
	"hobo-code's launcher acts on that choice",
	() => {
		it("passes SIGINT on to its child, and ends with the child's status", async () => {
			const launched = await launchThenInterrupt("linux");
			expect(launched.got, launched.output).toEqual(["SIGINT", "SIGTERM"]);
			expect(launched.code, launched.output).toBe(3);
		}, 60_000);

		it("as on Windows, passes nothing on, outlives the SIGINT, and ends with the child's status", async () => {
			const launched = await launchThenInterrupt("win32");
			expect(launched.got, launched.output).toEqual(["SIGTERM"]);
			expect(launched.code, launched.output).toBe(3);
		}, 60_000);
	},
);

describe("how hobo-code's launcher passes a signal on", () => {
	const child = () => {
		const killed: string[] = [];
		return { pid: 4242, kill: (signal: string) => killed.push(signal), killed };
	};

	it("signals the child's process group, so what the child started gets it too", () => {
		const target = child();
		const sent: string[] = [];
		forwardSignal(target, "SIGTERM", (pid, signal) =>
			sent.push(`${pid} ${signal}`),
		);
		expect(sent).toEqual(["-4242 SIGTERM"]);
		expect(target.killed).toEqual([]);
	});

	it("signals the child alone when it leads no such group", () => {
		const target = child();
		forwardSignal(target, "SIGHUP", () => {
			throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
		});
		expect(target.killed).toEqual(["SIGHUP"]);
	});

	it("signals the child alone on any other failure, and never throws", () => {
		// It runs in the launcher's signal handler: a throw there ended the
		// launcher before its child, with the signal passed on to no one.
		const target = child();
		expect(() =>
			forwardSignal(target, "SIGINT", () => {
				throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
			}),
		).not.toThrow();
		expect(target.killed).toEqual(["SIGINT"]);
	});

	it("never throws when the child cannot be signalled alone either", () => {
		const target = {
			pid: 4242,
			kill: (): never => {
				throw Object.assign(new Error("kill ENOSYS"), { code: "ENOSYS" });
			},
		};
		expect(() =>
			forwardSignal(target, "SIGHUP", () => {
				throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
			}),
		).not.toThrow();
	});
});
