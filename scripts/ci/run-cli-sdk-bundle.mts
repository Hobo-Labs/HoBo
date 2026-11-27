import { createHash } from "node:crypto";
import {
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCliDeclarations } from "./bundle-cli-declarations.mts";
import { bundleCliSdk, prepareCliSdkManifest } from "./bundle-cli-sdk.mts";

const workspacePackages = [
	"backend-routing",
	"bindings",
	"bindles",
	"capability-profiles",
	"cd",
	"cli",
	"cloud",
	"componentize",
	"contracts",
	"core",
	"data",
	"events",
	"fleet",
	"manifest-capability",
	"manifest-declaration",
	"manifest-plan",
	"manifest-request",
	"patterns",
	"policy",
	"storage-sqlite",
];
const pinnedPackages = ["grounding", "training"];
const licenseHash =
	"0aab615b233f9f7dfdaa6b1202c1eb5e76246eb7af091dd2bce6530a2a8b2b74";
const portable = (path: string) => path.replaceAll("\\", "/");
const hash = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

function declarationFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return declarationFiles(path);
		if (!entry.isFile())
			throw new Error(`Unsupported declaration input: ${path}`);
		return path.endsWith(".d.ts") ? [path] : [];
	});
}

export function resetCliSdkDist(root: string, staging: string): void {
	if (realpathSync(join(root, "packages/cli")) === realpathSync(staging))
		throw new Error("CLI SDK staging must not be the source package");
	rmSync(join(staging, "dist"), { recursive: true, force: true });
}

export async function runCliSdkBundle(
	root: string,
	staging: string,
): Promise<void> {
	root = resolve(root);
	staging = resolve(staging);
	const sourceManifest = JSON.parse(
		readFileSync(join(root, "packages/cli/package.json"), "utf8"),
	);
	const prepared = prepareCliSdkManifest(sourceManifest, root);
	const dependencies = Object.keys(prepared.dependencies ?? {}).sort();
	const packages = [
		...workspacePackages.map((name) => ({
			name: `@hobo/${name}`,
			root: join(root, "packages", name),
		})),
		...pinnedPackages.map((name) => ({
			name: `ts-autocode-${name}`,
			root: join(root, "external/ts-autocode/packages", name),
		})),
	];
	const declarationPackages: Record<string, { path: string; license: string }> =
		{};
	const declarationSources: Record<string, string> = {};
	for (const pkg of packages) {
		const manifest = JSON.parse(
			readFileSync(join(pkg.root, "package.json"), "utf8"),
		);
		if (manifest.name !== pkg.name || manifest.license !== "MIT")
			throw new Error(`Unsupported CLI declaration package: ${pkg.name}`);
		const license = pkg.name.startsWith("ts-autocode-")
			? join(root, "external/ts-autocode/LICENSE")
			: pkg.name === "@hobo/cloud"
				? join(root, "LICENSE")
				: join(pkg.root, "LICENSE");
		if (hash(license) !== licenseHash)
			throw new Error(`CLI declaration license changed: ${pkg.name}`);
		declarationPackages[pkg.name] = {
			path: portable(relative(root, pkg.root)),
			license: licenseHash,
		};
		for (const file of declarationFiles(join(pkg.root, "dist")).sort())
			declarationSources[portable(relative(root, file))] = hash(file);
	}
	resetCliSdkDist(root, staging);
	await bundleCliSdk(staging, root);
	bundleCliDeclarations({
		cliDist: join(root, "packages/cli/dist"),
		packages,
		publicImports: dependencies
			.filter((name) => name !== "@types/node")
			.map((name) => ({ source: name, published: name })),
		manifestDependencies: dependencies,
		externalModules: join(root, "node_modules"),
		outputFile: join(staging, "dist/index.d.ts"),
	});
	const argvTypes = join(staging, "dist/argv.d.ts");
	writeFileSync(
		argvTypes,
		'export { parseArgv, CANONICAL_VERBS } from "./index.js";\n',
	);
	const provenancePath = join(staging, "BUNDLE-PROVENANCE.json");
	const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
	provenance.declarationPackages = declarationPackages;
	provenance.declarationSources = declarationSources;
	provenance.outputs["dist/argv.d.ts"] = hash(argvTypes);
	provenance.outputs["dist/index.d.ts"] = hash(
		join(staging, "dist/index.d.ts"),
	);
	writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 4)
		throw new Error("usage: run-cli-sdk-bundle.mts <root> <staging>");
	await runCliSdkBundle(process.argv[2]!, process.argv[3]!);
}
