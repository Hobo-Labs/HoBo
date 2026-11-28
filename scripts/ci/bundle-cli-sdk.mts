import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import ts from "typescript";

type Manifest = {
	name: string;
	license?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	exports?: Record<string, { types?: string; default?: string }>;
	files?: string[];
	sideEffects?: boolean;
};

const publicPackages = new Set([
	"@hobo/core",
	"@hobo/policy",
	"@hobo/bindles",
	"@hobo/contracts",
	"@hobo/contract-harness",
	"@hobo/runtime",
	"@hobo/runtime-local",
	"@hobo/storage-sqlite",
	"@hobo/wit",
	"@hobo/cli",
]);
const inputs = new Set([
	"ts-autocode-grounding",
	"ts-autocode-training",
	"@hobo/bindings",
	"@hobo/capability-profiles",
	"@hobo/cd",
	"@hobo/cli",
	"@hobo/cloud",
	"@hobo/componentize",
	"@hobo/data",
	"@hobo/events",
	"@hobo/manifest-capability",
	"@hobo/manifest-declaration",
	"@hobo/manifest-plan",
	"@hobo/patterns",
]);
const expectedDependencies = {
	"@bufbuild/protobuf": "2.12.1",
	"@hobo/bindles": "workspace:*",
	"@hobo/cd": "workspace:*",
	"@hobo/cloud": "workspace:*",
	"@hobo/componentize": "workspace:*",
	"@hobo/core": "workspace:*",
	"@hobo/patterns": "workspace:*",
	esbuild: "^0.25.0",
	"ts-autocode-grounding": "workspace:*",
	"ts-autocode-training": "workspace:*",
	typescript: "^5.9.3",
} satisfies Record<string, string>;
const expectedExternal = new Set([
	"@bufbuild/protobuf",
	"@bufbuild/protobuf/codegenv2",
	"@bufbuild/protobuf/wkt",
	"@hobo/bindles",
	"@hobo/contracts",
	"@hobo/core",
	"@hobo/storage-sqlite",
	"esbuild",
	"typescript",
	"typescript-patterns",
	"zod",
]);
const expectedComputedImports = [
	"packages/cli/dist/cloud/typescript-app-loader.js:import(pathToFileURL(file).href)",
	"packages/cli/dist/cloud/loader.js:import(pathToFileURL(absolute).href)",
	"packages/componentize/dist/real-componentize.js:import(COMPONENTIZE_JS_SPECIFIER)",
];
const licenseHash =
	"0aab615b233f9f7dfdaa6b1202c1eb5e76246eb7af091dd2bce6530a2a8b2b74";
const portable = (path: string) => path.replaceAll("\\", "/");
const hash = (data: string | Buffer) =>
	createHash("sha256").update(data).digest("hex");
const readManifest = (file: string): Manifest =>
	JSON.parse(readFileSync(file, "utf8"));
const sameEntries = (a: Record<string, string>, b: Record<string, string>) =>
	JSON.stringify(Object.entries(a).sort()) ===
	JSON.stringify(Object.entries(b).sort());

