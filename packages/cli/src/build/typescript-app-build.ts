import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import { isJsonObject } from "../json.js";
import { BuildError } from "./errors.js";
import { sha256Bytes } from "./events.js";
import type { BuildArtifact } from "./parse.js";

const GENERATED_APP_ROOT = "src/_generated/app-imprint";
const GENERATED_APP_MANIFEST =
	".hobo/generated/app-imprint/codegen-manifest.json";
const NODE_APP_ROOT = ".hobo/build/node-app";

export interface NodeAppBuiltArtifact {
	readonly artifact: BuildArtifact;
	readonly bytes: Buffer;
}

/** Retarget compiler-emitted declarations to the public executable .mjs entries. */
function packageDeclaration(
	content: string,
	source: string,
	generatedRoot: string,
	entryNames: readonly string[],
): string {
	const parsed = ts.createSourceFile(
		source,
		content,
		ts.ScriptTarget.Latest,
		true,
	);
	const edits: { start: number; end: number; value: string }[] = [];
	const visit = (node: ts.Node): void => {
		let literal: ts.Node | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			literal = node.moduleSpecifier;
		else if (ts.isExternalModuleReference(node)) literal = node.expression;
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			literal = node.argument.literal;
		if (
			literal &&
			ts.isStringLiteralLike(literal) &&
			literal.text.startsWith(".")
		) {
			const target = resolve(dirname(source), literal.text);
			const entry = entryNames.find(
				(name) =>
					target === join(generatedRoot, `${name}.js`) ||
					target === join(generatedRoot, `${name}.mjs`),
			);
			if (entry) {
				const path = relative(
					dirname(source),
					join(generatedRoot, `${entry}.mjs`),
				)
					.split(sep)
					.join("/");
				edits.push({
					start: literal.getStart(parsed),
					end: literal.getEnd(),
					value: JSON.stringify(path.startsWith(".") ? path : `./${path}`),
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	let output = content;
	for (const edit of edits.sort((left, right) => right.start - left.start))
		output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
	return output;
}

/**
 * Whether the project's generated output says it is a plain TypeScript app.
 * It reads generated files, so it is evidence only when they are fresh:
 * `runBuild` acts on it before the freshness gate only when every recorded
 * input still matches (`recordedAppInputsMatch`), and otherwise after the gate.
 */
export async function hasGeneratedTypeScriptApp(
	projectRoot: string,
): Promise<boolean> {
	const metadataPath = join(projectRoot, "hobo.bindle.json");
	if (existsSync(metadataPath)) {
		let metadata: unknown;
		try {
			metadata = JSON.parse(await readFile(metadataPath, "utf8"));
		} catch (error) {
			throw new BuildError(
				"HOBO_BUILD_SOURCE_PARSE",
				`Cannot parse hobo.bindle.json: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// An explicit service declaration owns placement, including invalid or
		// empty declarations: never route around its refusal into Node.
		if (isJsonObject(metadata) && Object.hasOwn(metadata, "services"))
			return false;
	}
	if (!existsSync(join(projectRoot, GENERATED_APP_ROOT, "app.ts")))
		return false;
	let manifest: unknown;
	try {
		manifest = JSON.parse(
			await readFile(join(projectRoot, GENERATED_APP_MANIFEST), "utf8"),
		);
	} catch {
		return false;
	}
	return (
		isJsonObject(manifest) &&
		manifest.schema === "hobo.codegen-manifest/v1" &&
		manifest.generatedBy === "hobo codegen" &&
		manifest.guestLanguage === "ts" &&
		Array.isArray(manifest.layout) &&
		manifest.layout.includes(GENERATED_APP_ROOT)
	);
}

/** Package actual compiler-derived app code without evaluating any application module. */
export async function buildTypeScriptApp(
	projectRoot: string,
): Promise<readonly NodeAppBuiltArtifact[]> {
	const root = resolve(projectRoot);
	const generatedRoot = join(root, GENERATED_APP_ROOT);
	const outputRoot = join(root, NODE_APP_ROOT);
	const artifacts = new Map<string, Buffer>();
	const entryNames = ["app", "bindings", "trainables"].filter((name) =>
		existsSync(join(generatedRoot, `${name}.ts`)),
	);
	try {
		const result = await build({
			absWorkingDir: root,
			entryPoints: Object.fromEntries(
				entryNames.map((name) => [name, join(generatedRoot, `${name}.ts`)]),
			),
			outdir: outputRoot,
			outExtension: { ".js": ".mjs" },
			bundle: true,
			splitting: true,
			packages: "external",
			// Preserve the compiler's executable module graph and asset-relative
			// URLs rather than relocating dependencies inside its .mjs files.
			external: ["./runtime/*"],
			format: "esm",
			platform: "node",
			target: "node20",
			write: false,
			logLevel: "silent",
		});
		for (const file of result.outputFiles) {
			const path = relative(root, file.path).split(sep).join("/");
			artifacts.set(path, Buffer.from(file.contents));
		}
		async function copyGenerated(
			directory: string,
			runtime = false,
		): Promise<void> {
			for (const entry of (
				await readdir(directory, { withFileTypes: true })
			).sort((left, right) => left.name.localeCompare(right.name))) {
				const source = join(directory, entry.name);
				if (entry.isSymbolicLink())
					throw new BuildError(
						"HOBO_BUILD_PATH_INVALID",
						"Generated runtime packaging refuses symbolic links",
					);
				if (entry.isDirectory()) {
					await copyGenerated(
						source,
						runtime || source === join(generatedRoot, "runtime"),
					);
					continue;
				}
				if (!entry.isFile())
					throw new BuildError(
						"HOBO_BUILD_PATH_INVALID",
						"Generated runtime packaging requires ordinary files",
					);
				// Declaration files are compiler output, including the complete
				// authored type graph. Keep their relative imports beside the
				// executable runtime so consumers need no original source tree.
				if (!runtime && !/\.d\.[cm]?ts$/u.test(entry.name)) continue;
				let target = relative(generatedRoot, source);
				const publicEntry = entryNames.find(
					(name) => target === `${name}.d.ts`,
				);
				if (publicEntry) {
					if (existsSync(join(generatedRoot, `${publicEntry}.d.mts`))) continue;
					target = `${publicEntry}.d.mts`;
				}
				const path = join(NODE_APP_ROOT, target).split(sep).join("/");
				if (artifacts.has(path))
					throw new BuildError(
						"HOBO_BUILD_PATH_INVALID",
						`Node app artifact paths collide: ${path}`,
					);
				const bytes = await readFile(source);
				artifacts.set(
					path,
					/\.d\.[cm]?ts$/u.test(source)
						? Buffer.from(
								packageDeclaration(
									bytes.toString("utf8"),
									source,
									generatedRoot,
									entryNames,
								),
							)
						: bytes,
				);
			}
		}
		await copyGenerated(generatedRoot);
	} catch (error) {
		if (error instanceof BuildError) throw error;
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			`Cannot package TypeScript application: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!artifacts.has(`${NODE_APP_ROOT}/app.mjs`))
		throw new BuildError(
			"HOBO_BUILD_SOURCE_MISSING",
			"TypeScript app bundler emitted no app.mjs entrypoint",
		);
	for (const entry of entryNames)
		if (!artifacts.has(`${NODE_APP_ROOT}/${entry}.d.mts`))
			throw new BuildError(
				"HOBO_BUILD_SOURCE_MISSING",
				`TypeScript app codegen emitted no ${entry}.d.mts declaration entrypoint`,
			);
	return [...artifacts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([path, bytes]) => ({
			artifact: {
				service: "app",
				kind: "node-app",
				runtime: "node",
				path,
				mediaType: /\.[cm]?js$/u.test(path)
					? "application/javascript"
					: path.endsWith(".css")
						? "text/css"
						: "application/octet-stream",
				digest: sha256Bytes(bytes),
				source: `${GENERATED_APP_ROOT}/app.ts`,
			},
			bytes,
		}));
}
