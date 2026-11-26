/**
 * The stage-gate runner.
 *
 * This is what turns "CI ran some commands" into a signed, parseable record
 * that a promotion decision is made from. Two classes of failure matter here
 * and both are silent: a check that failed but is recorded as passed, and a
 * record whose artifact/signature evidence describes something other than what
 * was actually built. Every assertion below names which one it prevents.
 *
 * Commands are run for real — `spawnSync` is the unit under test as much as
 * the surrounding logic is — using `process.execPath` so nothing depends on
 * what happens to be installed on PATH. HOBO-825: all writes go to a temp dir.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createCommandInvocation,
	resolveCommandExecutable,
	runStageGate,
	shouldUseCommandShell,
} from "../src/runner.js";
import type { StageGateCheckKind, StageGateDefinition } from "../src/types.js";

const dirs: string[] = [];
function newDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-stage-gate-"));
	dirs.push(dir);
	return dir;
}

const savedEpoch = process.env.SOURCE_DATE_EPOCH;
const savedRunUrl = process.env.GITHUB_RUN_URL;

afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
	if (savedEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
	else process.env.SOURCE_DATE_EPOCH = savedEpoch;
	if (savedRunUrl === undefined) delete process.env.GITHUB_RUN_URL;
	else process.env.GITHUB_RUN_URL = savedRunUrl;
});

/** A check that runs `node -e <script>`, so it works on any machine. */
function nodeCheck(
	checkId: string,
	script: string,
	kind: StageGateCheckKind = "lint",
) {
	return { checkId, kind, command: [process.execPath, "-e", script] as const };
}

function gate(
	checks: StageGateDefinition["checks"],
	gateId = "gate-test",
): StageGateDefinition {
	return { gateId, checks };
}

describe("resolveCommandExecutable", () => {
	it("passes non-Windows executables through untouched", () => {
		// The whole pnpm dance is a Windows-only workaround; applying it anywhere
		// else would silently rewrite the command CI was told to run.
		expect(resolveCommandExecutable("pnpm", "linux", {})).toBe("pnpm");
		expect(resolveCommandExecutable("pnpm", "darwin", {})).toBe("pnpm");
		expect(resolveCommandExecutable("node", "win32", {})).toBe("node");
	});

	it("falls back to corepack when no pnpm.cmd is on the Windows search path", () => {
		// Not finding pnpm must not mean "run nothing" or "run a bare `pnpm` that
		// Windows cannot exec" — corepack is the documented fallback.
		expect(resolveCommandExecutable("pnpm", "win32", {})).toBe("corepack");
		expect(
			resolveCommandExecutable("pnpm", "win32", {
				PATH: "C:\\does\\not\\exist",
			}),
		).toBe("corepack");
	});

	it("finds pnpm.cmd under PNPM_HOME, PATH or Path", () => {
		const dir = newDir();
		writeCmd(dir, "pnpm.cmd");
		const expected = join(dir, "pnpm.cmd");
		expect(resolveCommandExecutable("pnpm", "win32", { PNPM_HOME: dir })).toBe(
			expected,
		);
		expect(resolveCommandExecutable("pnpm", "win32", { PATH: dir })).toBe(
			expected,
		);
		// Windows spells it `Path`; reading only `PATH` would send every Windows
		// runner down the corepack fallback.
		expect(resolveCommandExecutable("pnpm", "win32", { Path: dir })).toBe(
			expected,
		);
	});

	it("prefers PNPM_HOME over PATH", () => {
		const home = newDir();
		const path = newDir();
		writeCmd(home, "pnpm.cmd");
		writeCmd(path, "pnpm.cmd");
		expect(
			resolveCommandExecutable("pnpm", "win32", {
				PNPM_HOME: home,
				PATH: path,
			}),
		).toBe(join(home, "pnpm.cmd"));
	});

	it("skips a node_modules/.bin shim in favour of a real pnpm", () => {
		const shimRoot = join(newDir(), "node_modules", ".bin");
		const realRoot = newDir();
		writeCmd(shimRoot, "pnpm.cmd");
		writeCmd(realRoot, "pnpm.cmd");
		// The local shim re-enters the same workspace's package manager and
		// deadlocks or recurses; the search deliberately walks past it.
		expect(
			resolveCommandExecutable("pnpm", "win32", {
				PATH: [shimRoot, realRoot].join(delimiter),
			}),
		).toBe(join(realRoot, "pnpm.cmd"));
	});

	it("falls back to corepack when the only candidate is a shim", () => {
		const shimRoot = join(newDir(), "node_modules", ".bin");
		writeCmd(shimRoot, "pnpm.cmd");
		expect(resolveCommandExecutable("pnpm", "win32", { PATH: shimRoot })).toBe(
			"corepack",
		);
	});

	it("matches the shim path case-insensitively and through backslashes", () => {
		const shimRoot = join(newDir(), "NODE_MODULES", ".BIN");
		writeCmd(shimRoot, "pnpm.cmd");
		// Windows paths arrive with either separator and any casing; a
		// case-sensitive forward-slash-only check would miss the shim it exists
		// to avoid.
		expect(resolveCommandExecutable("pnpm", "win32", { PATH: shimRoot })).toBe(
			"corepack",
		);
	});

	it("ignores empty PATH entries", () => {
		const dir = newDir();
		writeCmd(dir, "pnpm.cmd");
		// Note `delimiter`, not a literal ";". The resolver splits on
		// `node:path`'s delimiter, which is the *host* platform's, even though
		// the function takes an explicit `platform` argument — so a Windows PATH
		// simulated on a POSIX host does not split the way Windows would. That
		// only affects simulation: in production this code path runs only when
		// `platform === "win32"`, where the two agree. Pinned so a reader of this
		// test does not conclude the resolver is host-independent.
		expect(
			resolveCommandExecutable("pnpm", "win32", {
				PATH: `${delimiter}${delimiter}${dir}${delimiter}${delimiter}`,
			}),
		).toBe(join(dir, "pnpm.cmd"));
	});
});

