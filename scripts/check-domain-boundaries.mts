#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importSpecifiersOf } from "./lib/test-import-specifiers.mts";

export type DomainBoundaryViolation = Readonly<{
	file: string;
	rule:
		| "domain-no-raw-io"
		| "domain-no-secret-fields"
		| "domain-no-host-layer-import"
		| "domain-verify-required"
		| "domain-story-required";
	message: string;
}>;

export type DomainBoundaryReport = Readonly<{
	checkedFiles: readonly string[];
	checkedModels: readonly string[];
	violations: readonly DomainBoundaryViolation[];
}>;

const SKIPPED_DIRS = new Set([
	".git",
	".turbo",
	"dist",
	"fixtures",
	"node_modules",
]);

const FORBIDDEN_IO_MODULES = new Set([
	"child_process",
	"fs",
	"fs/promises",
	"http",
	"https",
	"mysql2",
	"net",
	"node:child_process",
	"node:fs",
	"node:fs/promises",
	"node:http",
	"node:https",
	"node:net",
	"node:sqlite",
	"pg",
	"undici",
]);

const SECRET_FIELD_PATTERN =
	/(?:"([^"]+)"|(?:\b(token|apiKey|api_key|secret|password|privateKey|accessToken|refreshToken|clientSecret|githubToken|credential)))\s*:/giu;

const SECRET_FIELD_ALLOWED = new Set(
	[
		"token",
		"apikey",
		"secret",
		"password",
		"privatekey",
		"accesstoken",
		"refreshtoken",
		"clientsecret",
		"githubtoken",
		"credential",
	].map((name) => name.toLowerCase()),
);

const HOST_LAYER_IMPORT_SCAN_DIRS = [
	"packages/ci/src/host",
	"packages/ci-ado/src",
	"packages/ci-cf/src",
	"packages/ci-dagger/src",
] as const;

const DOMAIN_PURE_IMPORT_PREFIXES = [
	"rivetkit",
	"@alchemy.run/",
	"effect",
	"@effect/",
] as const;

function toPosix(pathValue: string): string {
	return pathValue.replaceAll("\\", "/");
}

function resolveImportSegments(specifier: string): readonly string[] {
	const parts: string[] = [];
	for (const segment of toPosix(specifier).split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (parts.length > 0) parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts;
}

function hostLayerEscapeSpecifier(specifier: string): boolean {
	if (!specifier.includes("..")) return false;
	const parts = resolveImportSegments(specifier);
	if (parts[0] === "host") return true;
	return parts[0] === "ci-gh-actions" || parts.includes("ci-gh-actions");
}

export { hostLayerEscapeSpecifier };

export function isDomainPureImport(specifier: string): boolean {
	const normalized = toPosix(specifier);
	return DOMAIN_PURE_IMPORT_PREFIXES.some((prefix) => {
		const bare = prefix.replace(/\/$/u, "");
		if (normalized === bare) return true;
		if (prefix.endsWith("/")) return normalized.startsWith(prefix);
		return normalized.startsWith(`${bare}/`);
	});
}

function isHostLayerEscape(specifier: string): boolean {
	return hostLayerEscapeSpecifier(specifier);
}

function normalizeSecretFieldName(fieldName: string): string | null {
	const normalized = fieldName.replaceAll("_", "").toLowerCase();
	return SECRET_FIELD_ALLOWED.has(normalized) ? normalized : null;
}

function isForbiddenIoSpecifier(specifier: string): boolean {
	if (isDomainPureImport(specifier)) return false;
	if (FORBIDDEN_IO_MODULES.has(specifier)) return true;
	for (const mod of FORBIDDEN_IO_MODULES) {
		if (!mod.startsWith("node:") && specifier.startsWith(`${mod}/`))
			return true;
	}
	return false;
}

function listTsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) continue;
		const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) {
					stack.push(join(current, entry.name));
				}
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name.endsWith(".d.ts")) continue;
			if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) {
				out.push(join(current, entry.name));
			}
		}
	}
	return out.sort();
}

function findPackagesWithDomainDir(packagesRoot: string): string[] {
	if (!existsSync(packagesRoot)) return [];
	const found: string[] = [];
	const walk = (dir: string): void => {
		const domainDir = join(dir, "src", "domain");
		if (existsSync(domainDir)) {
			found.push(dir);
			return;
		}
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
			if (entry.name === "src" || entry.name === "test") continue;
			walk(join(dir, entry.name));
		}
	};
	walk(packagesRoot);
	return found.sort();
}

