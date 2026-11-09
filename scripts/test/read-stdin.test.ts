import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	readStdin,
	STDIN_IDLE_LIMIT_MS,
	STDIN_RETRY_MS,
	type StdinSource,
} from "../lib/read-stdin.mts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const helper = new URL("../lib/read-stdin.mts", import.meta.url).href;
const STRIP = ["--experimental-strip-types", "--no-warnings"];

type Chunk = readonly [atMs: number, bytes: Uint8Array];

/**
 * A writer on a fake clock that only `sleep` moves: each chunk can be read
 * from its time on, and the pipe reads as closed from `closesAtMs`.
 */
function fakeWriter(chunks: readonly Chunk[], closesAtMs: number) {
	let clock = 0;
	let next = 0;
	const sleeps: number[] = [];
	const source: StdinSource = {
		read: (buffer) => {
			const chunk = chunks[next];
			if (chunk !== undefined && chunk[0] <= clock) {
				next += 1;
				buffer.set(chunk[1]);
				return chunk[1].length;
			}
			if (chunk === undefined && closesAtMs <= clock) return 0;
			throw Object.assign(
				new Error("EAGAIN: resource temporarily unavailable, read"),
				{ code: "EAGAIN" },
			);
		},
		sleep: (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		now: () => clock,
	};
	return { source, sleeps, clock: () => clock };
}

const utf8 = (text: string) => Buffer.from(text, "utf8");

describe("readStdin", () => {
	it("sleeps briefly on EAGAIN and reads again until the writer closes", () => {
		const writer = fakeWriter(
			[
				[35, utf8("docs/a.md\n")],
				[70, utf8("packages/core/src/a.ts\n")],
			],
			90,
		);
		assert.equal(
			readStdin(writer.source),
			"docs/a.md\npackages/core/src/a.ts\n",
		);
		assert.deepEqual(writer.sleeps, Array(9).fill(STDIN_RETRY_MS));
	});

	it("decodes after joining reads, so a character split across two survives", () => {
		const e = utf8("é\n");
		const writer = fakeWriter(
			[
				[0, e.subarray(0, 1)],
				[10, e.subarray(1)],
			],
			10,
		);
		assert.equal(readStdin(writer.source), "é\n");
	});

	it("keeps waiting for a writer that is slow but still writing", () => {
		const writer = fakeWriter(
			[
				[20_000, utf8("a\n")],
				[40_000, utf8("b\n")],
				[60_000, utf8("c\n")],
			],
			60_000,
		);
		assert.equal(readStdin(writer.source), "a\nb\nc\n");
	});

	it("gives up with a clear error once nothing has arrived for the limit", () => {
		const writer = fakeWriter([[0, utf8("a\n")]], Number.POSITIVE_INFINITY);
		assert.throws(() => readStdin(writer.source), {
			message:
				/^stdin: nothing arrived for 30 s, and the writer has not closed the pipe$/,
		});
		assert.equal(writer.clock(), STDIN_IDLE_LIMIT_MS);
	});

	it("rethrows any other read error at once", () => {
		const sleeps: number[] = [];
		const source: StdinSource = {
			read: () => {
				throw Object.assign(new Error("EBADF: bad file descriptor, read"), {
					code: "EBADF",
				});
			},
			sleep: (ms) => sleeps.push(ms),
			now: () => 0,
		};
		assert.throws(() => readStdin(source), /EBADF/);
		assert.deepEqual(sleeps, []);
	});
});

type Exit = Readonly<{ status: number | null; stdout: string; stderr: string }>;

type LateWrite = Readonly<{
	/** Written `delayMs` after the trigger, then the pipe is closed. Absent: the pipe stays open and empty. */
	input?: string;
	/** The trigger: this text on the child's stderr. Absent: the spawn. */
	after?: string;
	delayMs: number;
	env?: NodeJS.ProcessEnv;
}>;

/** Runs node with `args` behind a stdin pipe whose writer starts late. */
function runWithLateWriter(
	args: readonly string[],
	late: LateWrite,
): Promise<Exit> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: root,
			env: late.env ?? process.env,
			stdio: "pipe",
		});
		let stdout = "";
		let stderr = "";
		let writer: NodeJS.Timeout | undefined;
		const startWriter = () => {
			writer = setTimeout(() => {
				if (late.input !== undefined) child.stdin.end(late.input);
			}, late.delayMs);
		};
		const guard = setTimeout(() => child.kill(), 20_000);
		// The pipe breaks when the child exits before the writer writes.
		child.stdin.on("error", () => undefined);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
			const triggered = late.after !== undefined && stderr.includes(late.after);
			if (triggered && writer === undefined) startWriter();
		});
		if (late.after === undefined) startWriter();
		child.on("error", reject);
		child.on("close", (status) => {
			clearTimeout(writer);
			clearTimeout(guard);
			child.stdin.destroy();
			resolve({ status, stdout, stderr });
		});
	});
}

