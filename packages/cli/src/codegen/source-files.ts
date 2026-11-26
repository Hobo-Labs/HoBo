import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { CodegenError, type CodegenLayout } from "./types.js";

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/u;

export async function scannedSources(
	projectRoot: string,
	layout: CodegenLayout,
): Promise<readonly string[]> {
	const scanRoot = join(projectRoot, layout.sources.scanDir);
	if (!existsSync(scanRoot)) return [];
	const excluded = layout.generatedRoots.map((root) => join(projectRoot, root));

	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		if (
			excluded.some(
				(root) => directory === root || directory.startsWith(`${root}${sep}`),
			)
		)
			return;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (TYPESCRIPT_SOURCE.test(entry.name)) files.push(path);
		}
	}
	await visit(scanRoot);
	return files.sort();
}

export function projectPath(projectRoot: string, file: string): string {
	return relative(projectRoot, file).split("\\").join("/");
}

export function emittedPath(file: string, preserveJsx: boolean): string {
	if (preserveJsx && file.endsWith(".tsx")) {
		return `${file.slice(0, -".tsx".length)}.jsx`;
	}
	return file.replace(
		/\.(?:([cm])ts|tsx?)$/u,
		(_extension, flavor: string | undefined) => `.${flavor ?? ""}js`,
	);
}

const UNREADABLE = new Set([5083, 5012, 6053]);

const INVALID_VALUE = new Set([6046, 5024]);

function leavesJsxUnknown(diagnostic: ts.Diagnostic): boolean {
	if (diagnostic.code >= 1000 && diagnostic.code < 2000) return true;
	if (UNREADABLE.has(diagnostic.code)) return true;
	return (
		INVALID_VALUE.has(diagnostic.code) &&
		/'(?:--)?jsx'/u.test(
			ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
		)
	);
}

export function preservesJsx(projectRoot: string): boolean {
	const configFile = join(projectRoot, "tsconfig.json");
	if (!existsSync(configFile)) return false;
	const problems: ts.Diagnostic[] = [];
	const parsed = ts.getParsedCommandLineOfConfigFile(configFile, undefined, {
		...ts.sys,
		readDirectory: () => [],
		onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
			problems.push(diagnostic);
		},
	});
	if (parsed !== undefined) {
		problems.push(
			...ts.getConfigFileParsingDiagnostics(parsed).filter(leavesJsxUnknown),
		);
	}
	if (parsed === undefined || problems.length > 0) {
		const messages = problems.map(
			(diagnostic) =>
				`TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
		);
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`Cannot read tsconfig.json, whose jsx option decides the file a .tsx source is emitted to: ${messages.join("; ")}`,
			{ file: "tsconfig.json", problems: messages },
		);
	}
	return parsed.options.jsx === ts.JsxEmit.Preserve;
}
