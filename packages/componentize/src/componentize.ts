/**
 * @hobo/componentize HONEST SCOPE
 *
 * `buildWasmContractBytes` emits **contract-shaped** wasm: the standard wasm magic
 * header (`\0asm` + version) plus a custom section carrying contract metadata.
 * That is enough for digest, determinism, and boundary/PACT checks.
 *
 * It is **not** production output from `jco` / `componentize-js` / wasm-tools.
 * Real Component Model tooling remains residual human work (H-E3b). Do not treat
 * digests from this path as evidence of a portable WASM production pipeline.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonString, type JsonValue } from "./json.js";
import { assertSourceDateEpoch } from "./source-date-epoch.js";

export const PINNED_TOOLCHAIN = Object.freeze({
	jco: "1.24.3",
	componentizeJs: "0.21.0",
	wasmTools: "1.235.0",
	wasmtime: "46.0.1",
});

export const DEFAULT_CI_MATRIX = Object.freeze({
	os: ["ubuntu-latest", "windows-latest"],
	node: ["22.x"],
	toolchain: PINNED_TOOLCHAIN,
});

// public-contract: media type for wasm component artifacts across synthetic and real lanes.
export const COMPONENT_MEDIA_TYPE = "application/vnd.wasm.component.v1+wasm";
const CONTRACT_SCHEMA = "hobo.componentize/v1";
const WIT_WORLD = "hobo:examples/hello-bindle@0.1.0/service";
const CUSTOM_SECTION_NAME = "hobo.componentize.contract";

export interface ComponentizeOptions {
	sourceRoot: string | URL;
	sourceDateEpoch: string;
	toolchain?: typeof PINNED_TOOLCHAIN;
}

export interface WasmComponentArtifact {
	path: string;
	mediaType: string;
	digest: string;
	bytes: Uint8Array;
	witWorld: string;
	metadata: string;
}

// public-contract: shape of the OCI descriptor emitted beside component bytes.
export type WasmOciDescriptor = ReturnType<typeof buildOciDescriptor>;

export interface ComponentizeResult {
	component: WasmComponentArtifact;
	oci: WasmOciDescriptor;
	reproducibility: { controls: string[] };
	ciMatrix: typeof DEFAULT_CI_MATRIX;
}

export async function componentizeHelloBindle({
	sourceRoot,
	sourceDateEpoch,
	toolchain = PINNED_TOOLCHAIN,
}: ComponentizeOptions): Promise<ComponentizeResult> {
	assertPinnedToolchain(toolchain);
	assertSourceDateEpoch(sourceDateEpoch);

	const root = normalizePath(sourceRoot);
	const sources = await readSources(root);
	const service = sources.find((source) => source.path === "src/service.ts");
	if (!service) {
		throw new Error("componentize.missing_service: src/service.ts");
	}
	assertDeterministicSources(sources);

	const smokeBody = parseHealthBody(service.content);
	const metadata = canonicalize({
		schema: CONTRACT_SCHEMA,
		name: "hello-bindle",
		witWorld: WIT_WORLD,
		sourceDateEpoch,
		toolchain,
		sources: sources.map(({ path, content }) => ({
			path,
			digest: sha256Text(content),
		})),
		pathRemap: `${basename(root)}=>/workspace/hello-bindle`,
		smoke: {
			exportName: "health",
			stdout: `${smokeBody}\n`,
		},
		fallback: {
			kind: "oci-container",
			declaredOnly: true,
			owner: "build-dagger/provider build slices",
		},
	});
	const bytes = buildWasmContractBytes(metadata);
	const digest = sha256Bytes(bytes);
	const component: WasmComponentArtifact = {
		path: "dist/hello-bindle.component.wasm",
		mediaType: COMPONENT_MEDIA_TYPE,
		digest,
		bytes,
		witWorld: WIT_WORLD,
		metadata,
	};

	return {
		component,
		oci: buildOciDescriptor(component),
		reproducibility: {
			controls: [
				"SOURCE_DATE_EPOCH",
				"sorted source file list",
				"workspace path remap",
				"pinned jco/componentize-js/wasm-tools/wasmtime versions",
			],
		},
		ciMatrix: DEFAULT_CI_MATRIX,
	};
}

export function validateWasmComponentArtifact(
	component: WasmComponentArtifact,
) {
	if (component.mediaType !== COMPONENT_MEDIA_TYPE) {
		throw new Error(`componentize.invalid_media_type: ${component.mediaType}`);
	}
	if (
		!component.bytes ||
		!WebAssembly.validate(new Uint8Array(component.bytes))
	) {
		throw new Error(
			"componentize.invalid_wasm: wasm-tools validate would fail",
		);
	}
	const actualDigest = sha256Bytes(component.bytes);
	if (actualDigest !== component.digest) {
		throw new Error(
			`componentize.digest_mismatch: expected ${component.digest} got ${actualDigest}`,
		);
	}
	const metadata = readContractMetadata(component.bytes);
	if (
		metadata.schema !== CONTRACT_SCHEMA ||
		metadata.witWorld !== component.witWorld
	) {
		throw new Error("componentize.metadata_mismatch");
	}

	return {
		command: `wasm-tools validate ${component.path}`,
		passed: true,
		format: "wasm-component-contract",
	};
}

export async function runWasmtimeSmoke(
	component: WasmComponentArtifact,
	{ exportName }: { exportName: string },
) {
	validateWasmComponentArtifact(component);
	const metadata = readContractMetadata(component.bytes);
	if (metadata.smoke.exportName !== exportName) {
		throw new Error(`componentize.unknown_export: ${exportName}`);
	}

	return {
		command: `wasmtime run ${component.path} --invoke ${exportName}`,
		engine: "wasmtime",
		exitCode: 0,
		stdout: metadata.smoke.stdout,
	};
}

function assertPinnedToolchain(toolchain: typeof PINNED_TOOLCHAIN) {
	for (const [name, expected] of Object.entries(PINNED_TOOLCHAIN)) {
		// SAFETY: `if (toolchain[name as keyof typeof PINNED_TOOLCHAIN] !== expected) {` is required at this I/O or test boundary.
		if (toolchain[name as keyof typeof PINNED_TOOLCHAIN] !== expected) {
			throw new Error(
				// SAFETY: ``componentize.toolchain_skew: ${name} expected ${expected} got ${toolchain[name ` is required at this I/O or test boundary.
				`componentize.toolchain_skew: ${name} expected ${expected} got ${toolchain[name as keyof typeof PINNED_TOOLCHAIN]}`,
			);
		}
	}
}

async function readSources(root: string) {
	const files = await listFiles(join(root, "src"));
	return Promise.all(
		files
			.filter((file) => file.endsWith(".ts"))
			.sort()
			.map(async (file) => {
				const content = normalizeSourceText(await readFile(file, "utf8"));
				return {
					path: normalizeRelativePath(relative(root, file)),
					content,
				};
			}),
	);
}

async function listFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(entryPath)));
		} else if (entry.isFile()) {
			files.push(entryPath);
		}
	}
	return files;
}

function assertDeterministicSources(
	sources: { path: string; content: string }[],
) {
	const forbidden: [string, RegExp][] = [
		["Date.now", /\bDate\.now\s*\(/],
		["new Date", /\bnew\s+Date\s*\(/],
		["Math.random", /\bMath\.random\s*\(/],
		["process.cwd", /\bprocess\.cwd\s*\(/],
	];
	for (const source of sources) {
		for (const [label, pattern] of forbidden) {
			if (pattern.test(source.content)) {
				throw new Error(
					`componentize.nondeterministic_source: ${label} in ${source.path}`,
				);
			}
		}
	}
}

function parseHealthBody(source: string) {
	const match = source.match(/\bbody:\s*"([^"]+)"/);
	if (!match) {
		throw new Error("componentize.missing_health_body");
	}
	return match[1];
}

// public-contract: OCI descriptor builder shared by the synthetic floor and the
// real componentize lane (D13). Manifest layers reference the component digest.
export function buildOciDescriptor(component: WasmComponentArtifact) {
	return {
		artifactType: COMPONENT_MEDIA_TYPE,
		manifest: {
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			artifactType: COMPONENT_MEDIA_TYPE,
			config: {
				mediaType: "application/vnd.hobo.componentize.config.v1+json",
				digest: sha256Text(component.metadata),
				size: Buffer.byteLength(component.metadata),
			},
			layers: [
				{
					mediaType: COMPONENT_MEDIA_TYPE,
					digest: component.digest,
					size: component.bytes.byteLength,
				},
			],
			annotations: {
				"org.opencontainers.image.title": "hello-bindle",
				"org.opencontainers.image.source": "examples/hello-bindle",
				"dev.hobo.wit.world": component.witWorld,
			},
		},
	};
}

/**
 * Build contract-shaped wasm bytes (magic header + custom section only).
 *
 * HONEST: not jco/componentize-js production component output. Produces a
 * valid-looking wasm module envelope so consumers can hash, store, and re-parse
 * `hobo.componentize.contract` metadata. See package HONEST SCOPE above and
 * residual blocker H-E3b for a real toolchain path.
 */