describe("shouldUseCommandShell", () => {
	it("is true only for .bat/.cmd on win32", () => {
		// `.cmd` files are not executables — CreateProcess cannot run them
		// directly, so skipping the shell here produces ENOENT for every pnpm
		// check on Windows.
		expect(shouldUseCommandShell("pnpm.cmd", "win32")).toBe(true);
		expect(shouldUseCommandShell("thing.BAT", "win32")).toBe(true);
		expect(shouldUseCommandShell("node.exe", "win32")).toBe(false);
		expect(shouldUseCommandShell("node", "win32")).toBe(false);
		// And never off Windows, where wrapping in cmd.exe would fail outright.
		expect(shouldUseCommandShell("pnpm.cmd", "linux")).toBe(false);
	});
});

describe("createCommandInvocation", () => {
	it("passes a plain command through on POSIX", () => {
		const invocation = createCommandInvocation("node", ["-e", "1"], "linux");
		expect(invocation).toEqual({ executable: "node", args: ["-e", "1"] });
		// No `windowsVerbatimArguments` key at all — setting it to `false`
		// explicitly is equivalent here, but its absence is what tells a reader
		// the shell path was not taken.
		expect(invocation.windowsVerbatimArguments).toBeUndefined();
	});

	it("copies the args array so a caller cannot mutate the invocation", () => {
		const args = ["-e", "1"];
		const invocation = createCommandInvocation("node", args, "linux");
		args.push("--evil");
		expect(invocation.args).toEqual(["-e", "1"]);
	});

	it("prepends pnpm as an argument when falling back to corepack", () => {
		// `corepack run`-style dispatch: the subcommand has to move into argv or
		// corepack would run its own default.
		expect(
			createCommandInvocation("pnpm", ["run", "lint"], "win32", "cmd.exe", {}),
		).toEqual({ executable: "corepack", args: ["pnpm", "run", "lint"] });
	});

	it("wraps a resolved .cmd in ComSpec with verbatim arguments", () => {
		const dir = newDir();
		writeCmd(dir, "pnpm.cmd");
		const resolved = join(dir, "pnpm.cmd");
		const invocation = createCommandInvocation(
			"pnpm",
			["run", "lint"],
			"win32",
			"C:\\Windows\\System32\\cmd.exe",
			{ PNPM_HOME: dir },
		);
		expect(invocation.executable).toBe("C:\\Windows\\System32\\cmd.exe");
		// `/d /s /c` plus the whole command re-quoted as one argument is the only
		// shape cmd.exe parses correctly when the path itself contains spaces.
		expect(invocation.args).toEqual([
			"/d",
			"/s",
			"/c",
			`""${resolved}" "run" "lint""`,
		]);
		// Without verbatim arguments Node re-quotes what is already quoted and
		// cmd.exe receives a mangled command line.
		expect(invocation.windowsVerbatimArguments).toBe(true);
	});

	it("escapes embedded quotes in shell arguments", () => {
		const dir = newDir();
		writeCmd(dir, "pnpm.cmd");
		const invocation = createCommandInvocation(
			"pnpm",
			['say "hi"'],
			"win32",
			"cmd.exe",
			{ PNPM_HOME: dir },
		);
		// An unescaped quote terminates the argument early, so the tail of a
		// check command would be interpreted as separate commands by cmd.exe.
		expect(invocation.args[3]).toContain('\\"hi\\"');
	});

	it("defaults ComSpec to cmd.exe", () => {
		const dir = newDir();
		writeCmd(dir, "pnpm.cmd");
		// An explicit `undefined` still triggers the default parameter. Without
		// the fallback, a Windows runner whose ComSpec is unset would try to spawn
		// `undefined` and every pnpm-backed check would fail to start.
		expect(
			createCommandInvocation("pnpm", [], "win32", undefined as never, {
				PNPM_HOME: dir,
			}).executable,
		).toBe(process.env.ComSpec ?? "cmd.exe");
	});
});

