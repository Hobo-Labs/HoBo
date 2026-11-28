import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	buildOciDescriptor,
	COMPONENT_MEDIA_TYPE,
	PINNED_TOOLCHAIN,
	type WasmComponentArtifact,
	type WasmOciDescriptor,
} from "./componentize.js";
import type { JsonValue } from "./json.js";

const COMPONENTIZE_JS_SPECIFIER = "@bytecodealliance/componentize-js";
const REAL_CONTRACT_SCHEMA = "hobo.componentize.real/v1";
const DEFAULT_ENTRY = "src/service.ts";
const DEFAULT_WORLD_NAME = "hello-bindle";
const DEFAULT_WIT_WORLD = "hobo:examples/hello-bindle@0.1.0";
const DEFAULT_WIT_SOURCE = `package hobo:examples@0.1.0;

world hello-bindle {
  export health: func() -> string;
}
`;
const DISABLED_FEATURES = Object.freeze([
	"random",
	"clocks",
	"stdio",
	"http",
] as const);

// public-contract: minimum byte size for a REAL component. The synthetic
export const REAL_COMPONENT_MIN_BYTES = 1024;

// public-contract: typed fail-closed error for the real lane. Callers that
export class ComponentizeToolchainError extends Error {
	readonly code = "componentize.toolchain_unavailable";
	readonly remediation: string;

	constructor(cause?: string) {
		const detail = cause ? ` (${cause})` : "";
		super(
			`componentize.toolchain_unavailable: ${COMPONENTIZE_JS_SPECIFIER}@${PINNED_TOOLCHAIN.componentizeJs} is not importable${detail}`,
		);
		this.name = "ComponentizeToolchainError";
		this.remediation =
			`Install the pinned toolchain (pnpm add -D ${COMPONENTIZE_JS_SPECIFIER}@${PINNED_TOOLCHAIN.componentizeJs}) ` +
			"or drop the real-lane request to use the synthetic contract-shaped floor (componentizeHelloBindle).";
	}
}

// public-contract: injected implementation seam. Mirrors the componentize-js
export type RealComponentizeImpl = (
	sourcePath: string,
	opts: {
		readonly witPath: string;
		readonly worldName: string;
		readonly disableFeatures: readonly string[];
		readonly env: Readonly<Record<string, string>>;
	},
) => Promise<{ component: Uint8Array }>;

export interface RealComponentizeOptions {
	componentizeImpl?: RealComponentizeImpl;
	importModule?: () => Promise<JsonValue>;
	entry?: string;
	wit?: {
		readonly source: string;
		readonly worldName: string;
		readonly witWorld: string;
	};
}

// public-contract: input mirrors the CLI ComponentizeFn seam.
export interface RealComponentizeInput {
	readonly sourceRoot: string;
	readonly sourceDateEpoch: string;
}

// public-contract: output mirrors the CLI ComponentizeFn seam plus the OCI
export interface RealComponentizeResult {
	readonly component: WasmComponentArtifact;
	readonly oci: WasmOciDescriptor;
}

export interface RealComponentize {
	readonly available: boolean;
	readonly componentize: (
		input: RealComponentizeInput,
	) => Promise<RealComponentizeResult>;
}

// public-contract: factory for the real componentize lane. Probes the
export async function createRealComponentize(
	options: RealComponentizeOptions = {},
): Promise<RealComponentize> {
	if (options.componentizeImpl) {
		const impl = options.componentizeImpl;
		return {
			available: true,
			componentize: (input) => runRealComponentize(impl, input, options),
		};
	}

	const probe = await probeToolchain(options.importModule);
	if (!probe.ok) {
		const error = new ComponentizeToolchainError(probe.cause);
		return {
			available: false,
			componentize: async () => {
				throw error;
			},
		};
	}

	return {
		available: true,
		componentize: (input) => runRealComponentize(probe.impl, input, options),
	};
}

// public-contract: structural validation for REAL component binaries. Does not
export interface RealWasmComponentSummary {
	readonly format: "wasm-component";
	readonly layer: 1;
	readonly byteLength: number;
}

