import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeCast } from "../lib/cast-stats.mts";
import { captureCli } from "../drivers/cli.mts";
import { captureNative } from "../drivers/native.mts";
import { captureTui } from "../drivers/tui.mts";
import { tryStitchFrames } from "../lib/media.mts";

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

const missingRoot = mkdtempSync(path.join(tmpdir(), "optimizexp-capture-missing-shell-"));
try {
	const missing = await captureCli(missingRoot, { command: "printf unreachable", cwd: missingRoot, env: { PATH: path.join(missingRoot, "missing") } });
	assert.equal(missing.exitCode, null);
	assert.equal(missing.degraded, true);
	assert.match(missing.stderr, /spawn error:.*ENOENT/);
	assert.equal(readFileSync(missing.primaryFile, "utf8"), missing.combined);
	writeFileSync(missing.primaryFile, "sentinel after capture resolved");
	writeFileSync(path.join(missingRoot, "terminal.txt"), "terminal sentinel after capture resolved");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(readFileSync(missing.primaryFile, "utf8"), "sentinel after capture resolved");
	assert.equal(readFileSync(path.join(missingRoot, "terminal.txt"), "utf8"), "terminal sentinel after capture resolved");
} finally {
	rmSync(missingRoot, { recursive: true, force: true });
}

const native = captureNative(mkdtempSync(path.join(tmpdir(), "optimizexp-native-")), {
	command: "exit 7",
	cwd: process.cwd(),
});
assert.equal(native.exitCode, 7);
assert.equal(native.degraded, true);

const pathRoot = mkdtempSync(path.join(tmpdir(), "optimizexp-capture-path-"));
try {
	const bin = path.join(pathRoot, "bin");
	const project = path.join(pathRoot, "project");
	mkdirSync(bin);
	mkdirSync(project);
	writeFileSync(path.join(pathRoot, "marker.txt"), "ROOT");
	writeFileSync(path.join(project, "marker.txt"), "PROJECT");
	writeFileSync(path.join(bin, "hobo-capture-probe"), '#!/bin/sh\nprintf "PATH_OK:"\ncat marker.txt\n', { mode: 0o755 });
	writeFileSync(path.join(bin, "asciinema"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --command) cmd="$2"; shift 2;;
    --idle-time-limit) shift 2;;
    rec|--overwrite) shift;;
    *) out="$1"; shift;;
  esac
done
captured="$(sh -c "$cmd")" || exit 1
printf '{"version":2,"width":80,"height":24}\\n[0.1,"o","%s"]\\n[0.2,"o","done"]\\n' "$captured" > "$out"
`, { mode: 0o755 });
	const selectedPath = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
	const pathCli = await captureCli(path.join(pathRoot, "cli"), { command: "hobo-capture-probe", cwd: project, env: { PATH: selectedPath } });
	assert.equal(pathCli.exitCode, 0);
	assert.equal(pathCli.stdout, "PATH_OK:PROJECT");
	const pathTui = await captureTui(path.join(pathRoot, "tui"), { command: "hobo-capture-probe", cwd: project, env: { PATH: selectedPath } });
	assert.equal(pathTui.kind, "recording");
	assert.equal(pathTui.degraded, false);
	assert.match(readFileSync(pathTui.primaryFile, "utf8"), /PATH_OK:PROJECT/);
	const originalPath = process.env.PATH;
	try {
		process.env.PATH = selectedPath;
		const pathNative = captureNative(path.join(pathRoot, "native"), { command: 'hobo-capture-probe > "$OUT_DIR/frame.png"', cwd: project });
		assert.equal(pathNative.exitCode, 0);
		assert.equal(readFileSync(pathNative.primaryFile, "utf8"), "PATH_OK:PROJECT");
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
} finally {
	rmSync(pathRoot, { recursive: true, force: true });
}

const stitchRoot = mkdtempSync(path.join(tmpdir(), "optimizexp-stitch-test-"));
const previousCwd = process.cwd();
const previousPath = process.env.PATH;
const previousLog = process.env.HOBO_STITCH_TEST_LOG;
try {
	const bin = path.join(stitchRoot, "bin");
	const frames = path.join(stitchRoot, "frames");
	const log = path.join(stitchRoot, "ffmpeg.log");
	mkdirSync(bin);
	mkdirSync(frames);
	writeFileSync(path.join(frames, "one.png"), "frame one");
	writeFileSync(path.join(frames, "two.png"), "frame two");
	writeFileSync(path.join(frames, "_list.txt"), "preserve this user file\n");
	writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-i" ]; then list="$2"; shift 2; else out="$1"; shift; fi
done
[ -f "$list" ] || exit 3
printf '%s\\n' "$list" >> "$HOBO_STITCH_TEST_LOG"
cat "$list" >> "$HOBO_STITCH_TEST_LOG"
case "$out" in *.mp4) exit 1;; *.gif) printf 'GIF_OK' > "$out";; esac
`, { mode: 0o755 });
	process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
	process.env.HOBO_STITCH_TEST_LOG = log;
	process.chdir(stitchRoot);
	assert.deepEqual(tryStitchFrames("frames", "output"), { file: "output.gif", kind: "gif" });
	assert.equal(readFileSync("output.gif", "utf8"), "GIF_OK");
	assert.equal(readFileSync("frames/_list.txt", "utf8"), "preserve this user file\n");
	const calls = readFileSync(log, "utf8").split("\n");
	const lists = calls.filter((line) => line.endsWith("/frames.txt"));
	assert.equal(lists.length, 2);
	assert.equal(lists[0], lists[1]);
	assert.ok(!existsSync(lists[0]!));
	assert.ok(calls.includes(`file '${path.join(frames, "one.png")}'`));
	assert.ok(calls.includes(`file '${path.join(frames, "two.png")}'`));
} finally {
	process.chdir(previousCwd);
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	if (previousLog === undefined) delete process.env.HOBO_STITCH_TEST_LOG;
	else process.env.HOBO_STITCH_TEST_LOG = previousLog;
	rmSync(stitchRoot, { recursive: true, force: true });
}

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
