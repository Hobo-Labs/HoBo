/**
 * The stdio lane: spawning a vendor agent under the sandbox posture.
 *
 * `stdio.test.ts` next door proves the SDK is a real loadable dependency and
 * that the typed gates carry stable codes. This file drives
 * `connectAcpAgentOverStdio` itself against a real child process, because the
 * things worth checking here are all about the spawn rather than the protocol:
 * where the agent runs, what environment it inherits, and whether it stops.
 *
 * **The environment is an allowlist, not a filter.** `scrubEnvironment` builds
 * the child's environment from nothing and copies in only the named keys, so a
 * variable nobody thought about — `AWS_SECRET_ACCESS_KEY`, an `npm` token, an
 * `SSH_AUTH_SOCK` — cannot reach a vendor binary by default. A denylist would
 * have the opposite failure mode: safe only for the leaks someone anticipated.
 *
 * **The agent runs in the workspace, not in the caller's directory.** The cwd
 * comes from the posture's filesystem root. An agent that inherited the
 * caller's cwd would resolve relative paths against whatever directory the
 * Executor happened to be started from.
 *
 * **`dispose` has to actually stop the child.** A handle that returns without
 * killing leaves an agent process holding a pipe for the lifetime of the host.
 *
 * The child here is a `node -e` that parks on stdin — harmless, long-lived, and
 * speaking no protocol, which is fine because these tests never make a protocol
 * call. Each one disposes in a `finally`, so a failing assertion cannot leak a
 * process into the rest of the suite.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "../src/json.js";
import {
	type AgentSandboxPosture,
	SANDBOX_POSTURE_SCHEMA,
	scrubEnvironment,
} from "../src/sandbox.js";
import { connectAcpAgentOverStdio } from "../src/stdio.js";
import type { GovernedAcpClient } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "acp-stdio-"));
	dirs.push(dir);
	return dir;
}

/**
 * Waits for the child to write a file, then returns its contents.
 *
 * The connection owns the child's stdout, so a test cannot read a greeting
 * off the pipe without racing the ndjson parser for it. A file in the
 * workspace is the one channel the child and the test can both see, and
 * polling for it means these tests wait exactly as long as the spawn takes
 * rather than sitting out a fixed sleep that is either flaky or slow.
 */