/**
 * Node arguments for a child that imports node:process, as the CI scripts do
 * (which puts fd 0 in non-blocking mode), checks that its stdin is empty and
 * non-blocking with one raw read, prints `probe=<code>`, then prints what
 * `read` returns.
 */
function childReading(read: string, probe = true): string[] {
	const lines = [
		'import "node:process";',
		'import { readFileSync, readSync, writeSync } from "node:fs";',
		`import { readStdin } from ${JSON.stringify(helper)};`,
	];
	if (probe) {
		lines.push(
			'let probe = "data";',
			"try { readSync(0, Buffer.alloc(1)); } catch (error) { probe = error.code; }",
			"writeSync(2, `probe=${probe}\\n`);",
		);
	}
	lines.push(`writeSync(1, JSON.stringify(${read}));`);
	return [...STRIP, "--input-type=module", "--eval", lines.join("\n")];
}

describe("stdin on a pipe the writer has not written to yet", () => {
	it("readFileSync(0) fails with EAGAIN: the CI failure", async (t) => {
		const exit = await runWithLateWriter(
			childReading('readFileSync(0, "utf8")'),
			{ delayMs: 1000, input: "x" },
		);
		if (!/^probe=EAGAIN$/m.test(exit.stderr)) {
			// The EAGAIN crash pins a Node/libuv quirk: importing node:process
			// sets O_NONBLOCK on fd 0. Where a future Node or another platform
			// keeps fd 0 blocking, the control case has nothing to control.
			t.skip("fd 0 stayed blocking on this Node/platform");
			return;
		}
		assert.match(exit.stderr, /EAGAIN: resource temporarily unavailable/);
		assert.equal(exit.status, 1);
	});

	it("readStdin waits for the writer and returns everything it wrote", async () => {
		const input = "docs/a.md\npackages/core/src/a.ts\n";
		const exit = await runWithLateWriter(childReading("readStdin()", false), {
			delayMs: 300,
			input,
		});
		assert.equal(exit.status, 0, exit.stderr);
		assert.equal(JSON.parse(exit.stdout), input);
	});

	it("readStdin returns a late write larger than one read chunk", async () => {
		const input = Array.from(
			{ length: 3000 },
			(_v, i) => `packages/core/src/file-${i}.ts\n`,
		).join("");
		assert.ok(Buffer.byteLength(input) > 64 * 1024);
		const exit = await runWithLateWriter(childReading("readStdin()", false), {
			delayMs: 300,
			input,
		});
		assert.equal(exit.status, 0, exit.stderr);
		assert.equal(JSON.parse(exit.stdout), input);
	});
});

describe("the CI scripts that read changed paths from stdin, behind a late writer", {
	concurrency: true,
}, () => {
	const late = { delayMs: 1000, input: "docs/a.md\n" };

	it("job-scope.mts", async () => {
		// An entry that imports node builtins only, so the tree cannot widen the
		// scope: `run=false` means the path arrived, and an empty read runs.
		const exit = await runWithLateWriter(
			[...STRIP, "scripts/ci/job-scope.mts", "scripts/lib/read-stdin.mts"],
			late,
		);
		assert.equal(exit.status, 0, exit.stderr);
		assert.equal(exit.stdout, "run=false\n");
	});

	it("dependent-tests.mts", async () => {
		const exit = await runWithLateWriter(
			[...STRIP, "scripts/ci/dependent-tests.mts"],
			late,
		);
		assert.equal(exit.status, 0, exit.stderr);
		assert.match(exit.stdout, /^dependent-tests: 0 whole suite\(s\)/);
	});

	it("impact-classifier.mts", async () => {
		const exit = await runWithLateWriter(
			[...STRIP, "scripts/ci/impact-classifier.mts"],
			{ ...late, env: { ...process.env, HOBO_IMPACT_GATE: "shadow" } },
		);
		assert.equal(exit.status, 0, exit.stderr);
		assert.deepEqual(JSON.parse(exit.stdout).meaningfulPaths, ["docs/a.md"]);
	});
});
