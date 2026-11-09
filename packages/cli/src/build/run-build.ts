import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createRealComponentize } from "@hobo/componentize";
import { recordedAppInputsMatch } from "../cloud/typescript-app-loader.js";
import type { CodegenFixtureOptions } from "../codegen/fixture.js";
import { recoverGeneratedTree, writeGeneratedTree } from "../codegen/tree.js";
import { CodegenArtifactSchema } from "../codegen/types.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../json.js";
import {
	assertGeneratedFresh,
	writeCodegenFixtureProject,
} from "./codegen-gate.js";
import {
	adaptRealComponentize,
	type ComponentizeFn,
	defaultComponentize,
	toWasmBuildArtifact,
} from "./componentize-adapter.js";
import {
	buildContainerImage,
	type ContainerBuildFn,
} from "./container-build.js";
import { BuildError } from "./errors.js";
import {
	appendEvent,
	type BuildEvent,
	projectBuildManifest,
	sha256Bytes,
	sha256Text,
	stableStringify,
} from "./events.js";
import {
	type BuildArtifact,
	type BuildRequest,
	type BuildResult,
	parseServiceDeclaration,
	type ServiceDeclaration,
	type TargetRuntime,
} from "./parse.js";
import {
	buildTypeScriptApp,
	hasGeneratedTypeScriptApp,
} from "./typescript-app-build.js";

// public-contract: the documented on-disk location of the build manifest.
export const BUILD_MANIFEST_PATH = ".hobo/build/build-manifest.json";
const BUILD_ARTIFACT_DIR = ".hobo/build/artifacts";

const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_FALLBACK_ARTIFACT_TYPE =
	"application/vnd.hobo.service.oci-fallback.v1+json";

const DEFAULT_SERVICES: readonly ServiceDeclaration[] = Object.freeze([
	Object.freeze({
		name: "hello-bindle",
		language: "ts",
		runtime: "wasm" as const,
		sourceRoot: "services/hello-bindle",
		entrypoint: "services/hello-bindle/src/service.ts",
	}),
	Object.freeze({
		name: "legacy-worker",
		language: "python",
		runtime: "container" as const,
		sourceRoot: "services/legacy-worker",
		entrypoint: "services/legacy-worker/src/app.py",
	}),
]);

export type RunBuildOptions = BuildRequest & {
	readonly componentize?: ComponentizeFn;
	/** Defaults to true. Only explicit library fixtures may select the contract artifact lane. */
	readonly requireRealComponentize?: boolean;
	readonly containerBuild?: ContainerBuildFn;
	// public-contract: test seam for the HOBO_COMPONENTIZE_REAL toolchain probe;
	// defaults to @hobo/componentize createRealComponentize.
	readonly realComponentizeFactory?: typeof createRealComponentize;
};

type BuiltArtifact = {
	readonly artifact: BuildArtifact;
	readonly bytes: Buffer;
};