export function checkDomainBoundaries(rootDir: string): DomainBoundaryReport {
	const packagesRoot = join(rootDir, "packages");
	const packageDirs = findPackagesWithDomainDir(packagesRoot);
	const checkedFiles: string[] = [];
	const checkedModels: string[] = [];
	const violations: DomainBoundaryViolation[] = [];

	for (const pkgDir of packageDirs) {
		const domainFiles = listTsFiles(join(pkgDir, "src", "domain"));
		let declaresModel = false;

		for (const absFile of domainFiles) {
			const relFile = toPosix(relative(rootDir, absFile));
			checkedFiles.push(relFile);
			const source = readFileSync(absFile, "utf8");

			for (const entry of importSpecifiersOf(source, absFile)) {
				if (isHostLayerEscape(entry.specifier)) {
					violations.push({
						file: relFile,
						rule: "domain-no-host-layer-import",
						message: `domain must not import the host layer via "${entry.specifier}"`,
					});
				}
				if (isForbiddenIoSpecifier(entry.specifier)) {
					violations.push({
						file: relFile,
						rule: "domain-no-raw-io",
						message: `forbidden raw I/O import "${entry.specifier}" inside src/domain`,
					});
				}
			}

			if (
				source.includes("Domain.Event(") ||
				source.includes("Domain.Aggregate(")
			) {
				SECRET_FIELD_PATTERN.lastIndex = 0;
				const seenFields = new Set<string>();
				let match = SECRET_FIELD_PATTERN.exec(source);
				while (match !== null) {
					const raw = match[1] ?? match[2];
					if (raw !== undefined) {
						const normalized = normalizeSecretFieldName(raw);
						if (normalized !== null && !seenFields.has(normalized)) {
							seenFields.add(normalized);
							violations.push({
								file: relFile,
								rule: "domain-no-secret-fields",
								message: `secret-shaped schema field "${raw}" is prohibited in Domain.Event / Domain.Aggregate`,
							});
						}
					}
					match = SECRET_FIELD_PATTERN.exec(source);
				}
			}

			if (source.includes("Domain.Model(")) {
				declaresModel = true;
			}
		}

		if (declaresModel) {
			const relPkg = toPosix(relative(rootDir, pkgDir));
			checkedModels.push(relPkg);
			const testFiles = listTsFiles(join(pkgDir, "test"));
			const testSources = testFiles.map((testFile) =>
				readFileSync(testFile, "utf8"),
			);
			const hasVerifyTest = testSources.some((source) =>
				source.includes("Domain.verify("),
			);
			if (!hasVerifyTest) {
				violations.push({
					file: relPkg,
					rule: "domain-verify-required",
					message:
						"package declares Domain.Model(...) without a Domain.verify(...) test under test/",
				});
			}
			const hasStoryTest = testSources.some((source) =>
				source.includes("Story.make("),
			);
			if (!hasStoryTest) {
				violations.push({
					file: relPkg,
					rule: "domain-story-required",
					message:
						"package declares Domain.Model(...) without an Alchemy Domain BDD Story.make(...) test under test/",
				});
			}
		}
	}

	for (const relDir of HOST_LAYER_IMPORT_SCAN_DIRS) {
		const scanRoot = join(rootDir, relDir);
		for (const absFile of listTsFiles(scanRoot)) {
			const relFile = toPosix(relative(rootDir, absFile));
			checkedFiles.push(relFile);
			const source = readFileSync(absFile, "utf8");
			for (const entry of importSpecifiersOf(source, absFile)) {
				if (isHostLayerEscape(entry.specifier)) {
					violations.push({
						file: relFile,
						rule: "domain-no-host-layer-import",
						message: `module must not import the host layer via "${entry.specifier}"`,
					});
				}
			}
		}
	}

	return { checkedFiles, checkedModels, violations };
}

function main(argv: readonly string[]): number {
	const rootArg = argv
		.find((arg) => arg.startsWith("--root="))
		?.slice("--root=".length);
	const rootDir =
		rootArg === undefined || rootArg === ""
			? join(dirname(fileURLToPath(import.meta.url)), "..")
			: resolve(rootArg);
	const report = checkDomainBoundaries(rootDir);

	if (report.violations.length === 0) {
		console.log(
			`domain-boundaries: ok (${report.checkedFiles.length} file(s), ${report.checkedModels.length} model(s))`,
		);
		return 0;
	}

	console.error(
		`domain-boundaries: ${report.violations.length} violation(s) found:`,
	);
	for (const violation of report.violations) {
		console.error(
			`  [${violation.rule}] ${violation.file}: ${violation.message}`,
		);
	}
	return 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	process.exit(main(process.argv.slice(2)));
}