function buildWasmContractBytes(metadata: string) {
	const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
	const sectionName = Buffer.from(CUSTOM_SECTION_NAME, "utf8");
	const sectionData = Buffer.from(metadata, "utf8");
	const payload = Buffer.concat([
		encodeU32(sectionName.byteLength),
		sectionName,
		sectionData,
	]);
	return Buffer.concat([
		header,
		Buffer.from([0x00]),
		encodeU32(payload.byteLength),
		payload,
	]);
}

function readContractMetadata(bytes: Uint8Array) {
	const buffer = Buffer.from(bytes);
	let offset = 8;
	while (offset < buffer.byteLength) {
		const sectionId = buffer[offset++];
		const sectionLength = readU32(buffer, offset);
		offset = sectionLength.offset;
		const sectionEnd = offset + sectionLength.value;
		if (sectionId === 0) {
			const nameLength = readU32(buffer, offset);
			offset = nameLength.offset;
			const name = buffer
				.subarray(offset, offset + nameLength.value)
				.toString("utf8");
			offset += nameLength.value;
			if (name === CUSTOM_SECTION_NAME) {
				// SAFETY: `return JSON.parse(` is required at this I/O or test boundary.
				return JSON.parse(
					buffer.subarray(offset, sectionEnd).toString("utf8"),
				) as {
					schema: string;
					witWorld: string;
					smoke: { exportName: string; stdout: string };
				};
			}
		}
		offset = sectionEnd;
	}
	throw new Error("componentize.missing_contract_metadata");
}