export function prepareCliSdkManifest(
	manifest: Manifest,
	root: string,
): Manifest {
	if (manifest.name !== "@hobo/cli") return manifest;
	const expectedExports = {
		".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
		"./argv": { types: "./dist/argv.d.ts", default: "./dist/argv.js" },
	};
	if (JSON.stringify(manifest.exports) !== JSON.stringify(expectedExports))
		throw new Error("CLI SDK bundle has an unsupported export map");
	if (!sameEntries(manifest.dependencies ?? {}, expectedDependencies))
		throw new Error("CLI SDK bundle has unexpected direct dependencies");
	const patterns = readManifest(join(root, "packages/patterns/package.json"));
	const training = readManifest(
		join(root, "external/ts-autocode/packages/training/package.json"),
	);
	if (
		patterns.dependencies?.typescript !== "^6.0.3" ||
		training.dependencies?.typescript !== "^5.9.3" ||
		training.dependencies?.zod !== "^4.4.3" ||
		training.sideEffects !== false ||
		manifest.devDependencies?.["@types/node"] !== "^22.15.29"
	)
		throw new Error("CLI SDK bundle dependency contract changed");
	return {
		...manifest,
		files: [
			"LICENSE",
			"BUNDLE-PROVENANCE.json",
			"dist",
			"patterns",
			"atoms",
			"vocabulary",
		],
		dependencies: {
			"@bufbuild/protobuf": "2.12.1",
			"@hobo/bindles": "workspace:*",
			"@hobo/contracts": "workspace:*",
			"@hobo/core": "workspace:*",
			"@hobo/storage-sqlite": "workspace:*",
			"@types/node": "^22.15.29",
			esbuild: "^0.25.0",
			typescript: "^5.9.3",
			"typescript-patterns": "npm:typescript@6.0.3",
			zod: "^4.4.3",
		},
	};
}

function listFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? listFiles(join(dir, entry.name))
			: entry.isFile()
				? [join(dir, entry.name)]
				: (() => {
						throw new Error(
							`CLI bundle has unsupported asset ${join(dir, entry.name)}`,
						);
					})(),
	);
}

function packageRoot(file: string, root: string): string {
	let current = dirname(file);
	while (current !== root && current.startsWith(`${root}${sep}`)) {
		if (existsSync(join(current, "package.json"))) return current;
		current = dirname(current);
	}
	throw new Error(`CLI bundle input outside package: ${file}`);
}