describe("runStageGate — check execution", () => {
	it("records a passing check and returns exit code 0", async () => {
		const result = await runStageGate(
			gate([nodeCheck("ok", 'console.log("fine")')]),
			{ cwd: newDir() },
		);
		expect(result.exitCode).toBe(0);
		expect(result.record.status).toBe("passed");
		expect(result.record.checks[0]?.status).toBe("passed");
		expect(result.record.checks[0]?.exitCode).toBe(0);
		expect(result.record.gateId).toBe("gate-test");
	});

	it("records a failing check, and one failure fails the whole gate", async () => {
		const result = await runStageGate(
			gate([
				nodeCheck("ok", 'console.log("fine")'),
				nodeCheck("bad", "process.exit(3)"),
				nodeCheck("also-ok", 'console.log("fine")'),
			]),
			{ cwd: newDir() },
		);
		// A gate is a conjunction. If a later pass could clear an earlier failure,
		// ordering checks differently would change whether a release ships.
		expect(result.exitCode).toBe(1);
		expect(result.record.status).toBe("failed");
		expect(result.record.checks.map((c) => c.status)).toEqual([
			"passed",
			"failed",
			"passed",
		]);
		expect(result.record.checks[1]?.exitCode).toBe(3);
	});

	it("keeps running checks after one fails", async () => {
		const result = await runStageGate(
			gate([nodeCheck("bad", "process.exit(1)"), nodeCheck("after", "0")]),
			{ cwd: newDir() },
		);
		// Fail-fast would hide every other problem behind the first one, turning
		// a gate run into a one-defect-per-CI-cycle loop.
		expect(result.record.checks).toHaveLength(2);
	});

	it("treats an unspawnable command as a failure rather than throwing", async () => {
		const result = await runStageGate(
			gate([
				{
					checkId: "missing",
					kind: "lint",
					command: [join(newDir(), "definitely-not-here")],
				},
			]),
			{ cwd: newDir() },
		);
		// `spawnSync` reports ENOENT via `result.error` with a null status. If the
		// `?? 1` default were missing, a command that never ran would be recorded
		// with exit code 0 — a typo in a check command would silently pass a gate.
		expect(result.exitCode).toBe(1);
		expect(result.record.checks[0]?.exitCode).toBe(1);
		expect(result.record.checks[0]?.evidence.error).toMatch(/ENOENT|Error/u);
	});

	it("treats an empty command as a failure", async () => {
		const result = await runStageGate(
			gate([{ checkId: "empty", kind: "lint", command: [] }]),
			{ cwd: newDir() },
		);
		expect(result.record.checks[0]?.exitCode).toBe(1);
		expect(result.record.checks[0]?.evidence).toEqual({
			error: "empty command",
		});
	});

	it("runs each check in the requested cwd", async () => {
		const dir = newDir();
		const result = await runStageGate(
			gate([
				nodeCheck("pwd", "console.log(JSON.stringify({cwd: process.cwd()}))"),
			]),
			{ cwd: dir },
		);
		// Checks are relative-path scripts; running them from the wrong directory
		// makes them pass vacuously by finding nothing to check.
		expect(result.record.checks[0]?.evidence.cwd).toContain(
			dir.split("/").at(-1) ?? "",
		);
	});

	it("passes opts.env through to the check, layered over process.env", async () => {
		const result = await runStageGate(
			gate([
				nodeCheck(
					"env",
					"console.log(JSON.stringify({mine: process.env.HOBO_TEST_VAR ?? '', inherited: process.env.PATH ? 'yes' : 'no'}))",
				),
			]),
			{ cwd: newDir(), env: { HOBO_TEST_VAR: "set" } },
		);
		expect(result.record.checks[0]?.evidence.mine).toBe("set");
		// Layering, not replacing: a check that lost PATH could not find any tool
		// it shells out to.
		expect(result.record.checks[0]?.evidence.inherited).toBe("yes");
	});
});