async function waitForFile(path: string, deadlineMs = 5_000): Promise<string> {
	const started = Date.now();
	for (;;) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			if (Date.now() - started > deadlineMs) {
				throw new Error(`child never wrote ${path} within ${deadlineMs}ms`);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

/** True while a pid names a live process; `kill(pid, 0)` only probes. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(pid: number, deadlineMs = 5_000): Promise<boolean> {
	const started = Date.now();
	while (isAlive(pid)) {
		if (Date.now() - started > deadlineMs) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

/**
 * A child that reports something about itself into the workspace, then parks.
 *
 * `writeFileSync` is handed a bare filename on purpose: a relative path
 * resolves against the child's own cwd, so the file landing in the workspace
 * root is itself the evidence that the spawn chdir'd there.
 */
function reportingAgent(name: string, expression: string): string[] {
	return [
		"-e",
		`require("node:fs").writeFileSync(${JSON.stringify(name)}, ${expression});process.stdin.resume()`,
	];
}

function posture(
	root: string,
	envAllowlist: readonly string[] = [],
): AgentSandboxPosture {
	return {
		schema: SANDBOX_POSTURE_SCHEMA,
		ambientCredentials: false,
		filesystem: { scope: "workspace", root },
		network: { scope: "allowlist", allowlist: [] },
		envAllowlist,
	};
}

/** A governed client that records what the agent asked it for. */
function recordingClient() {
	const seen: string[] = [];
	const client: GovernedAcpClient = {
		async requestPermission() {
			seen.push("requestPermission");
			return { outcome: { outcome: "cancelled" } };
		},
		async sessionUpdate() {
			seen.push("sessionUpdate");
		},
	};
	return { seen, client };
}

/** A child that stays alive on stdin and speaks nothing. */
const PARKED_AGENT = ["-e", "process.stdin.resume()"];

describe("spawning an agent over stdio", () => {
	it("returns a connection and a way to stop it", async () => {
		const handle = await connectAcpAgentOverStdio({
			command: process.execPath,
			args: PARKED_AGENT,
			sandbox: posture(workspace()),
			client: recordingClient().client,
		});
		try {
			expect(handle.connection).toBeDefined();
			expect(handle.dispose).toBeTypeOf("function");
		} finally {
			handle.dispose();
		}
	});

	it("exposes the four protocol calls", async () => {
		// The facade is the structural seam the fixture agent also implements, so
		// vendor adapters and conformance runs stay interchangeable above it.
		const handle = await connectAcpAgentOverStdio({
			command: process.execPath,
			args: PARKED_AGENT,
			sandbox: posture(workspace()),
			client: recordingClient().client,
		});
		try {
			for (const method of [
				"initialize",
				"newSession",
				"prompt",
				"cancel",
			] as const) {
				expect(handle.connection[method]).toBeTypeOf("function");
			}
		} finally {
			handle.dispose();
		}
	});

	it("spawns with no arguments when none are given", async () => {
		// `options.args ?? []` — a command that takes no arguments must not be
		// handed `undefined` as one.
		const handle = await connectAcpAgentOverStdio({
			command: process.execPath,
			args: ["-e", "process.stdin.resume()"],
			sandbox: posture(workspace()),
			client: recordingClient().client,
		});
		handle.dispose();

		const bare = await connectAcpAgentOverStdio({
			command: process.execPath,
			sandbox: posture(workspace()),
			client: recordingClient().client,
		});
		try {
			expect(bare.connection).toBeDefined();
		} finally {
			bare.dispose();
		}
	});

	it("stops the child when disposed", async () => {
		// A handle that returned without killing would leave a vendor agent
		// holding a pipe for the lifetime of the host, so this watches the actual
		// process: the child reports its own pid, and the test waits for that pid
		// to stop answering `kill(pid, 0)`. Asserting only that `dispose()`
		// returned would pass against an empty method body.
		const root = workspace();
		const handle = await connectAcpAgentOverStdio({
			command: process.execPath,
			args: reportingAgent("pid.txt", "String(process.pid)"),
			sandbox: posture(root),
			client: recordingClient().client,
		});
		const pid = Number(await waitForFile(join(root, "pid.txt")));
		expect(isAlive(pid)).toBe(true);

		handle.dispose();
		expect(await waitForExit(pid)).toBe(true);
	});

	it("survives being disposed twice", async () => {
		// Cleanup runs from `finally` blocks and from an outer teardown; a second
		// kill on an already-dead child must not throw.
		const handle = await connectAcpAgentOverStdio({
			command: process.execPath,
			args: PARKED_AGENT,
			sandbox: posture(workspace()),
			client: recordingClient().client,
		});
		handle.dispose();
		expect(() => handle.dispose()).not.toThrow();
	});

	it("does not reject when the command does not exist", async () => {
		// `spawn` reports ENOENT asynchronously on the child, and the module
		// installs an `error` listener precisely so it surfaces on the next
		// protocol call rather than as an unhandled rejection here. Recorded
		// because "the binary is missing" looking like a successful connect is
		// surprising, and the surprise is the design: the typed spawn gate covers
		// the synchronous cases, the stream covers the rest.
		const handle = await connectAcpAgentOverStdio({
			command: join(workspace(), "no-such-agent-binary"),
			sandbox: posture(workspace()),
			client: recordingClient().client,
		});
		try {
			expect(handle.connection).toBeDefined();
		} finally {
			handle.dispose();
		}
	});
});

describe("the environment the agent inherits", () => {
	it("passes through an allowlisted variable", () => {
		expect(
			scrubEnvironment(posture("/tmp", ["WANTED"]), { WANTED: "yes" }),
		).toEqual({ WANTED: "yes" });
	});

	it("drops everything not named", () => {
		// An allowlist, not a denylist: a variable nobody thought about cannot
		// reach a vendor binary. A denylist is safe only for the leaks someone
		// anticipated.
		expect(
			scrubEnvironment(posture("/tmp", ["WANTED"]), {
				WANTED: "yes",
				AWS_SECRET_ACCESS_KEY: "leaked",
				SSH_AUTH_SOCK: "/tmp/agent.sock",
			}),
		).toEqual({ WANTED: "yes" });
	});

	it("passes nothing through an empty allowlist", () => {
		expect(
			scrubEnvironment(posture("/tmp", []), {
				AWS_SECRET_ACCESS_KEY: "leaked",
			}),
		).toEqual({});
	});

	it("omits an allowlisted variable that is not set", () => {
		// Absent stays absent rather than becoming the empty string, which a
		// child would read as "configured, to nothing".
		expect(
			scrubEnvironment(posture("/tmp", ["WANTED", "MISSING"]), {
				WANTED: "yes",
			}),
		).toEqual({ WANTED: "yes" });
	});

	it("keeps an allowlisted variable set to the empty string", () => {
		// Deliberately different from absent: `FOO=` is a choice the operator
		// made, and the check is `!== undefined` rather than truthiness.
		expect(scrubEnvironment(posture("/tmp", ["EMPTY"]), { EMPTY: "" })).toEqual(
			{ EMPTY: "" },
		);
	});
});

describe("where the agent runs", () => {
	it("runs in the workspace root, not the caller's directory", async () => {
		// A child that inherited the caller's cwd would resolve every relative
		// path against whatever directory the Executor happened to start in.
		const root = workspace();
		const handle = await connectAcpAgentOverStdio({
			command: process.execPath,
			args: reportingAgent("cwd.txt", "process.cwd()"),
			sandbox: posture(root),
			client: recordingClient().client,
		});
		try {
			// Two facts at once: the file exists under the workspace root (the
			// relative write resolved there), and its contents name that root.
			expect(await waitForFile(join(root, "cwd.txt"))).toBe(root);
			expect(root).not.toBe(process.cwd());
		} finally {
			handle.dispose();
		}
	});
});

describe("the environment the spawn actually hands the child", () => {
	// The `scrubEnvironment` cases above are the unit; this is the wiring. A
	// spawn that passed `process.env` — or forgot `env` entirely, which makes
	// Node inherit it — would keep every one of those unit tests green while
	// leaking the parent's credentials into a vendor binary.
	it("gives the child only what the posture allowed", async () => {
		const root = workspace();
		process.env.HOBO_ACP_TEST_ALLOWED = "visible";
		process.env.HOBO_ACP_TEST_SECRET = "leaked";
		try {
			const handle = await connectAcpAgentOverStdio({
				command: process.execPath,
				args: reportingAgent("env.json", "JSON.stringify(process.env)"),
				sandbox: posture(root, ["HOBO_ACP_TEST_ALLOWED"]),
				client: recordingClient().client,
			});
			try {
				const childEnv: JsonValue = JSON.parse(
					await waitForFile(join(root, "env.json")),
				);
				expect(childEnv).toMatchObject({ HOBO_ACP_TEST_ALLOWED: "visible" });
				expect(childEnv).not.toHaveProperty("HOBO_ACP_TEST_SECRET");
			} finally {
				handle.dispose();
			}
		} finally {
			delete process.env.HOBO_ACP_TEST_ALLOWED;
			delete process.env.HOBO_ACP_TEST_SECRET;
		}
	});
});
