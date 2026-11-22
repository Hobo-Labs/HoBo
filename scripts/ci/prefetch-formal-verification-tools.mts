import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TLA_URL =
	"https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
const TLA_SHA256 =
	"936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const requirementsZ3 = join(
	repoRoot,
	".agents/skills/verify-broker-budget-authority/proof/requirements-z3.txt",
);

function baseDir(): string {
	const fromEnv = process.env.RUNNER_TEMP ?? process.env.TMPDIR;
	const base = fromEnv ? resolve(fromEnv) : tmpdir();
	const dir = join(base, "hobo-formal-verification");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function downloadJar(destination: string): void {
	if (existsSync(destination) && sha256File(destination) === TLA_SHA256) return;
	const result = spawnSync(
		"curl",
		[
			"-fsSL",
			"--retry",
			"3",
			"--retry-delay",
			"2",
			"--max-time",
			"120",
			"-o",
			destination,
			TLA_URL,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "curl failed").trim();
		throw new Error(`Unable to download TLC 1.7.4: ${detail}`);
	}
	if (sha256File(destination) !== TLA_SHA256) {
		throw new Error("TLC jar checksum does not match the pinned release");
	}
}

async function ensureZ3(target: string): Promise<string> {
	await mkdir(target, { recursive: true, mode: 0o700 });
	const probe = spawnSync("python3", [
		"-c",
		"import z3; v=z3.get_version_string(); import sys; sys.exit(0 if v=='4.15.4' else 1)",
	]);
	if (probe.status === 0) return "";
	const pip = spawnSync(
		"python3",
		[
			"-m",
			"pip",
			"install",
			"--disable-pip-version-check",
			"--no-cache-dir",
			"--no-deps",
			"--require-hashes",
			"--only-binary=:all:",
			"--target",
			target,
			"-r",
			requirementsZ3,
		],
		{ encoding: "utf8", timeout: 300_000 },
	);
	if (pip.status !== 0) {
		const detail = (pip.stderr || pip.stdout || "pip install failed").trim();
		process.stderr.write(
			`prefetch-formal-verification: skipping Z3 warmup (${detail})\n`,
		);
		return "";
	}
	const verify = spawnSync(
		"python3",
		[
			"-c",
			"import z3; v=z3.get_version_string(); import sys; sys.exit(0 if v=='4.15.4' else 1)",
		],
		{ env: { ...process.env, PYTHONPATH: target } },
	);
	if (verify.status !== 0) {
		throw new Error("Installed Z3 failed the 4.15.4 version check");
	}
	return target;
}

function writeGithubEnv(key: string, value: string): void {
	const file = process.env.GITHUB_ENV;
	if (!file) return;
	appendFileSync(file, `${key}=${value}\n`, "utf8");
}

async function main(): Promise<void> {
	const base = baseDir();
	const jar = join(base, "tla2tools.jar");
	downloadJar(jar);
	const z3Path = await ensureZ3(join(base, "python-z3"));
	writeGithubEnv("TLA2TOOLS", jar);
	if (z3Path) writeGithubEnv("BUDGET_Z3_PYTHONPATH", z3Path);
	process.stdout.write(`TLA2TOOLS=${jar}\n`);
	if (z3Path) process.stdout.write(`BUDGET_Z3_PYTHONPATH=${z3Path}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});