import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonNumber } from "./json.js";
import type { CueVetResult, CueViolation, DataModelPackage } from "./types.js";

const CUE_VERSION = "v0.14.0";

function cuePlatform(os = platform()): string {
	if (os === "linux") return "linux";
	if (os === "darwin") return "darwin";
	if (os === "win32") return "windows";
	throw new Error(`unsupported platform for CUE download: ${os}`);
}

function cueArch(cpu = arch()): string {
	if (cpu === "x64") return "amd64";
	if (cpu === "arm64") return "arm64";
	throw new Error(`unsupported architecture for CUE download: ${cpu}`);
}

export function cueArchiveName(os = platform(), cpu = arch()): string {
	const extension = os === "win32" ? "zip" : "tar.gz";
	return `cue_${CUE_VERSION}_${cuePlatform(os)}_${cueArch(cpu)}.${extension}`;
}

function cachedCuePath(repoRoot: string): string {
	const base = join(repoRoot, ".tools", "cue", CUE_VERSION);
	const binary = platform() === "win32" ? "cue.exe" : "cue";
	return join(base, binary);
}

async function runCommand(
	command: string,
	args: readonly string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			command,
			[...args],
			{ cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// SAFETY: `if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {` is required at this I/O or test boundary.
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error(`command not found: ${command}`));
					return;
				}
				const code = isJsonNumber(error?.code) ? error.code : error ? 1 : 0;
				resolvePromise({
					stdout: String(stdout),
					stderr: String(stderr),
					code,
				});
			},
		);
	});
}

async function pathCueMatches(cuePath: string): Promise<boolean> {
	try {
		const result = await runCommand(cuePath, ["version"]);
		return (
			result.code === 0 &&
			(result.stdout.includes(CUE_VERSION) || result.stdout.includes("0.14.0"))
		);
	} catch {
		return false;
	}
}

async function downloadCue(repoRoot: string): Promise<string> {
	const target = cachedCuePath(repoRoot);
	if (existsSync(target)) return target;

	const os = cuePlatform();
	const archive = cueArchiveName();
	const url = `https://github.com/cue-lang/cue/releases/download/${CUE_VERSION}/${archive}`;
	const cacheDir = join(repoRoot, ".tools", "cue", CUE_VERSION);
	await mkdir(cacheDir, { recursive: true });

	let response: Response;
	try {
		response = await fetch(url);
	} catch (error) {
		throw new Error(
			`CUE ${CUE_VERSION} is not cached at ${target} and download failed (offline?). Install cue ${CUE_VERSION} on PATH or pre-cache under .tools/cue/${CUE_VERSION}/. ${String(error)}`,
		);
	}
	if (!response.ok || !response.body) {
		throw new Error(
			`CUE ${CUE_VERSION} download failed (${response.status}). Cache manually at ${target} or install cue ${CUE_VERSION} on PATH.`,
		);
	}

	const tarPath = join(cacheDir, archive);
	const bytes = Buffer.from(await response.arrayBuffer());
	await writeFile(tarPath, bytes);
	const extractArgs =
		os === "windows"
			? ["-xf", tarPath, "-C", cacheDir]
			: ["-xzf", tarPath, "-C", cacheDir];
	const extract = await runCommand("tar", extractArgs);
	if (extract.code !== 0) {
		throw new Error(`failed to extract CUE archive: ${extract.stderr}`);
	}

	const extracted = join(cacheDir, platform() === "win32" ? "cue.exe" : "cue");
	if (existsSync(extracted) && extracted !== target) {
		const { rename } = await import("node:fs/promises");
		await rename(extracted, target);
	}
	if (!existsSync(target)) {
		throw new Error(`CUE binary missing after extract in ${cacheDir}`);
	}
	await chmod(target, 0o755);
	return target;
}

export async function ensureCueBinary(repoRoot: string): Promise<string> {
	const pathCue = "cue";
	if (await pathCueMatches(pathCue)) return pathCue;
	const cached = cachedCuePath(repoRoot);
	if (await pathCueMatches(cached)) return cached;
	return downloadCue(repoRoot);
}

