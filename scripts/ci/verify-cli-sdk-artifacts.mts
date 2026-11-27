import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { loadNpmScopeMap } from "./npm-publish-scope.mts";
import { SDK_PACKAGES } from "./sdk-package-list.mts";

const exec = promisify(execFile);
const packageSchema = z.looseObject({
	name: z.string().min(1),
	version: z.string().min(1),
	dependencies: z.record(z.string(), z.string()).optional(),
	optionalDependencies: z.record(z.string(), z.string()).optional(),
	peerDependencies: z.record(z.string(), z.string()).optional(),
});
const artifactsSchema = z.object({
	version: z.string(),
	packages: z.array(
		z.object({ workspace: z.string(), public: z.string(), file: z.string() }),
	),
});
const provenanceSchema = z.looseObject({
	assets: z.record(z.string(), z.string()),
});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const packageProvenanceSchema = z.object({
	path: z.string(),
	license: sha256Schema,
});
const completeProvenanceSchema = provenanceSchema.extend({
	revisions: z.object({
		hobo: z.string().regex(/^[a-f0-9]{40}$/u),
		tsAutocode: z.string().regex(/^[a-f0-9]{40}$/u),
	}),
	packages: z.record(z.string(), packageProvenanceSchema),
	sourceHashes: z.record(z.string(), sha256Schema),
	outputs: z.record(z.string(), sha256Schema),
	declarationPackages: z.record(z.string(), packageProvenanceSchema),
	declarationSources: z.record(z.string(), sha256Schema),
});
type Artifacts = z.infer<typeof artifactsSchema>;
type CompleteProvenance = z.infer<typeof completeProvenanceSchema>;

export function assertCompleteSdkManifest(artifacts: Artifacts): void {
	const actual = artifacts.packages.map((entry) => entry.workspace);
	if (JSON.stringify(actual) !== JSON.stringify(SDK_PACKAGES))
		throw new Error(
			"SDK artifact manifest does not contain the complete ordered SDK allowlist",
		);
	const map = loadNpmScopeMap();
	const files = new Set<string>();
	for (const entry of artifacts.packages) {
		if (map.packages[entry.workspace] !== entry.public)
			throw new Error(`SDK artifact public name mismatch: ${entry.workspace}`);
		if (files.has(entry.file))
			throw new Error("Duplicate SDK artifact filename");
		files.add(entry.file);
	}
}

async function safeExistingFile(root: string, path: string): Promise<string> {
	if (
		!path ||
		path.includes("\\") ||
		path.startsWith("/") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Unsafe CLI provenance path");
	const base = await realpath(root);
	const file = await realpath(resolve(base, path));
	if (!file.startsWith(`${base}${sep}`))
		throw new Error("CLI provenance path escapes its root");
	return file;
}

async function checkHashes(
	root: string,
	entries: Record<string, string>,
	label: string,
): Promise<void> {
	const paths = Object.keys(entries).sort();
	if (paths.length === 0) throw new Error(`CLI provenance has no ${label}`);
	for (let i = 0; i < paths.length; i += 16) {
		await Promise.all(
			paths.slice(i, i + 16).map(async (path) => {
				const file = await safeExistingFile(root, path);
				const actual = createHash("sha256")
					.update(await readFile(file))
					.digest("hex");
				if (actual !== entries[path])
					throw new Error(`CLI provenance ${label} hash mismatch: ${path}`);
			}),
		);
	}
}

async function checkPackageLicenses(
	workspace: string,
	packages: Record<string, z.infer<typeof packageProvenanceSchema>>,
): Promise<void> {
	if (Object.keys(packages).length === 0)
		throw new Error("CLI provenance has no package licenses");
	for (const [name, pkg] of Object.entries(packages)) {
		const manifestFile = await safeExistingFile(
			workspace,
			`${pkg.path}/package.json`,
		);
		const manifest = z
			.object({ name: z.string(), license: z.string() })
			.parse(JSON.parse(await readFile(manifestFile, "utf8")));
		if (manifest.name !== name || manifest.license !== "MIT")
			throw new Error(`CLI provenance package mismatch: ${name}`);
		let licensePath = `${pkg.path}/LICENSE`;
		try {
			await safeExistingFile(workspace, licensePath);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ENOENT"
			)
				throw error;
			licensePath = pkg.path.startsWith("external/ts-autocode/")
				? "external/ts-autocode/LICENSE"
				: "LICENSE";
		}
		await checkHashes(workspace, { [licensePath]: pkg.license }, "license");
	}
}