export async function bundleCliSdk(
	staging: string,
	root: string,
): Promise<void> {
	root = resolve(root);
	const trainingRoot = join(root, "external/ts-autocode/packages/training");
	const training = readManifest(join(trainingRoot, "package.json"));
	const trainingIndex = ts.createSourceFile(
		"index.js",
		readFileSync(join(trainingRoot, "dist/index.js"), "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	const sourceExports = trainingIndex.statements.filter(
		(node) =>
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === "./source.js" &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause) &&
			node.exportClause.elements.some(
				(element) =>
					element.name.text === "discoverInSource" && !element.propertyName,
			),
	);
	if (training.sideEffects !== false || sourceExports.length !== 1)
		throw new Error("CLI training source contract changed");
	const trainingImporter = ts.createSourceFile(
		"trainables.js",
		readFileSync(join(root, "packages/cli/dist/codegen/trainables.js"), "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	const trainingUses: string[] = [];
	const findTrainingUses = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			node.arguments[0] !== undefined &&
			ts.isStringLiteral(node.arguments[0]) &&
			node.arguments[0].text === "ts-autocode-training"
		) {
			const awaited = node.parent;
			const parenthesized = awaited?.parent;
			const accessed = parenthesized?.parent;
			trainingUses.push(
				ts.isAwaitExpression(awaited) &&
					ts.isParenthesizedExpression(parenthesized) &&
					ts.isPropertyAccessExpression(accessed)
					? accessed.name.text
					: "unsupported",
			);
		}
		ts.forEachChild(node, findTrainingUses);
	};
	findTrainingUses(trainingImporter);
	if (trainingUses.length !== 1 || trainingUses[0] !== "discoverInSource")
		throw new Error("CLI training importer contract changed");
	let trainingImports = 0;
	let patternsTypeScriptImports = 0;
	const result = await build({
		absWorkingDir: root,
		entryPoints: [
			join(root, "packages/cli/dist/index.js"),
			join(root, "packages/cli/dist/argv.js"),
		],
		outdir: join(staging, "dist"),
		bundle: true,
		splitting: true,
		format: "esm",
		platform: "node",
		target: "node22",
		metafile: true,
		plugins: [
			{
				name: "cli-sdk",
				setup(builder) {
					builder.onResolve({ filter: /^[^./]/ }, (args) => {
						if (args.path.startsWith("node:"))
							return { path: args.path, external: true };
						if (
							args.path === "typescript" &&
							args.importer.startsWith(join(root, "packages/patterns/"))
						) {
							patternsTypeScriptImports++;
							return { path: "typescript-patterns", external: true };
						}
						const parts = args.path.split("/");
						const name = args.path.startsWith("@")
							? parts.slice(0, 2).join("/")
							: (parts[0] ?? "");
						if (publicPackages.has(name))
							return { path: args.path, external: true };
						if (name === "ts-autocode-training") {
							if (
								args.path !== name ||
								args.importer !==
									join(root, "packages/cli/dist/codegen/trainables.js") ||
								args.kind !== "dynamic-import"
							)
								throw new Error(
									`CLI bundle has unsupported training import: ${args.importer}: ${args.path}`,
								);
							trainingImports++;
							return { path: join(trainingRoot, "dist/source.js") };
						}
						if (name.startsWith("@hobo/") || name === "ts-autocode-grounding") {
							if (args.path !== name || !inputs.has(name))
								throw new Error(
									`CLI bundle has unsupported workspace import: ${args.path}`,
								);
							const packageDir = name.startsWith("@hobo/")
								? join(root, "packages", name.slice(6))
								: join(root, "external/ts-autocode/packages/grounding");
							const pkg = readManifest(join(packageDir, "package.json"));
							const entry =
								name === "ts-autocode-grounding"
									? "./dist/index.js"
									: pkg.exports?.["."]?.default;
							if (pkg.name !== name || entry !== "./dist/index.js")
								throw new Error(
									`CLI bundle has unsupported workspace export: ${name}`,
								);
							return { path: join(packageDir, entry) };
						}
						return { path: args.path, external: true };
					});
				},
			},
		],
	});
	if (trainingImports !== 1 || patternsTypeScriptImports < 1)
		throw new Error("CLI bundle import contract changed");
	const observedExternal = new Set<string>();
	for (const output of Object.values(result.metafile.outputs))
		for (const imported of output.imports) {
			if (imported.external && !imported.path.startsWith("node:"))
				observedExternal.add(imported.path);
		}
	if (
		observedExternal.size !== expectedExternal.size ||
		[...observedExternal].some((name) => !expectedExternal.has(name))
	)
		throw new Error(
			`CLI bundle has unexpected external imports: ${[...observedExternal].sort().join(", ")}`,
		);
	const packages = new Map<string, { path: string; license: string }>();
	const sourceHashes: Record<string, string> = {};
	const computedImports: string[] = [];
	const metaUrls: string[] = [];
	for (const input of Object.keys(result.metafile.inputs).sort()) {
		const file = resolve(root, input);
		const pkgRoot = packageRoot(file, root);
		const pkg = readManifest(join(pkgRoot, "package.json"));
		if (!inputs.has(pkg.name) || pkg.license !== "MIT")
			throw new Error(`CLI bundle has unreviewed package: ${pkg.name}`);
		const expectedPackageRoot = pkg.name.startsWith("@hobo/")
			? join(root, "packages", pkg.name.slice(6))
			: join(
					root,
					"external/ts-autocode/packages",
					pkg.name.slice("ts-autocode-".length),
				);
		if (pkgRoot !== expectedPackageRoot)
			throw new Error(`CLI bundle has unexpected package path: ${pkg.name}`);
		let license = join(pkgRoot, "LICENSE");
		if (!existsSync(license))
			license = pkgRoot.startsWith(join(root, "external/ts-autocode/"))
				? join(root, "external/ts-autocode/LICENSE")
				: join(root, "LICENSE");
		if (hash(readFileSync(license)) !== licenseHash)
			throw new Error(`CLI bundle license changed: ${pkg.name}`);
		packages.set(pkg.name, {
			path: portable(relative(root, pkgRoot)),
			license: licenseHash,
		});
		const source = readFileSync(file, "utf8");
		sourceHashes[portable(relative(root, file))] = hash(source);
		const ast = ts.createSourceFile(
			file,
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.JS,
		);
		const visit = (node: ts.Node) => {
			if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				(node.arguments[0] === undefined ||
					!ts.isStringLiteralLike(node.arguments[0]))
			)
				computedImports.push(
					`${portable(relative(root, file))}:${node.getText(ast)}`,
				);
			if (
				ts.isMetaProperty(node) &&
				node.keywordToken === ts.SyntaxKind.ImportKeyword
			)
				metaUrls.push(
					`${portable(relative(root, file))}:${node.parent.getText(ast)}`,
				);
			ts.forEachChild(node, visit);
		};
		visit(ast);
		if (
			portable(relative(root, file)) ===
			"packages/componentize/dist/real-componentize.js"
		) {
			const specifiers: string[] = [];
			const findSpecifier = (node: ts.Node) => {
				if (
					ts.isVariableDeclaration(node) &&
					ts.isIdentifier(node.name) &&
					node.name.text === "COMPONENTIZE_JS_SPECIFIER"
				)
					specifiers.push(
						node.initializer && ts.isStringLiteral(node.initializer)
							? node.initializer.text
							: "unsupported",
					);
				ts.forEachChild(node, findSpecifier);
			};
			findSpecifier(ast);
			if (
				specifiers.length !== 1 ||
				specifiers[0] !== "@bytecodealliance/componentize-js"
			)
				throw new Error("CLI bundle componentize specifier changed");
		}
	}
	const expectedMetaUrls = [
		"packages/patterns/dist/catalog.js:import.meta.url",
		"packages/patterns/dist/catalog.js:import.meta.url",
		"packages/patterns/dist/vocabulary.js:import.meta.url",
	];
	if (
		packages.size !== inputs.size ||
		JSON.stringify(computedImports.sort()) !==
			JSON.stringify(expectedComputedImports.slice().sort()) ||
		JSON.stringify(metaUrls.sort()) !== JSON.stringify(expectedMetaUrls.sort())
	)
		throw new Error("CLI bundle source contract changed");
	for (const name of ["patterns", "atoms", "vocabulary"])
		cpSync(join(root, "packages/patterns", name), join(staging, name), {
			recursive: true,
		});
	for (const template of ["agent", "api", "fullstack", "todo"]) {
		const file = join(
			staging,
			"patterns/starter/cli",
			template,
			"project/.gitignore",
		);
		if (!existsSync(file) || existsSync(`${file}.tpl`))
			throw new Error(`CLI starter gitignore contract changed: ${template}`);
		renameSync(file, `${file}.tpl`);
	}
	const assets: Record<string, string> = {};
	for (const name of ["patterns", "atoms", "vocabulary"])
		for (const file of listFiles(join(staging, name)).sort()) {
			if (basename(file) === ".gitignore")
				throw new Error(`CLI bundle has unreviewed gitignore asset: ${file}`);
			assets[portable(relative(staging, file))] = hash(readFileSync(file));
		}
	const outputs: Record<string, string> = {};
	for (const output of Object.keys(result.metafile.outputs).sort()) {
		const file = resolve(root, output);
		const name = portable(relative(staging, file));
		if (name.startsWith("..") || !name.startsWith("dist/"))
			throw new Error("CLI bundle output escaped staging");
		outputs[name] = hash(readFileSync(file));
	}
	const revisions = {
		hobo: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim(),
		tsAutocode: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: join(root, "external/ts-autocode"),
			encoding: "utf8",
		}).trim(),
	};
	if (
		revisions.tsAutocode !== "ea0a76b6557ad5df6d25103861a4870c7eb9f0ce" ||
		execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
			cwd: join(root, "external/ts-autocode"),
			encoding: "utf8",
		}).trim() !== ""
	)
		throw new Error("CLI bundle training source revision changed");
	writeFileSync(
		join(staging, "BUNDLE-PROVENANCE.json"),
		`${JSON.stringify({ revisions, packages: Object.fromEntries([...packages].sort()), sourceHashes, outputs, assets }, null, 2)}\n`,
	);
}