function cueDefinitionName(schemaPath: string): string {
	const base = basename(schemaPath, ".cue");
	const pascal = base
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
	return `#${pascal}`;
}

async function vetFixture(
	cueBinary: string,
	schemaPath: string,
	fixturePath: string,
	pkg: DataModelPackage,
	expectValid: boolean,
): Promise<CueViolation[]> {
	const schemaArg = join(pkg.dataModelsDir, schemaPath);
	const definition = cueDefinitionName(schemaPath);
	const absoluteFixture = join(pkg.dataModelsDir, fixturePath);
	const result = await runCommand(
		cueBinary,
		["vet", "-d", definition, schemaArg, absoluteFixture],
		pkg.dataModelsDir,
	);
	const passed = result.code === 0;
	if (expectValid && passed) return [];
	if (!expectValid && !passed) return [];

	return [
		{
			package: pkg.name,
			constraint: schemaPath,
			message: expectValid
				? `expected valid fixture ${fixturePath} but cue vet failed: ${result.stderr || result.stdout}`
				: `expected invalid fixture ${fixturePath} but cue vet passed`,
		},
	];
}

export async function vetCueConstraints(
	pkg: DataModelPackage,
	repoRoot: string,
): Promise<CueVetResult> {
	const cueBinary = await ensureCueBinary(repoRoot);
	const violations: CueViolation[] = [];

	for (const schemaPath of pkg.cueSchemas.map((absolute) =>
		absolute.slice(pkg.dataModelsDir.length + 1),
	)) {
		// Flat corpora retain their package-wide meaning. Scoped corpora add
		// checks only for their owning schema; they cannot mask flat fixtures.
		for (const fixtureRoot of [
			"fixtures",
			join("fixtures", basename(schemaPath, ".cue")),
		]) {
			for (const [kind, expectValid] of [
				["valid", true],
				["invalid", false],
			] as const) {
				const directory = join(pkg.dataModelsDir, fixtureRoot, kind);
				if (!existsSync(directory)) continue;
				const fixtures = (await readdir(directory))
					.filter((name) => name.endsWith(".json"))
					.sort();
				for (const fixture of fixtures) {
					violations.push(
						...(await vetFixture(
							cueBinary,
							schemaPath,
							join(fixtureRoot, kind, fixture),
							pkg,
							expectValid,
						)),
					);
				}
			}
		}
	}

	return Object.freeze({
		ok: violations.length === 0,
		violations: Object.freeze(violations),
	});
}

export async function vetReportEnvelope(
	repoRoot: string,
	reportJsonPath: string,
): Promise<CueVetResult> {
	const schemaTools = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const pkg: DataModelPackage = {
		name: "schema-tools",
		packageDir: schemaTools,
		dataModelsDir: join(schemaTools, "data-models"),
		generatedDir: join(schemaTools, "src", "_generated"),
		cueSchemas: [join(schemaTools, "data-models", "codegen_report.cue")],
	};
	const cueBinary = await ensureCueBinary(repoRoot);
	const result = await runCommand(
		cueBinary,
		[
			"vet",
			"-c",
			join(pkg.dataModelsDir, "codegen_report.cue"),
			reportJsonPath,
		],
		pkg.dataModelsDir,
	);
	if (result.code === 0) return { ok: true, violations: [] };
	return {
		ok: false,
		violations: [
			{
				package: "schema-tools",
				constraint: "codegen_report.cue",
				message: result.stderr || result.stdout,
			},
		],
	};
}

export async function withTempDirectory<T>(
	prefix: string,
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(homedir(), prefix));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function readFileStat(
	path: string,
): Promise<{ content: string; mtimeMs: number }> {
	const [content, fileStat] = await Promise.all([
		readFile(path, "utf8"),
		stat(path),
	]);
	return { content, mtimeMs: fileStat.mtimeMs };
}
