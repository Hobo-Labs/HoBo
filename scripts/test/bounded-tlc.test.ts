import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertTlcExited, runBoundedTlc } from "../lib/bounded-tlc.ts";

const cwd = process.cwd();

function child(script: string, timeoutMs: number) {
	return runBoundedTlc("fixture.jar", ["-workers", "1"], cwd, {
		executable: process.execPath,
		prefixArgs: ["-e", script, "--"],
		timeoutMs,
	});
}

describe("TLC process bounds", () => {
	it("passes the fixed heap and model arguments to each checker", () => {
		const result = child(
			"process.stdout.write(JSON.stringify(process.argv.slice(1)))",
			5_000,
		);
		assert.equal(result.status, 0);
		assert.deepEqual(JSON.parse(result.stdout), [
			"-XX:+UseParallelGC",
			"-Xmx512m",
			"-cp",
			"fixture.jar",
			"tlc2.TLC",
			"-workers",
			"1",
		]);
	});

	it("kills a checker that never finishes and reports a timeout", () => {
		const result = child("setInterval(() => {}, 1000)", 100);
		const error: NodeJS.ErrnoException | undefined = result.error;
		assert.equal(error?.code, "ETIMEDOUT");
		assert.equal(result.signal, "SIGKILL");
	});

	it("fails instead of accepting output beyond its capture bound", () => {
		const result = child(
			"process.stdout.write(Buffer.alloc(17 * 1024 * 1024))",
			5_000,
		);
		const error: NodeJS.ErrnoException | undefined = result.error;
		assert.equal(error?.code, "ENOBUFS");
	});

	it("rejects a signaled checker even if it printed a counterexample", () => {
		const result = child(
			'require("node:fs").writeSync(1, "Invariant Guard is violated"); process.kill(process.pid, "SIGKILL")',
			5_000,
		);
		assert.match(result.stdout, /Invariant Guard is violated/);
		assert.equal(result.signal, "SIGKILL");
		assert.throws(() => assertTlcExited(result), /without a normal exit/);
	});

	it("does not allow callers to extend or remove the deadline", () => {
		assert.throws(() => child("", 60_001), RangeError);
		assert.throws(() => child("", 0), RangeError);
		assert.throws(() => child("", 1.5), RangeError);
	});
});