export async function runBuild(request: RunBuildOptions): Promise<BuildResult> {
	const projectRoot = resolve(request.projectRoot);
	await recoverGeneratedTree(projectRoot);
	const targetRuntime = request.targetRuntime;
	const sourceDateEpoch = request.sourceDateEpoch;
	const requireReal = request.requireRealComponentize !== false;
	const nodeApp = await hasGeneratedTypeScriptApp(projectRoot);

	let events: BuildEvent[] = [
		{
			type: "build.Started",
			runtimeTarget: targetRuntime,
			sourceDateEpoch,
		},
	];

	// The freshness gate regenerates the whole project, so a request that can
	// never build is refused first, but only on inputs that are authoritative
	// without codegen: an explicit empty `services` in hobo.bindle.json, or an
	// imprint whose recorded inputs all still match. A project codegen has not
	// generated (just scaffolded, or cloned without the gitignored .hobo/) is
	// told to run codegen, whatever it asks for.
	if (await declaresNoServices(projectRoot)) throw noServices();
	const runtimeInvalid = new BuildError(
		"HOBO_BUILD_RUNTIME_INVALID",
		`Plain TypeScript app packaging targets Node; explicit ${targetRuntime} requires declared services with that runtime`,
		{ runtime: targetRuntime },
	);
	if (
		nodeApp &&
		targetRuntime !== "auto" &&
		(await recordedAppInputsMatch(projectRoot))
	)
		throw runtimeInvalid;
	await assertGeneratedFreshWrapper(projectRoot);
	if (nodeApp && targetRuntime !== "auto") throw runtimeInvalid;
	const services = nodeApp ? [] : await discoverServices(projectRoot);
	const componentize = services.some(
		(service) => !fallbackReasonFor(service, targetRuntime),
	)
		? (request.componentize ??
			(await selectComponentize(request.realComponentizeFactory, requireReal)))
		: undefined;
	const containerBuild =
		request.containerBuild ?? (requireReal ? buildContainerImage : undefined);
	const builtArtifacts: BuiltArtifact[] = nodeApp
		? [...(await buildTypeScriptApp(projectRoot))]
		: [];
	for (const built of builtArtifacts)
		events = appendEvent(events, {
			type: "build.ArtifactProduced",
			service: built.artifact.service,
			artifact: built.artifact,
		});
	for (const service of services) {
		const built = await buildService({
			projectRoot,
			service,
			targetRuntime,
			sourceDateEpoch,
			componentize,
			containerBuild,
		});
		builtArtifacts.push(built);
		events = appendEvent(events, {
			type: "build.ArtifactProduced",
			service: service.name,
			artifact: built.artifact,
		});
	}

	const manifest = projectBuildManifest(events, targetRuntime, sourceDateEpoch);
	const manifestContent = stableStringify(manifest);
	const manifestDigest = sha256Text(manifestContent);
	await writeGeneratedTree(
		projectRoot,
		[
			...builtArtifacts.map((built) =>
				create(CodegenArtifactSchema, {
					path: built.artifact.path,
					binaryContent: built.bytes,
				}),
			),
			create(CodegenArtifactSchema, {
				path: BUILD_MANIFEST_PATH,
				content: manifestContent,
			}),
		],
		[".hobo/build"],
	);

	events = appendEvent(events, {
		type: "build.Completed",
		manifestDigest,
	});

	return {
		manifest: BUILD_MANIFEST_PATH,
		manifestDigest,
		artifacts: manifest.artifacts,
	};
}

export async function writeBuildFixtureProject(
	projectRoot: string,
	options: {
		readonly services?: readonly ServiceDeclaration[];
		readonly codegen?: CodegenFixtureOptions;
		readonly helloSource?: string;
		readonly legacySource?: string;
	} = {},
): Promise<void> {
	await writeCodegenFixtureProject(projectRoot, options.codegen ?? {});

	const services = options.services ?? DEFAULT_SERVICES;
	const bindlePath = join(projectRoot, "hobo.bindle.json");
	// SAFETY: `const bindle = JSON.parse(await readFile(bindlePath, "utf8")) as {` is required at this I/O or test boundary.
	const bindle = JSON.parse(await readFile(bindlePath, "utf8")) as {
		services?: JsonValue[];
	};
	bindle.services = services.map((service) => ({ ...service }));
	await writeFile(bindlePath, stableStringify(bindle));

	for (const service of services) {
		await writeServiceFixture(
			projectRoot,
			parseServiceDeclaration(service),
			options,
		);
	}
}

// public-contract: HOBO_COMPONENTIZE_REAL=1 selects the real componentize
// lane. When the toolchain is unavailable the build fails closed — it never
// silently falls back to the synthetic floor once the real lane was requested.
async function selectComponentize(
	factory: typeof createRealComponentize = createRealComponentize,
	requireReal = true,
): Promise<ComponentizeFn> {
	if (!requireReal && process.env.HOBO_COMPONENTIZE_REAL !== "1") {
		return defaultComponentize;
	}
	const real = await factory();
	if (!real.available) {
		throw new BuildError(
			"HOBO_BUILD_COMPONENTIZE_TOOLCHAIN",
			"Real componentization is required but @bytecodealliance/componentize-js is not importable; refusing to emit synthetic component bytes",
			{ requested: "real", available: false },
		);
	}
	return adaptRealComponentize(real);
}

