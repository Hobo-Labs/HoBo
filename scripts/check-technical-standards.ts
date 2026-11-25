import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { GIT_OUTPUT_MAX_BUFFER } from "./lib/git-output.ts";

type Mode = "worktree" | "staged";

let base = "";
let mode: Mode = "worktree";
let resolvedBase: string | undefined;
const failures: string[] = [];

for (const arg of process.argv.slice(2)) {
	if (arg === "--staged") {
		mode = "staged";
	} else if (arg.startsWith("--base=")) {
		base = arg.slice("--base=".length);
	} else if (arg === "--help" || arg === "-h") {
		console.log(`Usage: node --import tsx scripts/check-technical-standards.ts [--staged] [--base=<git-ref>]

Enforces HoBo's compile-time-first technical standards on changed files:
- TypeScript toolchain is declared in package metadata.
- New JavaScript-family implementation files are rejected in favor of .ts.
- Canonical agent/design docs keep the Protobuf, CUE, parse-don't-validate,
  and PACT guidance present.
- Repository-wide data-model catalogs stay forbidden; CUE-backed data models
  live beside the package/project that owns the type.`);
		process.exit(0);
	}
}

function fail(message: string): void {
	failures.push(message);
}

function requireText(file: string, pattern: RegExp, message: string): void {
	const contents = readFileSync(file, "utf8");
	if (!pattern.test(contents)) {
		fail(message);
	}
}

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		shell: false,
		maxBuffer: GIT_OUTPUT_MAX_BUFFER,
	});

	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`,
		);
	}

	return result.stdout;
}

function refAvailable(ref: string): boolean {
	return (
		spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
			shell: false,
			stdio: "ignore",
		}).status === 0
	);
}

function effectiveBase(): string {
	if (!base) return "";
	if (resolvedBase !== undefined) return resolvedBase;
	if (refAvailable(base)) {
		resolvedBase = base;
		return resolvedBase;
	}
	if (refAvailable("HEAD~1")) {
		console.warn(`Base ref ${base} is unavailable; falling back to HEAD~1.`);
		resolvedBase = "HEAD~1";
		return resolvedBase;
	}
	console.warn(
		`Base ref ${base} is unavailable; falling back to working tree diff.`,
	);
	resolvedBase = "";
	return resolvedBase;
}

function baseRefAvailable(): boolean {
	return Boolean(effectiveBase());
}

function existsAtBase(file: string): boolean {
	if (!baseRefAvailable()) {
		return false;
	}
	return (
		spawnSync("git", ["cat-file", "-e", `${effectiveBase()}:${file}`], {
			shell: false,
			stdio: "ignore",
		}).status === 0
	);
}

function changedFiles(statuses: readonly string[] = ["A"]): string[] {
	const baseForDiff = mode === "staged" ? "" : effectiveBase();
	const nameStatus =
		mode === "staged"
			? run("git", [
					"diff",
					"--cached",
					"--name-status",
					"--find-renames=50%",
					"--diff-filter=ACMR",
				])
			: baseForDiff
				? run("git", [
						"diff",
						"--name-status",
						"--find-renames=50%",
						"--diff-filter=ACMR",
						`${baseForDiff}...HEAD`,
					])
				: run("git", [
						"diff",
						"--name-status",
						"--find-renames=50%",
						"--diff-filter=ACMR",
						"HEAD",
					]);

	const changed = nameStatus
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const [status, firstPath, secondPath] = line.split(/\t/);
			if (!status) {
				return [];
			}
			if (status.startsWith("R")) {
				return [];
			}
			if (status.startsWith("C")) {
				return secondPath ? [{ status: "A", file: secondPath }] : [];
			}
			return firstPath ? [{ status, file: firstPath }] : [];
		})
		.filter((entry) =>
			statuses.some((status) => entry.status.startsWith(status)),
		)
		.map((entry) => entry.file);

	const addedFiles =
		mode === "staged" && base
			? changed.filter((file) => !existsAtBase(file))
			: changed;

	if (mode === "worktree" && !base) {
		const untracked = run("git", ["ls-files", "--others", "--exclude-standard"])
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		addedFiles.push(...untracked);
	}

	return addedFiles;
}

function isJavaScriptImplementationFile(file: string): boolean {
	const normalized = file.replace(/\\/g, "/");
	return (
		/^(src|scripts|test)\//.test(normalized) &&
		/\.(?:js|mjs|cjs)$/.test(normalized)
	);
}

requireText(
	"package.json",
	/"typescript"\s*:/,
	"package.json: missing TypeScript dev dependency",
);
requireText(
	"pnpm-lock.yaml",
	/typescript@6\.0\.3/,
	"pnpm-lock.yaml: missing locked TypeScript toolchain",
);
requireText(
	"AGENTS.md",
	/Protobuf/,
	"AGENTS.md: missing Protobuf agent guidance",
);
requireText("AGENTS.md", /CUE/, "AGENTS.md: missing CUE agent guidance");
requireText(
	"AGENTS.md",
	/Parse, don't validate/,
	"AGENTS.md: missing parse-don't-validate guidance",
);
requireText("AGENTS.md", /PACT/, "AGENTS.md: missing PACT agent guidance");
requireText(
	"docs/design/technical-standards.md",
	/Protobuf/,
	"technical standards: missing Protobuf guidance",
);
requireText(
	"docs/design/technical-standards.md",
	/CUE/,
	"technical standards: missing CUE guidance",
);
requireText(
	"docs/design/technical-standards.md",
	/Parse, don't validate/,
	"technical standards: missing parse-don't-validate guidance",
);
requireText(
	"docs/design/technical-standards.md",
	/PACT/,
	"technical standards: missing PACT guidance",
);

const newJavaScriptFiles = changedFiles()
	.filter(isJavaScriptImplementationFile)
	.sort();
if (newJavaScriptFiles.length > 0) {
	fail(
		[
			"New JavaScript-family implementation files detected; use TypeScript (.ts) for new code or document an ADR exception:",
			...newJavaScriptFiles.map((file) => `- ${file}`),
		].join("\n"),
	);
}

/**
 * True when the marker appears on the declaration line or anywhere in the
 * comment block immediately above it.
 *
 * This used to read exactly one preceding line, which meant a marker written
 * inside a multi-line comment — the natural place to put a sentence explaining
 * *why* a constant is the contract — did not count, and the check reported a
 * missing marker that was plainly there. Two agents lost a round trip to it in
 * one day. The rule the comment above already states is "on or above the
 * declaration"; this makes the code say the same thing.
 */
function hasMarkerAbove(
	lines: readonly string[],
	index: number,
	marker: string,
): boolean {
	if ((lines[index] ?? "").includes(marker)) return true;
	for (let above = index - 1; above >= 0; above -= 1) {
		const text = (lines[above] ?? "").trim();
		const isComment =
			text.startsWith("//") ||
			text.startsWith("*") ||
			text.startsWith("/*") ||
			text.endsWith("*/");
		if (!isComment) return false;
		if (text.includes(marker)) return true;
	}
	return false;
}

// Minimal public surface (technical-standards.md): no new exported
// string-literal constants in package sources — schema identity and enum
// vocabularies come from generated code. Constants that ARE the contract
// carry a // public-contract: <why> marker on or above the declaration.
const literalConstOffenders: string[] = [];
for (const file of changedFiles(["A", "M"])) {
	if (
		!/^packages\/.+\/src\//.test(file) ||
		// `_generated`, and suffixed siblings like `_generated-art`, are written
		// by generators that stamp "do not hand-edit" — a marker added here
		// would be dropped the next time the generator runs.
		/(^|\/)_generated[\w-]*(\/|$)/.test(file) ||
		!file.endsWith(".ts") ||
		!existsSync(file)
	) {
		continue;
	}
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		const match = line.match(
			/^export const [A-Za-z_$][\w$]*(?:\s*:\s*[^=]+)?\s*=\s*(["'`]|$)/,
		);
		if (!match) continue;
		const opensLiteral = match[1]
			? true
			: /^\s*["'`]/.test(lines[index + 1] ?? "");
		if (!opensLiteral) continue;
		if (hasMarkerAbove(lines, index, "public-contract:")) continue;
		literalConstOffenders.push(`${file}:${index + 1}`);
	}
}
if (literalConstOffenders.length > 0) {
	fail(
		[
			"Exported string-literal constants need a // public-contract: <why> marker (or belong in generated code / module-private scope):",
			...literalConstOffenders.map((entry) => `- ${entry}`),
		].join("\n"),
	);
}