export function validateRealWasmComponent(
	bytes: Uint8Array,
): RealWasmComponentSummary {
	if (
		bytes.byteLength < 8 ||
		bytes[0] !== 0x00 ||
		bytes[1] !== 0x61 ||
		bytes[2] !== 0x73 ||
		bytes[3] !== 0x6d
	) {
		throw new Error("componentize.real.invalid_magic: not a wasm binary");
	}
	if (bytes[6] !== 0x01 || bytes[7] !== 0x00) {
		throw new Error(
			"componentize.real.not_a_component: layer bytes are not component-model (core module or synthetic contract envelope)",
		);
	}
	if (bytes.byteLength <= REAL_COMPONENT_MIN_BYTES) {
		throw new Error(
			`componentize.real.below_synthetic_floor: ${bytes.byteLength} bytes <= ${REAL_COMPONENT_MIN_BYTES}`,
		);
	}
	return Object.freeze({
		format: "wasm-component",
		layer: 1,
		byteLength: bytes.byteLength,
	});
}

type ToolchainProbe =
	| { readonly ok: true; readonly impl: RealComponentizeImpl }
	| { readonly ok: false; readonly cause: string };

async function probeToolchain(
	importModule?: () => Promise<JsonValue>,
): Promise<ToolchainProbe> {
	try {
		const module = await (importModule
			? importModule()
			: import(COMPONENTIZE_JS_SPECIFIER));
		// SAFETY: `const componentize = (module as { componentize?: unknown }).componentize;` is required at this I/O or test boundary.
		const componentize = (module as { componentize?: unknown }).componentize;
		if (!(componentize instanceof Function)) {
			return {
				ok: false,
				cause: "module does not export a componentize function",
			};
		}
		const impl: RealComponentizeImpl = async (sourcePath, opts) => {
			// SAFETY: `const output = (await componentize({` is required at this I/O or test boundary.
			const output = (await componentize({
				sourcePath,
				witPath: opts.witPath,
				worldName: opts.worldName,
				disableFeatures: [...opts.disableFeatures],
				env: { ...opts.env },
			})) as { component: Uint8Array };
			return { component: output.component };
		};
		return { ok: true, impl };
	} catch (error) {
		return {
			ok: false,
			cause: error instanceof Error ? error.message : String(error),
		};
	}
}

async function runRealComponentize(
	impl: RealComponentizeImpl,
	input: RealComponentizeInput,
	options: RealComponentizeOptions,
): Promise<RealComponentizeResult> {
	const epochSeconds = sourceDateEpochToUnixSeconds(input.sourceDateEpoch);
	const entry = options.entry ?? DEFAULT_ENTRY;
	const wit = options.wit ?? {
		source: DEFAULT_WIT_SOURCE,
		worldName: DEFAULT_WORLD_NAME,
		witWorld: DEFAULT_WIT_WORLD,
	};

	const entryPath = join(input.sourceRoot, entry);
	let source: string;
	try {
		source = await readFile(entryPath, "utf8");
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`componentize.real.missing_entry: ${entry} (${cause})`);
	}
	source = source.replaceAll("\r\n", "\n");

	const workspace = await mkdtemp(join(tmpdir(), "hobo-real-componentize-"));
	let bytes: Uint8Array;
	try {
		const jsEntryPath = join(workspace, "src/service.js");
		await mkdir(dirname(jsEntryPath), { recursive: true });
		await writeFile(jsEntryPath, source, "utf8");

		const witPath = join(workspace, "wit");
		await mkdir(witPath, { recursive: true });
		await writeFile(join(witPath, "world.wit"), wit.source, "utf8");

		const output = await impl(jsEntryPath, {
			witPath,
			worldName: wit.worldName,
			disableFeatures: DISABLED_FEATURES,
			env: { SOURCE_DATE_EPOCH: epochSeconds },
		});
		bytes = parseComponentBytes(output);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}

	const metadata = JSON.stringify({
		schema: REAL_CONTRACT_SCHEMA,
		name: wit.worldName,
		witWorld: wit.witWorld,
		sourceDateEpoch: input.sourceDateEpoch,
		entry,
		sourceDigest: sha256Text(source),
		toolchain: PINNED_TOOLCHAIN,
	});

	const component: WasmComponentArtifact = {
		path: `dist/${wit.worldName}.component.wasm`,
		mediaType: COMPONENT_MEDIA_TYPE,
		digest: sha256Bytes(bytes),
		bytes,
		witWorld: wit.witWorld,
		metadata,
	};

	return {
		component,
		oci: buildOciDescriptor(component),
	};
}

function parseComponentBytes(output: { component: Uint8Array }): Uint8Array {
	if (
		!(output.component instanceof Uint8Array) ||
		output.component.length === 0
	) {
		throw new Error(
			"componentize.real.invalid_component_output: expected non-empty Uint8Array component bytes",
		);
	}
	return output.component;
}

import { sourceDateEpochToUnixSeconds } from "./source-date-epoch.js";

function sha256Text(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function sha256Bytes(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
