import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import ts from "typescript";
import { z } from "zod";

type Manifest = {
	name?: string;
	version?: string;
	license?: string;
	dependencies?: Record<string, string>;
};

type Rewrite = { start: number; end: number; value: string };

function filesUnder(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...filesUnder(path));
		else if (entry.isFile()) files.push(path);
		else throw new Error(`Unsupported vendored entry: ${path}`);
	}
	return files;
}

function specifiers(source: ts.SourceFile): ts.StringLiteralLike[] {
	const result: ts.StringLiteralLike[] = [];
	const visit = (node: ts.Node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		)
			result.push(node.moduleSpecifier);
		if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		)
			result.push(node.argument.literal);
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] !== undefined &&
			ts.isStringLiteralLike(node.arguments[0])
		)
			result.push(node.arguments[0]);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return result;
}

export function prepareRuntimeGroundingManifest(
	manifest: Manifest,
	grounding: Manifest,
): Manifest {
	if (
		manifest.name !== "@hobo-labs/runtime" &&
		manifest.name !== "@hobo/runtime"
	)
		throw new Error("The grounding vendor target must be the runtime package");
	if (manifest.dependencies?.["ts-autocode-grounding"] !== "workspace:*")
		throw new Error("Unexpected runtime grounding dependency");
	const parsed = z
		.object({
			name: z.literal("ts-autocode-grounding"),
			license: z.literal("MIT"),
			version: z.string().min(1),
			dependencies: z.object({ typescript: z.string().min(1) }).strict(),
		})
		.safeParse(grounding);
	if (!parsed.success) throw new Error("Unexpected grounding package metadata");
	const version = parsed.data.dependencies.typescript;
	const existing = manifest.dependencies.typescript;
	if (existing !== undefined && existing !== version)
		throw new Error("Runtime and grounding TypeScript ranges disagree");
	const { ["ts-autocode-grounding"]: removed, ...remaining } =
		manifest.dependencies;
	if (removed !== "workspace:*")
		throw new Error("Unexpected runtime grounding dependency");
	const dependencies = { ...remaining, typescript: version };
	return { ...manifest, dependencies };
}

export function vendorRuntimeGrounding(input: {
	runtimeDir: string;
	groundingDir: string;
	licenseFile: string;
}): void {
	const dist = join(input.runtimeDir, "dist");
	const target = join(dist, "_vendor", "ts-autocode-grounding");
	const sourceDist = join(input.groundingDir, "dist");
	const originalFiles = filesUnder(dist);
	const vendoredFiles = filesUnder(sourceDist);
	if (
		!vendoredFiles.some((file) => file === join(sourceDist, "index.js")) ||
		!vendoredFiles.some((file) => file === join(sourceDist, "index.d.ts"))
	)
		throw new Error("Grounding build is missing its runtime or declarations");
	for (const file of vendoredFiles) {
		if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
		const content = readFileSync(file, "utf8");
		const source = ts.createSourceFile(
			file,
			content,
			ts.ScriptTarget.Latest,
			true,
		);
		for (const specifier of specifiers(source)) {
			const value = specifier.text;
			if (
				!value.startsWith(".") &&
				!value.startsWith("node:") &&
				value !== "typescript"
			)
				throw new Error(`Unexpected grounding import: ${value}`);
		}
	}
	mkdirSync(dirname(target), { recursive: true });
	cpSync(sourceDist, target, {
		recursive: true,
		errorOnExist: true,
		force: false,
	});
	cpSync(input.licenseFile, join(target, "LICENSE"), {
		errorOnExist: true,
		force: false,
	});
	let jsCount = 0;
	let declarationsCount = 0;
	for (const file of originalFiles) {
		if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
		const content = readFileSync(file, "utf8");
		const source = ts.createSourceFile(
			file,
			content,
			ts.ScriptTarget.Latest,
			true,
		);
		const rewrites: Rewrite[] = [];
		for (const specifier of specifiers(source)) {
			if (specifier.text !== "ts-autocode-grounding") continue;
			let value = relative(dirname(file), join(target, "index.js"))
				.split(sep)
				.join("/");
			if (!value.startsWith(".")) value = `./${value}`;
			rewrites.push({
				start: specifier.getStart(source) + 1,
				end: specifier.getEnd() - 1,
				value,
			});
		}
		if (rewrites.length === 0) continue;
		let updated = content;
		for (const edit of rewrites.reverse())
			updated =
				updated.slice(0, edit.start) + edit.value + updated.slice(edit.end);
		writeFileSync(file, updated);
		if (file.endsWith(".d.ts")) declarationsCount += rewrites.length;
		else jsCount += rewrites.length;
	}
	if (jsCount === 0 || declarationsCount === 0)
		throw new Error(
			"Runtime grounding imports missing from runtime or declarations",
		);
}
