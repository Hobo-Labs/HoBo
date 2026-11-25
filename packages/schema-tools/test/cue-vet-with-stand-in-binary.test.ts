/**
 * CUE constraint vetting, driven through a stand-in `cue` binary.
 *
 * This module is normally gated on a real CUE toolchain: `ensureCueBinary`
 * looks for `cue v0.14.0` on PATH, then in the repo's `.tools` cache, and only
 * then downloads one. These tests take the *first* branch, because a script on
 * PATH that answers the version probe is indistinguishable from the real thing
 * to everything downstream — which unlocks the whole vet path with no network
 * and no toolchain.
 *
 * Taking that branch is a deliberate choice rather than a limitation: the
 * download branch would work here (this sandbox can reach GitHub), but a test
 * that fetched a release archive would be slow, would fail on any offline
 * machine, and would be testing GitHub rather than this module.
 *
 * What the vet does is a double-sided check, and that is the property worth
 * holding:
 *
 * **A valid fixture must pass and an invalid fixture must fail.** Checking only
 * that valid fixtures pass would accept a constraint that accepts everything —
 * which is the most common way a schema silently stops constraining anything.
 * The invalid fixtures are what prove the schema still says no.
 *
 * **A violation names the fixture and carries the CLI's own output.** A report
 * saying "constraint failed" without which fixture or why is not actionable,
 * and CUE's stderr is the only explanation of the mismatch.
 *
 * **Fixtures are vetted in sorted order.** A violation list whose order
 * depended on the filesystem would produce a different report on every machine.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ensureCueBinary,
	readFileStat,
	vetCueConstraints,
	withTempDirectory,
} from "../src/cue.js";

const dirs: string[] = [];
const originalPath = process.env.PATH;

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new Error("offline test fixture")),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env.PATH = originalPath;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "hobo-cue-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/**
 * Put a stand-in `cue` on PATH. `body` is JavaScript that decides what each
 * invocation does; `argv` is the argument list, so a script can answer the
 * version probe and then judge each `vet` however the test needs.
 */
function fakeCueOnPath(body: string): string {
	const dir = tempDir("hobo-cue-bin-");
	const bin = join(dir, "cue");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const argv = process.argv.slice(2);",
			'if (argv[0] === "version") { process.stdout.write("cue version v0.14.0\\n"); process.exit(0); }',
			body,
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	// The stand-in is a node script, so its shebang needs node's own directory
	// alongside it.
	process.env.PATH = `${dir}:${dirname(process.execPath)}`;
	return dir;
}

/** A data-model package with one schema and the fixtures asked for. */
function dataModelPackage(fixtures: {
	valid?: readonly string[];
	invalid?: readonly string[];
}) {
	const root = tempDir("hobo-cue-pkg-");
	const dataModelsDir = join(root, "data-models");
	mkdirSync(dataModelsDir, { recursive: true });
	const schema = join(dataModelsDir, "order_line.cue");
	writeFileSync(schema, "#OrderLine: { qty: int }\n");
	for (const [kind, names] of [
		["valid", fixtures.valid ?? []],
		["invalid", fixtures.invalid ?? []],
	] as const) {
		if (names.length === 0) continue;
		const dir = join(dataModelsDir, "fixtures", kind);
		mkdirSync(dir, { recursive: true });
		for (const name of names) writeFileSync(join(dir, name), "{}\n");
	}
	// SAFETY: the vet reads exactly the package fields supplied above.
	return {
		root,
		pkg: {
			name: "orders",
			dataModelsDir,
			cueSchemas: [schema],
		} as never,
	};
}