export async function verifyCliProvenance(
	workspace: string,
	pkg: string,
	provenance: CompleteProvenance,
): Promise<void> {
	const [head, sibling] = await Promise.all([
		exec("git", ["-C", workspace, "rev-parse", "HEAD"]),
		exec("git", [
			"-C",
			join(workspace, "external/ts-autocode"),
			"rev-parse",
			"HEAD",
		]),
	]);
	if (
		head.stdout.trim() !== provenance.revisions.hobo ||
		sibling.stdout.trim() !== provenance.revisions.tsAutocode
	)
		throw new Error("CLI provenance revision mismatch");
	await checkPackageLicenses(workspace, provenance.packages);
	await checkPackageLicenses(workspace, provenance.declarationPackages);
	const licenses = new Set(
		[
			...Object.values(provenance.packages),
			...Object.values(provenance.declarationPackages),
		].map((entry) => entry.license),
	);
	for (const license of licenses)
		await checkHashes(pkg, { LICENSE: license }, "packed license");
	for (const [paths, packages] of [
		[provenance.sourceHashes, provenance.packages],
		[provenance.declarationSources, provenance.declarationPackages],
	] as const) {
		const roots = Object.values(packages).map((entry) => `${entry.path}/`);
		for (const path of Object.keys(paths))
			if (!roots.some((root) => path.startsWith(root)))
				throw new Error("CLI provenance source is outside declared packages");
	}
	await checkHashes(workspace, provenance.sourceHashes, "source");
	await checkHashes(workspace, provenance.declarationSources, "declaration");
	const dist = (await filesUnder(join(pkg, "dist"))).map(
		(name) => `dist/${name.split(sep).join("/")}`,
	);
	const outputPaths = Object.keys(provenance.outputs).sort();
	if (JSON.stringify(dist.sort()) !== JSON.stringify(outputPaths))
		throw new Error("CLI archive dist files differ from recorded outputs");
	await checkHashes(pkg, provenance.outputs, "output");
}

export function isolatedProcessEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		CI: "true",
	};
	for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

type Package = z.infer<typeof packageSchema>;
type RegistryPackage = { manifest: Package; root?: string; archive?: Buffer };
type RegistryIndex = Map<string, Map<string, RegistryPackage>>;

function addPackage(index: RegistryIndex, entry: RegistryPackage): void {
	const versions =
		index.get(entry.manifest.name) ?? new Map<string, RegistryPackage>();
	if (!versions.has(entry.manifest.version))
		versions.set(entry.manifest.version, entry);
	index.set(entry.manifest.name, versions);
}

async function manifestFromArchive(file: string): Promise<Package> {
	const result = await exec("tar", ["-xOzf", file, "package/package.json"], {
		maxBuffer: 4 * 1024 * 1024,
	});
	return packageSchema.parse(JSON.parse(result.stdout));
}