describe("runStageGate — SOURCE_DATE_EPOCH scoping", () => {
	const probe = (checkId: string, kind: StageGateCheckKind) =>
		nodeCheck(
			checkId,
			"console.log(JSON.stringify({epoch: process.env.SOURCE_DATE_EPOCH ?? 'absent'}))",
			kind,
		);

	it("forwards the epoch to build, sign and verify checks only", async () => {
		process.env.SOURCE_DATE_EPOCH = "1700000000";
		const result = await runStageGate(
			gate([
				probe("build", "build"),
				probe("sign", "sign"),
				probe("verify", "verify"),
				probe("lint", "lint"),
				probe("guard", "guard"),
			]),
			{ cwd: newDir() },
		);
		const byId = Object.fromEntries(
			result.record.checks.map((c) => [c.checkId, c.evidence.epoch]),
		);
		// The reproducibility knob belongs only to the kinds that embed a
		// timestamp in their output. Leaking it into a lint or guard run makes
		// those checks depend on an unrelated environment variable; withholding
		// it from a build breaks byte-for-byte reproducibility, which is the
		// property the build check exists to prove.
		expect(byId.build).toBe("1700000000");
		expect(byId.sign).toBe("1700000000");
		expect(byId.verify).toBe("1700000000");
		expect(byId.lint).toBe("absent");
		expect(byId.guard).toBe("absent");
	});

	it("strips an inherited epoch from every check when none is set on the runner", async () => {
		delete process.env.SOURCE_DATE_EPOCH;
		const result = await runStageGate(gate([probe("build", "build")]), {
			cwd: newDir(),
			// Even an explicitly supplied one is removed: the runner's own
			// environment is the single source of truth for reproducible timing,
			// so a caller cannot half-enable it for one kind.
			env: { SOURCE_DATE_EPOCH: "42" },
		});
		expect(result.record.checks[0]?.evidence.epoch).toBe("absent");
	});
});