describe("finding the CUE binary", () => {
	it("uses a matching `cue` already on PATH", async () => {
		fakeCueOnPath("process.exit(0);");
		// The bare name means it resolved through PATH rather than falling
		// through to the cache or the download.
		expect(await ensureCueBinary(tempDir())).toBe("cue");
	});

	it("ignores a `cue` whose version probe fails", async () => {
		const dir = tempDir("hobo-cue-bin-");
		const bin = join(dir, "cue");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				'process.stdout.write("cue version v0.14.0\\n");',
				"process.exit(1);",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(bin, 0o755);
		process.env.PATH = `${dir}:${dirname(process.execPath)}`;
		await expect(ensureCueBinary(tempDir())).rejects.toThrow();
	});

	it("ignores a `cue` whose version does not match", async () => {
		fakeCueOnPath("process.exit(0);");
		const dir = tempDir("hobo-cue-bin-");
		const bin = join(dir, "cue");
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				'process.stdout.write("cue version v0.9.0\\n");',
				"process.exit(0);",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(bin, 0o755);
		process.env.PATH = `${dir}:${dirname(process.execPath)}`;
		// A different CUE version can accept a schema this one rejects. Using
		// whatever happens to be installed would make the gate machine-dependent,
		// so a mismatch falls through — here, to a download that cannot run.
		await expect(ensureCueBinary(tempDir())).rejects.toThrow();
	});

	it("never silently returns an unusable binary", async () => {
		process.env.PATH = dirname(process.execPath);
		// With no matching cue anywhere, the only correct outcomes are a real
		// downloaded binary or a throw. Returning the bare name would defer the
		// failure to `cue vet`, where it reads as a schema violation rather than
		// a missing toolchain.
		//
		// Which failure arrives here depends on the environment, so this asserts
		// only that one does: offline, the fetch fails with the pre-cache
		// message; in this sandbox the fetch actually succeeds and extraction
		// then fails because `tar` is not on the stripped PATH. Matching either
		// message specifically would pin an environment rather than a behaviour.
		await expect(ensureCueBinary(tempDir())).rejects.toThrow();
	});
});

describe("vetting a package's fixtures", () => {
	it("reports ok when every fixture behaves", async () => {
		// Valid fixtures pass (exit 0), invalid ones fail (exit 1).
		fakeCueOnPath(`
			const isInvalid = argv.some((a) => a.includes("invalid"));
			process.exit(isInvalid ? 1 : 0);
		`);
		const { root, pkg } = dataModelPackage({
			valid: ["good.json"],
			invalid: ["bad.json"],
		});
		const result = await vetCueConstraints(pkg, root);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it("reports a violation when a valid fixture fails", async () => {
		fakeCueOnPath(
			'process.stderr.write("qty: incomplete value"); process.exit(1);',
		);
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		const result = await vetCueConstraints(pkg, root);
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
	});

	it("names the fixture that failed", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		const result = await vetCueConstraints(pkg, root);
		// A report that does not say which fixture is not actionable.
		expect(result.violations[0]?.message).toContain("good.json");
	});

	it("carries CUE's own explanation into the violation", async () => {
		fakeCueOnPath(
			'process.stderr.write("qty: incomplete value int"); process.exit(1);',
		);
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		const result = await vetCueConstraints(pkg, root);
		// CUE's stderr is the only description of the mismatch.
		expect(result.violations[0]?.message).toContain("incomplete value int");
	});

	it("falls back to stdout when CUE said nothing on stderr", async () => {
		fakeCueOnPath(
			'process.stdout.write("conflicting values"); process.exit(1);',
		);
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		const result = await vetCueConstraints(pkg, root);
		expect(result.violations[0]?.message).toContain("conflicting values");
	});

	it("reports a violation when an invalid fixture passes", async () => {
		// This is the direction that matters most: a constraint that accepts
		// everything still passes every valid fixture. The invalid fixtures are
		// what prove the schema still says no.
		fakeCueOnPath("process.exit(0);");
		const { root, pkg } = dataModelPackage({ invalid: ["bad.json"] });
		const result = await vetCueConstraints(pkg, root);
		expect(result.ok).toBe(false);
		expect(result.violations[0]?.message).toContain("expected invalid fixture");
	});

	it("attributes each violation to its package", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		const result = await vetCueConstraints(pkg, root);
		// A repo-wide report interleaves packages; an unattributed violation
		// cannot be routed to whoever owns the schema.
		expect(result.violations[0]?.package).toBe("orders");
	});

	it("names the schema as the constraint", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		expect(result_constraint(await vetCueConstraints(pkg, root))).toBe(
			"order_line.cue",
		);
	});

	it("vets fixtures in sorted order", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({
			valid: ["b.json", "a.json", "c.json"],
		});
		const result = await vetCueConstraints(pkg, root);
		// A violation list ordered by the filesystem would produce a different
		// report on every machine.
		const order = result.violations.map(
			(v) => String(v.message).match(/([abc])\.json/u)?.[1],
		);
		expect(order).toEqual(["a", "b", "c"]);
	});

	it("only considers JSON fixtures", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		writeFileSync(
			join(pkg.dataModelsDir, "fixtures", "valid", "README.md"),
			"notes\n",
		);
		// A README beside the fixtures is ordinary; vetting it would report a
		// violation for a file that was never a fixture.
		expect((await vetCueConstraints(pkg, root)).violations).toHaveLength(1);
	});

	it("passes a package with no fixture directories at all", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({});
		// A schema with no fixtures yet is unfinished, not broken — the gate
		// that reports it is a different one.
		expect((await vetCueConstraints(pkg, root)).ok).toBe(true);
	});

	it("vets valid fixtures even when there is no invalid directory", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		expect((await vetCueConstraints(pkg, root)).violations).toHaveLength(1);
	});

	it("vets invalid fixtures even when there is no valid directory", async () => {
		fakeCueOnPath("process.exit(0);");
		const { root, pkg } = dataModelPackage({ invalid: ["bad.json"] });
		expect((await vetCueConstraints(pkg, root)).violations).toHaveLength(1);
	});

	it("derives the definition name from the schema filename", async () => {
		// `order_line.cue` names `#OrderLine`. Vetting against the wrong
		// definition would check the fixture against nothing and pass.
		const log = tempDir("hobo-cue-log-");
		const logPath = join(log, "args.log");
		fakeCueOnPath(`
			require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");
			process.exit(0);
		`);
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		await vetCueConstraints(pkg, root);
		const { content } = await readFileStat(logPath);
		expect(content).toContain("#OrderLine");
	});

	it("freezes the result", async () => {
		fakeCueOnPath("process.exit(0);");
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		const result = await vetCueConstraints(pkg, root);
		// The result is aggregated across packages; a caller mutating one
		// package's violations would corrupt the repo-wide report.
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.violations)).toBe(true);
	});
});