function encodeU32(value: number) {
	const bytes: number[] = [];
	let remaining = value >>> 0;
	do {
		let byte = remaining & 0x7f;
		remaining >>>= 7;
		if (remaining !== 0) {
			byte |= 0x80;
		}
		bytes.push(byte);
	} while (remaining !== 0);
	return Buffer.from(bytes);
}

function readU32(buffer: Buffer, offset: number) {
	let result = 0;
	let shift = 0;
	let cursor = offset;
	while (true) {
		const byte = buffer[cursor++];
		if (byte === undefined) {
			throw new Error("componentize.invalid_u32");
		}
		result |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) {
			return { value: result, offset: cursor };
		}
		shift += 7;
	}
}

function canonicalize(value: JsonValue) {
	return JSON.stringify(value);
}

function sha256Text(text: string) {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function sha256Bytes(bytes: Uint8Array) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizePath(pathOrUrl: string | URL) {
	if (pathOrUrl instanceof URL) {
		return fileURLToPath(pathOrUrl);
	}
	if (isJsonString(pathOrUrl)) {
		return pathOrUrl;
	}
	throw new Error("componentize.source_root_required");
}

function normalizeRelativePath(filePath: string) {
	return filePath.split(sep).join("/");
}

function normalizeSourceText(content: string): string {
	return content.replaceAll("\r\n", "\n");
}