async function assertGeneratedFreshWrapper(projectRoot: string): Promise<void> {
	try {
		await assertGeneratedFresh(projectRoot);
	} catch (error) {
		if (error instanceof BuildError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		const code =
			error instanceof Error && "code" in error && isJsonString(error.code)
				? error.code
				: "";
		throw new BuildError(
			"HOBO_BUILD_CODEGEN_FAILED",
			`codegen freshness check failed: ${message}`,
			{
				cause: message,
				code,
			},
		);
	}
}

async function discoverServices(
	projectRoot: string,
): Promise<ServiceDeclaration[]> {
	const bindle = await readJson(projectRoot, "hobo.bindle.json");
	const declared = Array.isArray(bindle.services) ? bindle.services : [];
	const services = declared
		.map((service) => parseServiceDeclaration(service))
		.sort((left, right) => left.name.localeCompare(right.name));

	if (services.length === 0) throw noServices();

	return services;
}

function noServices(): BuildError {
	return new BuildError(
		"HOBO_BUILD_NO_SERVICES",
		"hobo.bindle.json must declare at least one service",
	);
}

/** hobo.bindle.json exists and its own `services` key is an empty list. */
async function declaresNoServices(projectRoot: string): Promise<boolean> {
	let bindle: JsonValue;
	try {
		bindle = parseJsonValue(
			await readFile(join(projectRoot, "hobo.bindle.json"), "utf8"),
		);
	} catch {
		// Missing or unreadable: the gate and discoverServices report it as before.
		return false;
	}
	return (
		isJsonObject(bindle) &&
		Object.hasOwn(bindle, "services") &&
		Array.isArray(bindle.services) &&
		bindle.services.length === 0
	);
}

async function buildService(input: {
	readonly projectRoot: string;
	readonly service: ServiceDeclaration;
	readonly targetRuntime: TargetRuntime;
	readonly sourceDateEpoch: string;
	readonly componentize: ComponentizeFn | undefined;
	readonly containerBuild: ContainerBuildFn | undefined;
}): Promise<BuiltArtifact> {
	const fallbackReason = fallbackReasonFor(input.service, input.targetRuntime);
	if (fallbackReason) {
		if (input.containerBuild)
			return input.containerBuild({
				projectRoot: input.projectRoot,
				service: input.service,
				sourceDateEpoch: input.sourceDateEpoch,
				fallbackReason,
			});
		return buildOciFallback({
			projectRoot: input.projectRoot,
			service: input.service,
			fallbackReason,
		});
	}

	try {
		if (!input.componentize)
			throw new BuildError(
				"HOBO_BUILD_INTERNAL",
				"Service componentizer is unavailable",
			);
		const result = await input.componentize({
			sourceRoot: join(input.projectRoot, input.service.sourceRoot),
			sourceDateEpoch: input.sourceDateEpoch,
		});
		const path = `${BUILD_ARTIFACT_DIR}/${artifactFileStem(input.service.name)}.component.wasm`;
		return {
			artifact: toWasmBuildArtifact(
				input.service.name,
				input.service.entrypoint,
				result.component,
				path,
			),
			bytes: result.component.bytes,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new BuildError(
			"HOBO_BUILD_COMPONENTIZE_FAILED",
			`componentize failed for service "${input.service.name}": ${message}`,
			{
				service: input.service.name,
				cause: message,
			},
		);
	}
}

async function buildOciFallback(input: {
	readonly projectRoot: string;
	readonly service: ServiceDeclaration;
	readonly fallbackReason: string;
}): Promise<BuiltArtifact> {
	const sources = await readServiceSources(input.projectRoot, input.service);
	const sourceIndex = stableStringify({
		schema: "hobo.oci-fallback-sources/v1",
		service: input.service.name,
		language: input.service.language,
		runtime: input.service.runtime,
		entrypoint: input.service.entrypoint,
		sources,
	});
	const config = stableStringify({
		schema: "hobo.oci-fallback-config/v1",
		service: input.service.name,
		reason: input.fallbackReason,
	});
	const manifest = {
		schemaVersion: 2,
		mediaType: OCI_MANIFEST_MEDIA_TYPE,
		artifactType: OCI_FALLBACK_ARTIFACT_TYPE,
		config: {
			mediaType: "application/vnd.hobo.service.config.v1+json",
			digest: sha256Text(config),
			size: Buffer.byteLength(config),
		},
		layers: [
			{
				mediaType: "application/vnd.hobo.service.sources.v1+json",
				digest: sha256Text(sourceIndex),
				size: Buffer.byteLength(sourceIndex),
			},
		],
		annotations: {
			"dev.hobo.service": input.service.name,
			"dev.hobo.fallback.reason": input.fallbackReason,
		},
	};
	const bytes = Buffer.from(stableStringify(manifest), "utf8");
	const path = `${BUILD_ARTIFACT_DIR}/${artifactFileStem(input.service.name)}.oci.json`;

	return {
		artifact: {
			service: input.service.name,
			kind: "oci-container",
			path,
			mediaType: OCI_MANIFEST_MEDIA_TYPE,
			digest: sha256Bytes(bytes),
			runtime: "oci-container",
			fallbackReason: input.fallbackReason,
			source: input.service.entrypoint,
		},
		bytes,
	};
}

function fallbackReasonFor(
	service: ServiceDeclaration,
	targetRuntime: TargetRuntime,
): string | null {
	if (!isWasmLanguage(service.language)) {
		return `unsupported-language: ${service.language}`;
	}
	if (targetRuntime === "container") {
		return "target-runtime: container";
	}
	if (service.runtime === "container") {
		return "declared-runtime: container";
	}
	return null;
}

function isWasmLanguage(language: string): boolean {
	return new Set(["ts", "typescript", "js", "javascript"]).has(language);
}

async function writeServiceFixture(
	projectRoot: string,
	service: ServiceDeclaration,
	options: {
		readonly helloSource?: string;
		readonly legacySource?: string;
	},
): Promise<void> {
	if (service.language === "python") {
		await writeText(
			join(projectRoot, service.entrypoint),
			options.legacySource ?? "def handler(event):\n    return {'ok': True}\n",
		);
		return;
	}

	await writeText(
		join(projectRoot, service.entrypoint),
		options.helloSource ??
			'export const health = () => ({ status: 200, body: "hello from wasm" });\n',
	);
}

async function readServiceSources(
	projectRoot: string,
	service: ServiceDeclaration,
): Promise<Array<{ path: string; digest: string }>> {
	const root = join(projectRoot, service.sourceRoot);
	const files = await listFiles(root);
	if (files.length === 0) {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_MISSING",
			`service "${service.name}" has no source files`,
			{
				service: service.name,
				sourceRoot: service.sourceRoot,
			},
		);
	}

	return Promise.all(
		files.map(async (file) => {
			const content = await readFile(join(root, file), "utf8");
			return {
				path: normalizePath(join(service.sourceRoot, file)),
				digest: sha256Text(normalizeText(content)),
			};
		}),
	);
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];

	async function visit(directory: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new BuildError(
				"HOBO_BUILD_SOURCE_MISSING",
				`Cannot read ${normalizePath(directory)}: ${message}`,
				{
					sourceRoot: normalizePath(root),
				},
			);
		}

		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile()) {
				files.push(normalizePath(relative(root, path)));
			}
		}
	}

	await visit(root);
	return files.sort();
}

async function readJson(
	projectRoot: string,
	path: string,
): Promise<JsonObject> {
	try {
		// SAFETY: `return JSON.parse(` is required at this I/O or test boundary.
		return JSON.parse(
			await readFile(join(projectRoot, path), "utf8"),
		) as JsonObject;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			`Cannot parse ${path}: ${message}`,
			{ file: path },
		);
	}
}

async function writeText(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

function artifactFileStem(serviceName: string): string {
	return serviceName.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

function normalizeText(value: string): string {
	return `${String(value)
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\s+$/u, "")}\n`;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//u, "");
}