// One build graph (turbo), not two. A package script must never build another
// workspace package: `turbo run build` already guarantees dependencies through
// `dependsOn: ["^build"]`, so a `pnpm --filter <dep> build` inside a package's
// `build`/`prebuild`/`pretest` is a second, *uncached* build graph running
// underneath the cached one. A full sweep used to pay ~150 cold `tsc`
// invocations that way. Packages that need their own output before tests run
// go through `scripts/ensure-built.mts`, which no-ops inside turbo and
// delegates to turbo outside it.
const OUT_OF_BAND_HOOKS = ["build", "prebuild", "pretest"] as const;
const outOfBandBuilds: string[] = [];
for (const file of run("git", ["ls-files", "**/package.json"])
	.split(/\r?\n/)
	.map((line) => line.trim())
	.filter(Boolean)
	.filter((file) => !file.includes("node_modules") && existsSync(file))) {
	let manifest: { scripts?: Record<string, string> };
	try {
		// SAFETY: assertion to `se(readFileSync(file, "utf8")) as typeof manifest; } cat` is required at this boundary.
		manifest = JSON.parse(readFileSync(file, "utf8")) as typeof manifest;
	} catch {
		continue;
	}
	for (const hook of OUT_OF_BAND_HOOKS) {
		const script = manifest.scripts?.[hook];
		if (!script) continue;
		for (const segment of script.split("&&").map((part) => part.trim())) {
			if (/^pnpm(\s+--filter\s+\S+)+\s+(run\s+)?build$/.test(segment)) {
				outOfBandBuilds.push(`${file} :: ${hook} :: ${segment}`);
			}
		}
	}
}
if (outOfBandBuilds.length > 0) {
	fail(
		[
			"Package scripts must not build other workspace packages; turbo's `^build` already does, and these run uncached underneath it. Delete the segment, or use `node --experimental-strip-types <rel>/scripts/ensure-built.mts` if the package needs its own output before tests:",
			...outOfBandBuilds.map((entry) => `- ${entry}`),
		].join("\n"),
	);
}

if (existsSync("contracts/data-models")) {
	fail(
		"central contracts/data-models is forbidden; CUE-backed data models must live in the owning project/package data-models folder",
	);
}

// SAFETY: assertion to `se(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string>; }; if (pa` is required at this boundary.
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
	scripts?: Record<string, string>;
};
if (packageJson.scripts?.["contracts:data-models"]) {
	fail(
		"package.json must not define contracts:data-models; do not regenerate a central data-model catalog",
	);
}

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}

console.log("technical standards ok");
