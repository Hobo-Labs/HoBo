import { createHash, randomUUID, type Hash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkCodegen,
	preflightBuf,
} from "../../packages/schema-tools/src/codegen.ts";
import { discoverDataModelPackages } from "../../packages/schema-tools/src/discover.ts";
import { parseCodegenArgv } from "../../packages/schema-tools/src/parse.ts";
import type {
	CodegenReport,
	CodegenStatus,
	DataModelPackage,
} from "../../packages/schema-tools/src/types.ts";

async function hashTree(
	hash: Hash,
	root: string,
	directory: string,
): Promise<void> {
	if (!existsSync(directory)) return;
	if ((await stat(directory)).isFile()) {
		hash.update(relative(root, directory).replaceAll("\\", "/"));
		hash.update("\0");
		hash.update(await readFile(directory));
		hash.update("\0");
		return;
	}
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await hashTree(hash, root, path);
		} else if (entry.isFile()) {
			hash.update(relative(root, path).replaceAll("\\", "/"));
			hash.update("\0");
			hash.update(await readFile(path));
			hash.update("\0");
		}
	}
}

function resolvedVersion(lockfile: string, dependency: string): string {
	const lines = lockfile.replaceAll("\r\n", "\n").split("\n");
	const importer = lines.indexOf("  packages/schema-tools:");
	if (importer === -1)
		throw new Error(
			"packages/schema-tools importer missing from pnpm-lock.yaml",
		);
	for (let index = importer + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^  \S/u.test(line)) break;
		if (line !== `      '${dependency}':`) continue;
		for (let field = index + 1; field < lines.length; field += 1) {
			const candidate = lines[field] ?? "";
			if (/^      \S/u.test(candidate)) break;
			const version = /^        version: (.+)$/u.exec(candidate)?.[1];
			if (version) return version;
		}
	}
	throw new Error(`resolved ${dependency} version missing from pnpm-lock.yaml`);
}

function requiredMatch(
	content: string,
	pattern: RegExp,
	label: string,
): string {
	const value = pattern.exec(content)?.[1];
	if (!value) throw new Error(`${label} version pin missing`);
	return value;
}

async function hashSharedInputs(hash: Hash, root: string): Promise<void> {
	await hashTree(hash, root, join(root, "packages/schema-tools/src"));
	await hashTree(hash, root, join(root, "buf.gen.yaml"));
	const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
	const miseToml = await readFile(join(root, "mise.toml"), "utf8");
	const miseLock = await readFile(join(root, "mise.lock"), "utf8");
	const versions = [
		resolvedVersion(lockfile, "@bufbuild/buf"),
		resolvedVersion(lockfile, "@bufbuild/protoc-gen-es"),
		requiredMatch(miseToml, /^cue = "([^"]+)"$/mu, "mise.toml CUE"),
		requiredMatch(
			miseLock,
			/^\[\[tools\.cue\]\]\nversion = "([^"]+)"$/mu,
			"mise.lock CUE",
		),
	];
	for (const version of versions) hash.update(`version\0${version}\0`);
}

export async function hashCodegenInputs(
	root: string,
	pkg: DataModelPackage,
): Promise<string> {
	const hash = createHash("sha256");
	hash.update(`package\0${pkg.name}\0`);
	await hashTree(hash, root, pkg.dataModelsDir);
	await hashTree(hash, root, pkg.generatedDir);
	await hashSharedInputs(hash, root);
	return hash.digest("hex");
}

export type AffectedCodegenOptions = Readonly<{
	repoRoot: string;
	cacheDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	checkPackage?: (pkg: DataModelPackage) => Promise<CodegenReport>;
	log?: (line: string) => void;
}>;

export type AffectedCodegenResult = Readonly<{
	status: CodegenStatus;
	checked: readonly string[];
	skipped: readonly string[];
	durationMs: number;
}>;

function cacheDirectory(
	root: string,
	env: Readonly<Record<string, string | undefined>>,
	override: string | undefined,
): string {
	if (override) return resolve(root, override);
	if (env.HOBO_CODEGEN_CACHE_DIR)
		return resolve(root, env.HOBO_CODEGEN_CACHE_DIR);
	if (env.TURBO_CACHE_DIR) {
		return resolve(root, env.TURBO_CACHE_DIR, "..", "hobo-codegen-check");
	}
	return join(root, "node_modules", ".cache", "hobo-codegen-check");
}

function stampPath(cacheDir: string, hash: string): string {
	return join(cacheDir, `${hash}.clean`);
}

function stampContent(pkg: DataModelPackage, hash: string): string {
	return `hobo-codegen-clean-v1\n${pkg.name}\n${hash}\n`;
}

async function hasCleanStamp(
	cacheDir: string,
	pkg: DataModelPackage,
	hash: string,
): Promise<boolean> {
	try {
		return (
			(await readFile(stampPath(cacheDir, hash), "utf8")) ===
			stampContent(pkg, hash)
		);
	} catch {
		return false;
	}
}

async function writeCleanStamp(
	cacheDir: string,
	pkg: DataModelPackage,
	hash: string,
): Promise<void> {
	await mkdir(cacheDir, { recursive: true });
	const target = stampPath(cacheDir, hash);
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, stampContent(pkg, hash));
	await rename(temporary, target);
}

export async function runAffectedCodegen(
	options: AffectedCodegenOptions,
): Promise<AffectedCodegenResult> {
	const started = Date.now();
	const root = resolve(options.repoRoot);
	const packages = discoverDataModelPackages(root);
	if (packages.length === 0)
		throw new Error(
			`no data-model packages found under ${join(root, "packages")}`,
		);
	const cacheDir = cacheDirectory(
		root,
		options.env ?? process.env,
		options.cacheDir,
	);
	const log = options.log ?? console.log;
	let preflight: Promise<void> | undefined;
	const checkPackage =
		options.checkPackage ??
		(async (pkg: DataModelPackage) => {
			preflight ??= preflightBuf(parseCodegenArgv(["--check"], root));
			await preflight;
			return checkCodegen(
				parseCodegenArgv(["--check", "--filter", pkg.packageDir], root),
			);
		});
	const checked: string[] = [];
	const skipped: string[] = [];
	let status: CodegenStatus = "CLEAN";

	for (const pkg of packages) {
		const hash = await hashCodegenInputs(root, pkg);
		if (await hasCleanStamp(cacheDir, pkg, hash)) {
			skipped.push(pkg.name);
			log(`codegen: ${pkg.name} HIT ${hash.slice(0, 12)}`);
			continue;
		}

		checked.push(pkg.name);
		const report = await checkPackage(pkg);
		log(`codegen: ${pkg.name} MISS ${report.status} ${report.durationMs}ms`);
		for (const entry of report.drift) log(`drift: ${entry.kind} ${entry.path}`);
		for (const violation of report.cueViolations) {
			log(
				`cue: ${violation.package}/${violation.constraint}: ${violation.message}`,
			);
		}
		if (report.status === "CLEAN") {
			await writeCleanStamp(cacheDir, pkg, hash);
		} else {
			if (report.status === "ERROR" || status === "CLEAN")
				status = report.status;
		}
	}

	const durationMs = Date.now() - started;
	log(`status: ${status}`);
	log(`durationMs: ${durationMs}`);
	log(`cache: ${skipped.length} hit(s), ${checked.length} miss(es)`);
	return { status, checked, skipped, durationMs };
}

async function main(): Promise<void> {
	try {
		const result = await runAffectedCodegen({ repoRoot: process.cwd() });
		process.exitCode = result.status === "CLEAN" ? 0 : 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