describe("runStageGate — evidence extraction", () => {
	it("parses the last stdout line as JSON evidence", async () => {
		const result = await runStageGate(
			gate([
				nodeCheck(
					"json",
					'console.log("chatty preamble");console.log(JSON.stringify({a:"1",b:2,c:null,d:["x"]}))',
				),
			]),
			{ cwd: newDir() },
		);
		const evidence = result.record.checks[0]?.evidence ?? {};
		// Checks print progress before their result, so only the last line is the
		// machine-readable payload. Strings pass through; anything else is
		// re-serialized so the record stays a flat string map.
		expect(evidence.a).toBe("1");
		expect(evidence.b).toBe("2");
		expect(evidence.d).toBe('["x"]');
		// null and undefined are dropped rather than becoming the string "null",
		// which a consumer would read as a real value.
		expect(Object.hasOwn(evidence, "c")).toBe(false);
	});

	it("falls back to raw stdout when the last line is not JSON", async () => {
		const result = await runStageGate(
			gate([nodeCheck("plain", 'console.log("just words")')]),
			{ cwd: newDir() },
		);
		// A check that predates the JSON convention must still leave a readable
		// trail rather than an empty evidence map.
		expect(result.record.checks[0]?.evidence.stdout).toBe("just words");
	});

	it("keeps stderr evidence for a check that printed nothing to stdout", async () => {
		const result = await runStageGate(
			gate([nodeCheck("errs", 'console.error("boom");process.exit(2)')]),
			{ cwd: newDir() },
		);
		// The JSON parse yields nothing, so the raw evidence — including stderr —
		// is copied in. A failing check with no diagnostics is unactionable.
		expect(result.record.checks[0]?.evidence.stderr).toBe("boom");
	});

	it("truncates a passing check's output to 4000 characters", async () => {
		const result = await runStageGate(
			gate([nodeCheck("noisy", 'process.stdout.write("x".repeat(20000))')]),
			{ cwd: newDir() },
		);
		// Records are stored and diffed; a passing check has nothing to say, so
		// its output is capped hard to keep the record small.
		expect(result.record.checks[0]?.evidence.stdout).toHaveLength(4000);
	});

	it("keeps the head and tail of a large failing output", async () => {
		const result = await runStageGate(
			gate([
				nodeCheck(
					"noisy-fail",
					'process.stdout.write("H".repeat(9000) + "T".repeat(9000));process.exit(1)',
				),
			]),
			{ cwd: newDir() },
		);
		const stdout = result.record.checks[0]?.evidence.stdout ?? "";
		// The failure reason is usually at the *end* of a long log, but the
		// command being run is at the start — so both ends are kept and only the
		// middle is dropped, with a marker saying so.
		//
		// This is the assertion that caught the bug fixed alongside this test:
		// `parseEvidenceJson`'s non-JSON fallback used to re-truncate to a flat
		// `slice(0, 4000)`, throwing away the tail that `trimEvidence` had just
		// preserved. A failing check with a long plain-text log — a failing test
		// suite, which is the ordinary case — recorded its first 4000 characters
		// and nothing else.
		expect(stdout).toContain("output truncated; failure tail follows");
		expect(stdout.startsWith("H")).toBe(true);
		expect(stdout.endsWith("T")).toBe(true);
		expect(stdout.length).toBeLessThan(18_000);
	});

	it("applies the same head/tail preservation to stderr", async () => {
		const result = await runStageGate(
			gate([
				nodeCheck(
					"noisy-stderr",
					'process.stderr.write("H".repeat(9000) + "T".repeat(9000));process.exit(1)',
				),
			]),
			{ cwd: newDir() },
		);
		const stderr = result.record.checks[0]?.evidence.stderr ?? "";
		// stderr reaches the record only when stdout is empty (the raw evidence
		// is merged in only if the JSON parse produced no keys), so this is the
		// path a check that logs diagnostics to stderr actually takes.
		expect(stderr).toContain("output truncated; failure tail follows");
		expect(stderr.endsWith("T")).toBe(true);
	});

	it("keeps a failing output under 12000 characters whole", async () => {
		const result = await runStageGate(
			gate([
				nodeCheck(
					"small-fail",
					'process.stdout.write("y".repeat(500));process.exit(1)',
				),
			]),
			{ cwd: newDir() },
		);
		expect(result.record.checks[0]?.evidence.stdout).toHaveLength(500);
	});

	it("records no stdout key for a silent check", async () => {
		const result = await runStageGate(gate([nodeCheck("quiet", "0")]), {
			cwd: newDir(),
		});
		// Whitespace-only output is treated as no output, so the record does not
		// carry an empty string that reads as "the check said nothing meaningful"
		// versus "the check said nothing".
		expect(result.record.checks[0]?.evidence).toEqual({});
	});
});