async function indexInstalledPackages(
	workspace: string,
	index: RegistryIndex,
): Promise<void> {
	const store = join(workspace, "node_modules", ".pnpm");
	for (const entry of await readdir(store, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const modules = join(store, entry.name, "node_modules");
		let children;
		try {
			children = await readdir(modules, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of children) {
			if (!child.isDirectory()) continue;
			const scope = join(modules, child.name);
			const roots = child.name.startsWith("@")
				? (await readdir(scope, { withFileTypes: true }))
						.filter((item) => item.isDirectory())
						.map((item) => join(scope, item.name))
				: [scope];
			for (const root of roots) {
				let manifest;
				try {
					manifest = packageSchema.parse(
						JSON.parse(await readFile(join(root, "package.json"), "utf8")),
					);
				} catch {
					continue;
				}
				if (manifest.name.startsWith("@hobo-labs/")) continue;
				addPackage(index, { manifest, root });
			}
		}
	}
}

export function checkDependencyProtocols(manifest: Package): void {
	for (const dependencies of [
		manifest.dependencies,
		manifest.optionalDependencies,
		manifest.peerDependencies,
	])
		for (const spec of Object.values(dependencies ?? {})) {
			const range = /^[A-Za-z0-9.*+^~><=| _-]+$/u;
			const alias =
				/^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[A-Za-z0-9.*+^~><=| _-]+$/u;
			if (!range.test(spec) && !alias.test(spec))
				throw new Error(
					`Package ${manifest.name} uses a non-registry dependency`,
				);
		}
}

export async function packOfflineDependency(
	root: string,
	packDir: string,
	cacheDir: string,
): Promise<Buffer> {
	const dir = await mkdtemp(join(packDir, "pkg-"));
	const source = join(dir, "source");
	await cp(root, source, {
		recursive: true,
		filter: (file) => {
			const parts = relative(root, file).split(sep);
			return !parts.some(
				(part) =>
					part === "node_modules" ||
					part === ".npmrc" ||
					part === ".env" ||
					part.startsWith(".env."),
			);
		},
	});
	const manifest = packageSchema.parse(
		JSON.parse(await readFile(join(source, "package.json"), "utf8")),
	);
	delete manifest.scripts;
	await writeFile(join(source, "package.json"), JSON.stringify(manifest));
	const userConfig = join(dir, "user.npmrc");
	const globalConfig = join(dir, "global.npmrc");
	await writeFile(userConfig, "");
	await writeFile(globalConfig, "");
	const result = await exec(
		"npm",
		[
			"pack",
			"--json",
			"--ignore-scripts",
			"--userconfig",
			userConfig,
			"--globalconfig",
			globalConfig,
			"--offline",
			"--cache",
			cacheDir,
			"--pack-destination",
			dir,
		],
		{
			cwd: source,
			env: isolatedProcessEnv(),
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	const packedResult = z
		.array(z.object({ filename: z.string() }))
		.length(1)
		.parse(JSON.parse(result.stdout));
	const filename = packedResult[0]?.filename;
	if (!filename || filename !== filename.split("/").at(-1))
		throw new Error("Invalid package archive name");
	return readFile(join(dir, filename));
}

async function registry(
	index: RegistryIndex,
	packDir: string,
	cacheDir: string,
): Promise<{ url: string; close: () => Promise<void> }> {
	const archives = new Map<string, Promise<Buffer>>();
	let slots = 3;
	const waiters: (() => void)[] = [];
	const withSlot = async <T,>(work: () => Promise<T>): Promise<T> => {
		if (slots > 0) slots -= 1;
		else await new Promise<void>((done) => waiters.push(done));
		try {
			return await work();
		} finally {
			const next = waiters.shift();
			if (next) next();
			else slots += 1;
		}
	};
	const packed = async (entry: RegistryPackage): Promise<Buffer> => {
		if (entry.archive !== undefined) return entry.archive;
		const root = entry.root;
		if (!root) throw new Error("Registry package has no source");
		const key = `${entry.manifest.name}@${entry.manifest.version}`;
		let work = archives.get(key);
		if (!work) {
			work = withSlot(() => packOfflineDependency(root, packDir, cacheDir));
			archives.set(key, work);
		}
		return work;
	};
	const serve = async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		const url = decodeURIComponent(request.url ?? "");
		const isArchive = url.startsWith("/tar/");
		const key = url.slice(isArchive ? 5 : 1);
		const split = isArchive ? key.lastIndexOf("@") : -1;
		const name = isArchive ? key.slice(0, split) : key;
		const requested = isArchive ? key.slice(split + 1) : undefined;
		const versions = index.get(name);
		if (!versions || (isArchive && (!requested || !versions.has(requested)))) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (requested) {
			const item = versions.get(requested);
			if (!item) throw new Error("Registry archive disappeared");
			response.writeHead(200, { "content-type": "application/octet-stream" });
			response.end(await packed(item));
			return;
		}
		const address = z
			.object({ port: z.number().int().positive() })
			.parse(server.address());
		const versionEntries = await Promise.all(
			[...versions].map(async ([version, item]) => {
				checkDependencyProtocols(item.manifest);
				const bytes = await packed(item);
				return [
					version,
					{
						...item.manifest,
						dist: {
							tarball: `http://127.0.0.1:${address.port}/tar/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
							integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
						},
					},
				] as const;
			}),
		);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({ name, versions: Object.fromEntries(versionEntries) }),
		);
	};
	const server = createServer((request, response) => {
		void serve(request, response).catch(() => {
			response.writeHead(500);
			response.end();
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = z
		.object({ port: z.number().int().positive() })
		.parse(server.address());
	return {
		url: `http://127.0.0.1:${address.port}/`,
		close: () =>
			new Promise<void>((done, fail) =>
				server.close((error) => (error ? fail(error) : done())),
			),
	};
}

async function filesUnder(root: string): Promise<string[]> {
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) await walk(file);
			else if (entry.isFile()) result.push(relative(root, file));
			else throw new Error(`Unexpected archive entry: ${file}`);
		}
	}
	await walk(root);
	return result.sort();
}

async function verifyArchiveBytes(
	archive: string,
	workspace: string,
	temp: string,
): Promise<void> {
	const listing = await exec("tar", ["-tvzf", archive], {
		maxBuffer: 16 * 1024 * 1024,
	});
	for (const line of listing.stdout.split("\n").filter(Boolean))
		if (!line.startsWith("-") && !line.startsWith("d"))
			throw new Error("CLI archive contains a link or unsupported entry");
	const names = await exec("tar", ["-tzf", archive], {
		maxBuffer: 16 * 1024 * 1024,
	});
	for (const name of names.stdout.split("\n").filter(Boolean))
		if (!name.startsWith("package/") || name.split("/").includes(".."))
			throw new Error("CLI archive contains an unsafe path");
	const unpacked = join(temp, "archive");
	await mkdir(unpacked);
	await exec("tar", ["-xzf", archive, "-C", unpacked]);
	const pkg = join(unpacked, "package");
	const provenance = provenanceSchema.parse(
		JSON.parse(await readFile(join(pkg, "BUNDLE-PROVENANCE.json"), "utf8")),
	);
	const expected: string[] = [];
	for (const assetRoot of ["patterns", "atoms", "vocabulary"]) {
		const source = join(workspace, "packages/patterns", assetRoot);
		for (const name of await filesUnder(source))
			expected.push(
				join(assetRoot, name).replace(/\/\.gitignore$/u, "/.gitignore.tpl"),
			);
	}
	const actual = Object.keys(provenance.assets).sort();
	if (JSON.stringify(expected.sort()) !== JSON.stringify(actual))
		throw new Error("CLI archive asset list differs from the source");
	for (const asset of actual) {
		const source = join(
			workspace,
			"packages/patterns",
			asset.replace(/\/\.gitignore\.tpl$/u, "/.gitignore"),
		);
		const archived = await readFile(join(pkg, asset));
		if (
			!(await readFile(source)).equals(archived) ||
			createHash("sha256").update(archived).digest("hex") !==
				provenance.assets[asset]
		)
			throw new Error(`CLI archive asset bytes differ: ${asset}`);
	}
	await verifyCliProvenance(
		workspace,
		pkg,
		completeProvenanceSchema.parse(provenance),
	);
}

export async function verifyCliSdkArtifacts(
	stage: string,
	workspace: string,
): Promise<void> {
	const artifacts = artifactsSchema.parse(
		JSON.parse(await readFile(join(stage, "MANIFEST.json"), "utf8")),
	);
	const temp = await mkdtemp(join(tmpdir(), "hobo-cli-sdk-verify-"));
	const index: RegistryIndex = new Map();
	try {
		let cliArchive: string | undefined;
		let brokerArchive: string | undefined;
		let pricingArchive: string | undefined;
		let protobufRange: string | undefined;
		for (const pkg of artifacts.packages) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(pkg.file))
				throw new Error("Unsafe SDK artifact name");
			const file = join(stage, pkg.file);
			const manifest = await manifestFromArchive(file);
			checkDependencyProtocols(manifest);
			if (
				manifest.name !== pkg.public ||
				manifest.version !== artifacts.version
			)
				throw new Error(`SDK artifact manifest mismatch: ${pkg.file}`);
			if (index.get(manifest.name)?.has(manifest.version))
				throw new Error(
					`Duplicate SDK artifact: ${manifest.name}@${manifest.version}`,
				);
			addPackage(index, { manifest, archive: await readFile(file) });
			if (pkg.workspace === "@hobo/cli") cliArchive = file;
			if (pkg.workspace === "@hobo/pricing") pricingArchive = file;
			if (pkg.workspace === "@hobo/broker") {
				brokerArchive = file;
				protobufRange = manifest.dependencies?.["@bufbuild/protobuf"];
			}
		}
		if (!cliArchive) throw new Error("Staged SDK has no CLI archive");
		await verifyArchiveBytes(cliArchive, workspace, temp);
		assertCompleteSdkManifest(artifacts);
		if (!brokerArchive) throw new Error("Staged SDK has no broker archive");
		if (!pricingArchive) throw new Error("Staged SDK has no pricing archive");
		if (!protobufRange)
			throw new Error("Staged broker has no protobuf runtime dependency");
		await indexInstalledPackages(workspace, index);
		const cache = join(temp, "npm-cache");
		const packs = join(temp, "packs");
		const consumer = join(temp, "consumer");
		await mkdir(cache);
		await mkdir(packs);
		await mkdir(consumer);
		const userConfig = join(temp, "user.npmrc");
		const globalConfig = join(temp, "global.npmrc");
		await writeFile(userConfig, "");
		await writeFile(globalConfig, "");
		const env = isolatedProcessEnv();
		await writeFile(
			join(consumer, "package.json"),
			JSON.stringify({
				name: "cli-sdk-consumer",
				version: "1.0.0",
				private: true,
				type: "module",
			}),
		);
		const server = await registry(index, packs, cache);
		try {
			const npm = [
				"--registry",
				server.url,
				"--cache",
				cache,
				"--userconfig",
				userConfig,
				"--globalconfig",
				globalConfig,
				"--fetch-retries=0",
			];
			await exec(
				"npm",
				[
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					...npm,
					cliArchive,
					brokerArchive,
					pricingArchive,
					`@bufbuild/protobuf@${protobufRange}`,
				],
				{
					cwd: consumer,
					env,
					maxBuffer: 16 * 1024 * 1024,
					timeout: 300_000,
				},
			);
			await exec("npm", ["ls", "--all", ...npm], {
				cwd: consumer,
				env,
				maxBuffer: 16 * 1024 * 1024,
				timeout: 120_000,
			});
			await cp(
				join(
					dirname(fileURLToPath(import.meta.url)),
					"cli-sdk-acceptance-child.mts",
				),
				join(consumer, "acceptance.mts"),
			);
			await exec(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(consumer, "acceptance.mts"),
					workspace,
				],
				{
					cwd: consumer,
					env,
					maxBuffer: 16 * 1024 * 1024,
					timeout: 120_000,
				},
			);
			await cp(
				join(
					dirname(fileURLToPath(import.meta.url)),
					"financial-sdk-acceptance-child.mts",
				),
				join(consumer, "financial-acceptance.mts"),
			);
			await cp(
				join(
					dirname(fileURLToPath(import.meta.url)),
					"fixtures/financial-sdk-scenario.json",
				),
				join(consumer, "financial-scenario.json"),
			);
			await exec(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(consumer, "financial-acceptance.mts"),
				],
				{ cwd: consumer, env, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
			);
			await writeFile(
				join(consumer, "identity.ts"),
				[
					'import type { DevRuntime, DevBindlePlan } from "@hobo-labs/cli";',
					'import { parseArgv as rootParse, CANONICAL_VERBS as rootVerbs } from "@hobo-labs/cli";',
					'import { parseArgv as subParse, CANONICAL_VERBS as subVerbs } from "@hobo-labs/cli/argv";',
					"const rootToSub: typeof subParse = rootParse; const subToRoot: typeof rootParse = subParse;",
					"const rootVerbsToSub: typeof subVerbs = rootVerbs; const subVerbsToRoot: typeof rootVerbs = subVerbs;",
					"void [rootToSub, subToRoot, rootVerbsToSub, subVerbsToRoot];",
					'import type { ComponentHostPort, Streamer, ParsedComponentDescriptor, ProviderDescriptor, LinkRequest, HttpRequest } from "@hobo-labs/core";',
					"declare const host: ComponentHostPort; declare const streamer: Streamer;",
					"declare const component: ParsedComponentDescriptor; declare const providers: readonly ProviderDescriptor[];",
					"declare const links: readonly LinkRequest[]; declare const probe: HttpRequest;",
					"const plan: DevBindlePlan = { component, providers, links, probe };",
					"const runtime: DevRuntime = { componentHost: host, streamer, plan, readEvents: () => [] }; void runtime;",
				].join("\n"),
			);
			await writeFile(
				join(consumer, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						strict: true,
						noEmit: true,
						target: "ES2022",
						module: "NodeNext",
						moduleResolution: "NodeNext",
						skipLibCheck: false,
					},
					include: ["identity.ts"],
				}),
			);
			await exec(
				process.execPath,
				[
					join(consumer, "node_modules/typescript/bin/tsc"),
					"-p",
					"tsconfig.json",
				],
				{
					cwd: consumer,
					env,
					maxBuffer: 16 * 1024 * 1024,
					timeout: 120_000,
				},
			);
		} finally {
			await server.close();
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
	const stage = process.argv[2];
	const workspace =
		process.argv[3] ??
		resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	if (!stage)
		throw new Error("Usage: verify-cli-sdk-artifacts <stage> [workspace]");
	await verifyCliSdkArtifacts(resolve(stage), resolve(workspace));
	console.log("Staged CLI SDK clean-install acceptance passed");
}
