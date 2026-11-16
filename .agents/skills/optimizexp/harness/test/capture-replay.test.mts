import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeCast } from "../lib/cast-stats.mts";
import { captureCli } from "../drivers/cli.mts";
import { captureNative } from "../drivers/native.mts";

// CLI captures are honest transcripts (exit code + full output + timing) —
// never synthetic .cast "recordings" (that is how a frozen TUI once got
// certified as replayable). Real recordings come only from the tui driver.
const outDir = mkdtempSync(path.join(tmpdir(), "optimizexp-capture-"));
const result = await captureCli(outDir, {
	command: "printf 'replayable evidence\\n'",
	cwd: process.cwd(),
});
assert.equal(result.kind, "transcript");
assert.match(result.primaryFile, /primary\.txt$/);
assert.equal(result.exitCode, 0);
const transcript = readFileSync(result.primaryFile, "utf8");
assert.match(transcript, /replayable evidence/);

const native = captureNative(mkdtempSync(path.join(tmpdir(), "optimizexp-native-")), {
	command: "exit 7",
	cwd: process.cwd(),
});
assert.equal(native.exitCode, 7);
assert.equal(native.degraded, true);

const repeatedDir = mkdtempSync(path.join(tmpdir(), "optimizexp-native-repeat-"));
const firstNative = captureNative(repeatedDir, {
	command: 'printf first > "$OUT_DIR/frame.png"',
	cwd: process.cwd(),
});
assert.equal(firstNative.kind, "image");
const repeatedNative = captureNative(repeatedDir, {
	command: "true",
	cwd: process.cwd(),
});
assert.equal(repeatedNative.kind, "transcript");

// Perceptual timing is captured and machine-checkable.
assert.equal(typeof result.timing.durationMs, "number");
assert.ok(
	result.timing.timeToFirstOutputMs === null ||
		result.timing.timeToFirstOutputMs >= 0,
);
assert.ok(typeof result.timing.timeToFirstOutputMs === "number");

// Cast analysis: a single-event buffer is distinguishable from a recording.
const syntheticCast = `${JSON.stringify({ version: 2, width: 80, height: 24 })}\n${JSON.stringify([0.5, "o", "all output at once"])}\n`;
const synthetic = analyzeCast(syntheticCast);
assert.ok(synthetic);
assert.equal(synthetic.eventCount, 1);

const realCast = [
	JSON.stringify({ version: 2, width: 80, height: 24 }),
	JSON.stringify([0.1, "o", "frame1"]),
	JSON.stringify([0.25, "o", "frame2"]),
	JSON.stringify([1.5, "o", "frame3"]),
].join("\n");
const real = analyzeCast(realCast);
assert.ok(real);
assert.equal(real.eventCount, 3);
assert.equal(real.firstOutputMs, 100);
assert.equal(real.maxSilentGapMs, 1250);
assert.equal(real.durationMs, 1500);
assert.equal(real.totalOutputBytes, 18);