describe("runStageGate — artifact and signature evidence", () => {
	const emit = (checkId: string, payload: Record<string, unknown>) =>
		nodeCheck(
			checkId,
			`console.log(${JSON.stringify(JSON.stringify(payload))})`,
			"build",
		);

	const DIGEST = `sha256:${"a".repeat(64)}`;

	it("defaults to a zero artifact and an unverified signature", async () => {
		const result = await runStageGate(gate([nodeCheck("noop", "0")]), {
			cwd: newDir(),
		});
		// A record must never be *absent* an artifact — a consumer that
		// dereferences it would crash — but the default has to be obviously
		// empty so nobody mistakes it for a real build.
		expect(result.record.artifact).toEqual({
			digestSha256: `sha256:${"0".repeat(64)}`,
			byteLength: 0,
			mediaType: "application/octet-stream",
		});
		expect(result.record.signature.verified).toBe(false);
	});

	it("adopts artifact evidence from either digest key", async () => {
		for (const key of ["component_digest", "digest_sha256"]) {
			const result = await runStageGate(
				gate([
					emit("build", {
						[key]: DIGEST,
						media_type: "application/wasm",
						byte_length: "1024",
					}),
				]),
				{ cwd: newDir() },
			);
			expect(result.record.artifact).toEqual({
				digestSha256: DIGEST,
				byteLength: 1024,
				mediaType: "application/wasm",
			});
		}
	});

	it("prefers component_digest when both keys are present", async () => {
		const result = await runStageGate(
			gate([
				emit("build", {
					component_digest: DIGEST,
					digest_sha256: `sha256:${"b".repeat(64)}`,
					media_type: "application/wasm",
					byte_length: "1",
				}),
			]),
			{ cwd: newDir() },
		);
		expect(result.record.artifact.digestSha256).toBe(DIGEST);
	});

	it("ignores partial artifact evidence", async () => {
		for (const payload of [
			{ component_digest: DIGEST, media_type: "application/wasm" },
			{ component_digest: DIGEST, byte_length: "1" },
			{ media_type: "application/wasm", byte_length: "1" },
			{
				component_digest: DIGEST,
				media_type: "application/wasm",
				byte_length: "",
			},
		]) {
			const result = await runStageGate(gate([emit("build", payload)]), {
				cwd: newDir(),
			});
			// All three fields or none. A half-populated artifact would describe a
			// component by digest while claiming the default zero length, and a
			// verifier comparing lengths would reject a perfectly good build.
			expect(result.record.artifact.byteLength).toBe(0);
		}
	});

	it("rejects a byte_length that is not a non-negative integer", async () => {
		for (const byteLength of ["-1", "abc", "1.5", "1e3", "10abc", " 1", ""]) {
			const result = await runStageGate(
				gate([
					emit("build", {
						component_digest: DIGEST,
						media_type: "application/wasm",
						byte_length: byteLength,
					}),
				]),
				{ cwd: newDir() },
			);
			// `parseInt` stops at the first unusable character rather than
			// failing, so "1.5" and "1e3" both become 1 and "10abc" becomes 10 —
			// each a whole non-negative integer that sails past an
			// `Number.isInteger` check. The record would then claim a byte length
			// the check never measured, and a verifier comparing it against the
			// real artifact would reject a good build. This is why the digits-only
			// test in `mergeArtifactEvidence` exists.
			expect(result.record.artifact.digestSha256, byteLength).toBe(
				`sha256:${"0".repeat(64)}`,
			);
		}
	});

	it("lets a later check overwrite an earlier artifact", async () => {
		const second = `sha256:${"c".repeat(64)}`;
		const result = await runStageGate(
			gate([
				emit("first", {
					component_digest: DIGEST,
					media_type: "application/wasm",
					byte_length: "1",
				}),
				emit("second", {
					component_digest: second,
					media_type: "application/wasm",
					byte_length: "2",
				}),
			]),
			{ cwd: newDir() },
		);
		// Last writer wins, which matches the definition order: a verify step
		// that re-measures the artifact should be what the record reports.
		expect(result.record.artifact.digestSha256).toBe(second);
	});

	it("adopts signature evidence only on a literal 'true'", async () => {
		const verified = await runStageGate(
			gate([
				emit("sign", {
					signature_verified: "true",
					signer_identity: "spiffe://hobo/ci",
					provenance_tier: "slsa-3",
					conformance_report_digest: DIGEST,
				}),
			]),
			{ cwd: newDir() },
		);
		expect(verified.record.signature).toEqual({
			verified: true,
			signerIdentity: "spiffe://hobo/ci",
			provenanceTier: "slsa-3",
			conformanceReportDigest: DIGEST,
		});

		for (const value of ["TRUE", "1", "yes", ""]) {
			const result = await runStageGate(
				gate([emit("sign", { signature_verified: value })]),
				{ cwd: newDir() },
			);
			// Signature verification is the strongest claim in the record. Any
			// spelling other than the exact agreed token must read as unverified,
			// because a check that printed something unexpected is a check whose
			// result nobody should be inferring.
			expect(result.record.signature.verified, value).toBe(false);
		}
	});

	it("defaults the descriptive signature fields to empty strings", async () => {
		const result = await runStageGate(
			gate([emit("sign", { signature_verified: "true" })]),
			{ cwd: newDir() },
		);
		// Verified with no signer is still recorded as verified — that is the
		// check's claim to make — but the fields exist so the record stays
		// parseable rather than carrying undefined.
		expect(result.record.signature).toEqual({
			verified: true,
			signerIdentity: "",
			provenanceTier: "",
			conformanceReportDigest: "",
		});
	});
});

