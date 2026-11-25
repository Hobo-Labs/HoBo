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
	process.env.PATH = `${dir}:${dirname(process.execPath)}`;
	return dir;
}

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
		await expect(ensureCueBinary(tempDir())).rejects.toThrow();
	});

	it("never silently returns an unusable binary", async () => {
		process.env.PATH = dirname(process.execPath);
		await expect(ensureCueBinary(tempDir())).rejects.toThrow();
	});
});

describe("vetting a package's fixtures", () => {
	it("reports ok when every fixture behaves", async () => {
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
		expect(result.violations[0]?.message).toContain("good.json");
	});

	it("carries CUE's own explanation into the violation", async () => {
		fakeCueOnPath(
			'process.stderr.write("qty: incomplete value int"); process.exit(1);',
		);
		const { root, pkg } = dataModelPackage({ valid: ["good.json"] });
		const result = await vetCueConstraints(pkg, root);
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
		expect((await vetCueConstraints(pkg, root)).violations).toHaveLength(1);
	});

	it("passes a package with no fixture directories at all", async () => {
		fakeCueOnPath("process.exit(1);");
		const { root, pkg } = dataModelPackage({});
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
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.violations)).toBe(true);
	});
});

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