/** The constraint named by the first violation. */
function result_constraint(result: {
	violations: readonly { constraint: string }[];
}): string | undefined {
	return result.violations[0]?.constraint;
}

describe("the file helpers", () => {
	it("reads a file's content and modification time together", async () => {
		const dir = tempDir();
		const path = join(dir, "note.txt");
		writeFileSync(path, "hello\n");
		const stat = await readFileStat(path);
		expect(stat.content).toBe("hello\n");
		// The mtime is read in the same call so a caller cannot observe the file
		// changing between the two reads.
		expect(stat.mtimeMs).toBeGreaterThan(0);
	});

	it("rejects for a file that does not exist", async () => {
		await expect(readFileStat(join(tempDir(), "missing"))).rejects.toThrow();
	});

	it("runs its callback inside a fresh directory", async () => {
		const seen = await withTempDirectory("hobo-test-", async (dir) => dir);
		expect(seen).toContain("hobo-test-");
	});

	it("removes the directory afterwards", async () => {
		const seen = await withTempDirectory("hobo-test-", async (dir) => {
			writeFileSync(join(dir, "scratch"), "x");
			return dir;
		});
		// A temp directory that survived would accumulate one per codegen run.
		expect(() => execFileSync("test", ["-d", seen])).toThrow();
	});

	it("removes the directory even when the callback throws", async () => {
		let captured = "";
		await expect(
			withTempDirectory("hobo-test-", async (dir) => {
				captured = dir;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// Cleanup on the failure path is the case that actually leaks.
		expect(() => execFileSync("test", ["-d", captured])).toThrow();
	});

	it("propagates the callback's own error rather than a cleanup one", async () => {
		await expect(
			withTempDirectory("hobo-test-", async () => {
				throw new Error("the real problem");
			}),
		).rejects.toThrow("the real problem");
	});

	it("returns whatever the callback returned", async () => {
		expect(await withTempDirectory("hobo-test-", async () => 42)).toBe(42);
	});
});