describe("runStageGate — record assembly", () => {
	it("stamps start and finish timestamps in order", async () => {
		const result = await runStageGate(gate([nodeCheck("ok", "0")]), {
			cwd: newDir(),
		});
		expect(Date.parse(result.record.startedAt)).toBeLessThanOrEqual(
			Date.parse(result.record.finishedAt),
		);
		expect(result.record.startedAt).toMatch(/Z$/u);
	});

	it("prefers an explicit ciRunUrl, then GITHUB_RUN_URL, then empty", async () => {
		process.env.GITHUB_RUN_URL = "https://ci.example/from-env";
		const explicit = await runStageGate(gate([nodeCheck("ok", "0")]), {
			cwd: newDir(),
			ciRunUrl: "https://ci.example/explicit",
		});
		expect(explicit.record.ciRunUrl).toBe("https://ci.example/explicit");

		const fromEnv = await runStageGate(gate([nodeCheck("ok", "0")]), {
			cwd: newDir(),
		});
		expect(fromEnv.record.ciRunUrl).toBe("https://ci.example/from-env");

		delete process.env.GITHUB_RUN_URL;
		const none = await runStageGate(gate([nodeCheck("ok", "0")]), {
			cwd: newDir(),
		});
		// Empty string, not undefined: the record schema requires the field, and
		// a record that fails to parse cannot gate anything.
		expect(none.record.ciRunUrl).toBe("");
	});

	it("records 'unknown' for a commit it cannot read", async () => {
		// A temp directory is not a git repo, so `git rev-parse` exits non-zero.
		// Letting that throw would make the runner unusable outside a checkout —
		// and, worse, would abort after the checks had already run.
		const result = await runStageGate(gate([nodeCheck("ok", "0")]), {
			cwd: newDir(),
		});
		expect(result.record.repoCommit).toBe("unknown");
	});

	it("reads the real commit when cwd is a checkout", async () => {
		const result = await runStageGate(gate([nodeCheck("ok", "0")]), {
			cwd: process.cwd(),
		});
		// The commit is what ties a gate record to the code it gated; a record
		// that always said "unknown" would make every promotion untraceable.
		expect(result.record.repoCommit).toMatch(/^[0-9a-f]{40}$/u);
	});

	it("handles a gate with no checks at all", async () => {
		const result = await runStageGate(gate([]), { cwd: newDir() });
		// Vacuously passing is the honest answer for an empty definition — but it
		// must produce a well-formed record rather than crashing on `checks[0]`.
		expect(result.exitCode).toBe(0);
		expect(result.record.status).toBe("passed");
		expect(result.record.checks).toEqual([]);
	});
});

