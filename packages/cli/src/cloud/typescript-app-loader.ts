import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { type BindleDefinition, bindle } from "@hobo/bindles";
import { sha256Bytes } from "../build/events.js";
import { parseBuildManifest } from "../build/parse.js";
import { digest } from "../codegen/text.js";
import {
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "../json.js";
import { BindleImportError } from "../shell/errors.js";

type AppFetchHandler = (request: Request) => Response | Promise<Response>;

interface AppHttpRequest {
	readonly path: string;
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: JsonValue;
	readonly request: Request;
}

interface AppHttpResponse {
	readonly status: number;
	readonly headers?: HeadersInit;
	readonly body?: JsonValue | BodyInit;
}

interface RunPort {
	run(
		request: AppHttpRequest,
	): AppHttpResponse | Response | Promise<AppHttpResponse | Response>;
}

/** Runtime import boundary; each callable is checked before it is invoked. */
export interface AppHttpModule {
	readonly api?: RunPort;
	readonly fetch?: AppFetchHandler;
	readonly default?: AppFetchHandler | { readonly fetch?: AppFetchHandler };
	readonly getAppModule?: (path: string) => AppHttpModule;
}

function contained(root: string, file: string): boolean {
	const path = relative(root, file);
	return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function projectFile(project: string, path: string): string {
	const file = resolve(project, path);
	if (isAbsolute(path) || !contained(resolve(project), file))
		throw new Error(`Application path must be project-relative: ${path}`);
	if (existsSync(file) && !contained(realpathSync(project), realpathSync(file)))
		throw new Error(`Application path escapes the project: ${path}`);
	return file;
}

function runHandler(port: RunPort): AppFetchHandler {
	return async (request) => {
		const url = new URL(request.url);
		const text = ["GET", "HEAD"].includes(request.method)
			? ""
			: await request.clone().text();
		let body: JsonValue = text;
		if (
			text &&
			request.headers.get("content-type")?.includes("application/json")
		) {
			// SAFETY: JSON.parse is the request JSON boundary; malformed input propagates to the host.
			body = JSON.parse(text) as JsonValue;
		}
		const result = await port.run({
			path: `${url.pathname}${url.search}`,
			method: request.method,
			url: request.url,
			headers: Object.fromEntries(request.headers),
			body,
			request,
		});
		if (result instanceof Response) return result;
		const headers = new Headers(result.headers);
		const value = result.body;
		if (value === null || value === undefined || isJsonString(value))
			return new Response(value, { status: result.status, headers });
		if (
			isJsonObject(value) ||
			Array.isArray(value) ||
			value === true ||
			value === false ||
			Number.isFinite(value)
		) {
			if (!headers.has("content-type"))
				headers.set("content-type", "application/json; charset=utf-8");
			return new Response(JSON.stringify(value), {
				status: result.status,
				headers,
			});
		}
		// SAFETY: JSON response branches above leave only the platform BodyInit variants.
		return new Response(value as BodyInit, { status: result.status, headers });
	};
}

/** Reuse the Bindle DSL and its real entrypoint factories for application HTTP surfaces. */
export function httpDefinitionFromModule(
	name: string,
	module: AppHttpModule,
): BindleDefinition | null {
	let handler: AppFetchHandler | undefined;
	if (module.api?.run instanceof Function) handler = runHandler(module.api);
	else if (module.fetch instanceof Function)
		handler = module.fetch.bind(module);
	else if (module.default instanceof Function) handler = module.default;
	else if (module.default?.fetch instanceof Function)
		handler = module.default.fetch.bind(module.default);
	if (!handler) return null;
	const fetch = handler;
	return bindle(name, (b) => ({
		api: b
			.api(() => fetch)
			.with({
				provider: "hobo",
				option: "endpoint",
				config: { external: true },
			}),
	}));
}

async function importApp(file: string): Promise<AppHttpModule> {
	// SAFETY: module callables are checked by httpDefinitionFromModule before invocation.
	return (await import(pathToFileURL(file).href)) as AppHttpModule;
}

/** Authored workspace metadata, rather than generated input paths, grants external read authority. */
async function workspaceRoot(project: string): Promise<string> {
	for (
		let directory = realpathSync(project);
		;
		directory = dirname(directory)
	) {
		const marker = join(directory, "pnpm-workspace.yaml");
		if (existsSync(marker) && contained(directory, realpathSync(marker)))
			return directory;
		const metadata = join(directory, "package.json");
		if (existsSync(metadata)) {
			const value = parseJsonValue(await readFile(metadata, "utf8"));
			if (
				isJsonObject(value) &&
				(Array.isArray(value.workspaces) ||
					(isJsonObject(value.workspaces) &&
						Array.isArray(value.workspaces.packages)))
			)
				return directory;
		}
		if (dirname(directory) === directory) return realpathSync(project);
	}
}

async function sourceSnapshot(project: string): Promise<{
	readonly files: readonly {
		readonly path: string;
		readonly file: string;
		readonly expected: string;
	}[];
	readonly rawBytes: boolean;
}> {
	const file = join(
		project,
		".hobo/generated/app-imprint/codegen-manifest.json",
	);
	if (!existsSync(file)) return { files: [], rawBytes: false };
	const manifest = parseJsonValue(await readFile(file, "utf8"));
	if (!isJsonObject(manifest)) return { files: [], rawBytes: false };
	const authority = await workspaceRoot(project);
	const files: { path: string; file: string; expected: string }[] = [];
	for (const [external, digests] of [
		[false, manifest.sourceDigests],
		[true, manifest.externalSourceDigests],
	] as const) {
		if (!isJsonObject(digests)) continue;
		for (const [path, expected] of Object.entries(digests)) {
			if (!isJsonString(expected) || !/^sha256:[a-f0-9]{64}$/u.test(expected))
				throw new Error(`Invalid application input digest: ${path}`);
			if (
				external &&
				(isAbsolute(path) || !path.startsWith("../") || path.includes("\0"))
			)
				throw new Error(
					`External application input must be workspace-relative: ${path}`,
				);
			const externalFile = external ? resolve(project, path) : undefined;
			if (
				externalFile &&
				existsSync(externalFile) &&
				!contained(authority, realpathSync(externalFile))
			)
				throw new Error(
					`External application input escapes the configured workspace: ${path}`,
				);
			files.push({
				path,
				// External compiler inputs are read only for digest verification, never executed from this path.
				file: externalFile ?? projectFile(project, path),
				expected,
			});
		}
	}
	return { files, rawBytes: manifest.sourceDigestEncoding === "raw" };
}

/**
 * Whether every input the codegen manifest recorded still has the digest it
 * recorded. False when there is no manifest, it records nothing, an input is
 * missing or changed, or the manifest is malformed: the imprint is then not
 * evidence of anything, and only a codegen pass can say what the app is.
 */
export async function recordedAppInputsMatch(
	project: string,
): Promise<boolean> {
	let snapshot: Awaited<ReturnType<typeof sourceSnapshot>>;
	try {
		snapshot = await sourceSnapshot(project);
	} catch {
		return false;
	}
	if (snapshot.files.length === 0) return false;
	for (const { file, expected } of snapshot.files) {
		if (!existsSync(file)) return false;
		const bytes = await readFile(file);
		const actual = snapshot.rawBytes
			? sha256Bytes(bytes)
			: digest(bytes.toString("utf8"));
		if (actual !== expected) return false;
	}
	return true;
}

async function packagedModule(
	project: string,
	entrypoint: string,
): Promise<AppHttpModule | null> {
	const entry = ".hobo/build/node-app/app.mjs";
	const manifestPath = join(project, ".hobo/build/build-manifest.json");
	if (!existsSync(manifestPath) || !existsSync(join(project, entry)))
		return null;
	const manifest = parseBuildManifest(
		parseJsonValue(await readFile(manifestPath, "utf8")),
	);
	const artifacts = manifest.artifacts.filter(
		(artifact) => artifact.kind === "node-app",
	);
	if (!artifacts.some((artifact) => artifact.path === entry))
		throw new Error(
			"Node application entrypoint is missing from the build manifest",
		);
	for (const artifact of artifacts) {
		const file = projectFile(project, artifact.path);
		if (sha256Bytes(await readFile(file)) !== artifact.digest)
			throw new Error(
				`Built application artifact digest mismatch: ${artifact.path}`,
			);
	}
	const snapshot = await sourceSnapshot(project);
	for (const { path, file, expected } of snapshot.files) {
		if (!existsSync(file)) continue;
		const bytes = await readFile(file);
		if (
			(snapshot.rawBytes
				? sha256Bytes(bytes)
				: digest(bytes.toString("utf8"))) !== expected
		)
			throw new Error(
				`Built application is stale for authored source: ${path}; run hobo codegen and hobo build`,
			);
	}
	const module = await importApp(projectFile(project, entry));
	if (!(module.getAppModule instanceof Function))
		throw new Error("Built application does not export getAppModule");
	const selected = module.getAppModule(entrypoint);
	if (!selected)
		throw new Error(
			`Built application does not contain declared entrypoint: ${entrypoint}`,
		);
	return selected;
}

/** Load the declared executable application source, or its verified build when source is unavailable. */
export async function loadTypeScriptHttpDefinition(
	project: string,
): Promise<BindleDefinition | null> {
	const metadataPath = join(project, "hobo.bindle.json");
	if (!existsSync(metadataPath)) return null;
	const metadata = parseJsonValue(await readFile(metadataPath, "utf8"));
	if (
		!isJsonObject(metadata) ||
		metadata.schemaVersion !== "hobo.bindle/v1" ||
		!isJsonString(metadata.entrypoint)
	)
		return null;
	const name =
		isJsonString(metadata.name) && metadata.name
			? metadata.name
			: basename(project);
	const source = projectFile(project, metadata.entrypoint);
	try {
		if (existsSync(source)) {
			try {
				const definition = httpDefinitionFromModule(
					name,
					await importApp(source),
				);
				if (definition) return definition;
			} catch (error) {
				const missingSource = (await sourceSnapshot(project)).files.some(
					({ file }) => !existsSync(file),
				);
				const code = Object(error).code;
				if (
					code !== "ERR_UNKNOWN_FILE_EXTENSION" &&
					!(code === "ERR_MODULE_NOT_FOUND" && missingSource)
				)
					throw error;
			}
		}
		const module = await packagedModule(project, metadata.entrypoint);
		return module ? httpDefinitionFromModule(name, module) : null;
	} catch (error) {
		throw new BindleImportError(source, error);
	}
}