describe("runStageGate — outFile", () => {
	it("writes the serialized record, creating parent directories", async () => {
		const dir = newDir();
		const outFile = join(dir, "nested", "deeper", "record.json");
		const result = await runStageGate(
			gate([nodeCheck("ok", 'console.log("fine")')]),
			{ cwd: dir, outFile },
		);
		const written = JSON.parse(readFileSync(outFile, "utf8")) as Record<
			string,
			unknown
		>;
		// CI writes this to an artifact path that does not exist yet. Requiring
		// the caller to mkdir first would make the common invocation fail.
		expect(written.gate_id).toBe("gate-test");
		expect(written.status).toBe("passed");
		expect(result.record.gateId).toBe("gate-test");
	});

	it("writes the failing record too, and still reports exit code 1", async () => {
		const dir = newDir();
		const outFile = join(dir, "record.json");
		const result = await runStageGate(
			gate([nodeCheck("bad", "process.exit(1)")]),
			{ cwd: dir, outFile },
		);
		// The failing record is the one anyone actually needs. Skipping the write
		// on failure would leave a red gate with no evidence of why.
		expect(result.exitCode).toBe(1);
		expect(
			(JSON.parse(readFileSync(outFile, "utf8")) as { status: string }).status,
		).toBe("failed");
	});

	it("ends the file with a newline", async () => {
		const dir = newDir();
		const outFile = join(dir, "record.json");
		await runStageGate(gate([nodeCheck("ok", "0")]), { cwd: dir, outFile });
		// POSIX text-file convention; without it, `cat` of several records runs
		// them together and diffs show a spurious last-line change.
		expect(readFileSync(outFile, "utf8").endsWith("}\n")).toBe(true);
	});

	it("writes nothing when no outFile is given", async () => {
		const dir = newDir();
		await runStageGate(gate([nodeCheck("ok", "0")]), { cwd: dir });
		// The runner is used as a library as well as a CLI; an unconditional
		// write would litter the caller's cwd.
		expect(() => readFileSync(join(dir, "record.json"), "utf8")).toThrow();
	});
});

/** Create a fake Windows command shim on disk (contents are never executed). */
function writeCmd(dir: string, name: string): void {
	// These files exist only so the `existsSync` probe in the resolver finds
	// them; nothing ever runs them, which is why a `.cmd` is safe to write on a
	// POSIX test runner.
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), "@echo off\n", "utf8");
}
