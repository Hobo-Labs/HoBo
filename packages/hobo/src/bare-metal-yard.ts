import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BindleDefinition } from "@hobo/bindles";
import { bindleScope, descriptorFromHandle } from "@hobo/bindles/topology";
import { camp } from "@hobo/camps";
import type { YardRuntime } from "@hobo/cli";
import { type Yard, yard } from "@hobo/yards";
import { createDefaultYardRuntime } from "./compose.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";
import {
	BARE_METAL_PROVIDER_ID,
	createBareMetalProvider,
} from "./local-provider.js";
import { defaultHoboHome } from "./hobo-home.js";

// Local Yard: provider-specific control plane on the operator's machine
// (glossary: Yard). `hobo yard init` installs it; `hobo dev` opens the Yard,
// places the project Bindle into a Camp, and runs the Camp's component host
// with Aspire-compatible service discovery (services__*).

// public-contract: yard document schema id persisted under HOBO_HOME.
export const BARE_METAL_YARD_SCHEMA = "hobo.yard/v1" as const;
// public-contract: yard kind discriminator for the bare-metal lane.
export const BARE_METAL_YARD_KIND = "bare-metal" as const;
// public-contract: default yard name when none is supplied.
export const DEFAULT_BARE_METAL_YARD_NAME = "local";
export const DEFAULT_DEV_PORT = 4000;

/**
 * Camp **component host** backend for a local Yard (glossary: Component host
 * is a Camp capability, not the Yard itself).
 * - local: process-local mesh + in-process private components (`@hobo/runtime-local`)
 * - wasm: Wasmtime OS-process sandboxes (`@hobo/runtime-wasm`)
 * - oci: WASM-on-OCI scheduled on Kubernetes (`@hobo/runtime-oci`)
 * - cloud-native: multi-cloud host registry (`@hobo/runtime-cloud-native`)
 *
 * Legacy aliases accepted on read:
 *   bare-metal | runtime-local → local
 *   isolated-wasm → wasm
 * Config field `host` still accepted as alias for `componentHost`.
 */
export const COMPONENT_HOST_KINDS = [
	"local",
	"wasm",
	"oci",
	"cloud-native",
] as const;
export type ComponentHostKind = (typeof COMPONENT_HOST_KINDS)[number];
/** @deprecated use COMPONENT_HOST_KINDS */
export const LOCAL_HOST_KINDS = COMPONENT_HOST_KINDS;
/** @deprecated use ComponentHostKind */
export type LocalHostKind = ComponentHostKind;
/**
 * Scaffold default before broker-runtime equip. `hobo yard init` / broker-runtime
 * prefer wasm when tooling is available; explicit `--host` always wins.
 */
// public-contract: default component-host kind when `--host` is not given.
export const DEFAULT_COMPONENT_HOST: ComponentHostKind = "local";
/** @deprecated use DEFAULT_COMPONENT_HOST */
export const DEFAULT_LOCAL_HOST = DEFAULT_COMPONENT_HOST;

export function normalizeComponentHostKind(
	raw: JsonValue | undefined,
): ComponentHostKind {
	if (raw === undefined || raw === null) return DEFAULT_COMPONENT_HOST;
	if (raw === "bare-metal" || raw === "runtime-local") return "local";
	if (raw === "isolated-wasm") return "wasm";
	// SAFETY: assertion required at this I/O or test boundary.
	if ((COMPONENT_HOST_KINDS as readonly string[]).includes(String(raw))) {
		// SAFETY: assertion required at this I/O or test boundary.
		return raw as ComponentHostKind;
	}
	throw new TypeError(
		`yard config componentHost must be one of ${COMPONENT_HOST_KINDS.join("|")} (aliases: isolated-wasm→wasm, bare-metal|runtime-local→local) (got ${String(raw)})`,
	);
}

export interface BareMetalYardConfig {
	readonly schemaVersion: typeof BARE_METAL_YARD_SCHEMA;
	readonly kind: typeof BARE_METAL_YARD_KIND;
	readonly name: string;
	readonly dataDir: string;
	readonly providerId: typeof BARE_METAL_PROVIDER_ID;
	readonly defaultPort: number;
	/**
	 * Camp component-host backend for placements on this Yard
	 * (`local` | `wasm` | `oci` | `cloud-native`). Prefer this over legacy `host`.
	 */
	readonly componentHost: ComponentHostKind;
	/** @deprecated alias of componentHost — still serialized for older configs */
	readonly host: ComponentHostKind;
}

export interface BareMetalYard {
	readonly config: BareMetalYardConfig;
	readonly runtime: YardRuntime;
	readonly close: () => void;
}

export { defaultHoboHome } from "./hobo-home.js";

export function yardConfigPath(hoboHome: string): string {
	return join(hoboHome, "yard.json");
}

export function defaultYardDataDir(hoboHome: string, name: string): string {
	return join(hoboHome, "yards", name);
}

export function parseBareMetalYardConfig(
	input: JsonValue | undefined,
): BareMetalYardConfig {
	if (input === null || !isJsonObject(input) || Array.isArray(input)) {
		throw new TypeError("yard config must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = input as JsonObject;
	if (raw.schemaVersion !== BARE_METAL_YARD_SCHEMA) {
		throw new TypeError(
			`yard config schemaVersion must be ${BARE_METAL_YARD_SCHEMA}`,
		);
	}
	if (raw.kind !== BARE_METAL_YARD_KIND) {
		throw new TypeError(`yard config kind must be ${BARE_METAL_YARD_KIND}`);
	}
	if (!isJsonString(raw.name) || raw.name.length === 0) {
		throw new TypeError("yard config name must be a non-empty string");
	}
	if (!isJsonString(raw.dataDir) || raw.dataDir.length === 0) {
		throw new TypeError("yard config dataDir must be a non-empty string");
	}
	if (raw.providerId !== BARE_METAL_PROVIDER_ID) {
		throw new TypeError(
			`yard config providerId must be ${BARE_METAL_PROVIDER_ID}`,
		);
	}
	const defaultPort =
		isJsonNumber(raw.defaultPort) && Number.isInteger(raw.defaultPort)
			? raw.defaultPort
			: DEFAULT_DEV_PORT;
	// Accept either componentHost or legacy host field.
	const componentHost = normalizeComponentHostKind(
		raw.componentHost ?? raw.host,
	);
	return {
		schemaVersion: BARE_METAL_YARD_SCHEMA,
		kind: BARE_METAL_YARD_KIND,
		name: raw.name,
		dataDir: raw.dataDir,
		providerId: BARE_METAL_PROVIDER_ID,
		defaultPort,
		componentHost,
		host: componentHost,
	};
}

export function scaffoldBareMetalYardConfig(
	options: {
		readonly hoboHome?: string;
		readonly name?: string;
		readonly dataDir?: string;
		readonly defaultPort?: number;
		readonly componentHost?: ComponentHostKind;
		/** @deprecated use componentHost */
		readonly host?: ComponentHostKind;
	} = {},
): BareMetalYardConfig {
	const hoboHome = options.hoboHome ?? defaultHoboHome();
	const name = options.name ?? DEFAULT_BARE_METAL_YARD_NAME;
	const componentHost = normalizeComponentHostKind(
		options.componentHost ?? options.host ?? DEFAULT_COMPONENT_HOST,
	);
	return {
		schemaVersion: BARE_METAL_YARD_SCHEMA,
		kind: BARE_METAL_YARD_KIND,
		name,
		dataDir: options.dataDir ?? defaultYardDataDir(hoboHome, name),
		providerId: BARE_METAL_PROVIDER_ID,
		defaultPort: options.defaultPort ?? DEFAULT_DEV_PORT,
		componentHost,
		host: componentHost,
	};
}

export function initBareMetalYard(
	options: {
		readonly hoboHome?: string;
		readonly name?: string;
		readonly dataDir?: string;
		readonly defaultPort?: number;
		readonly componentHost?: ComponentHostKind;
		/** @deprecated use componentHost */
		readonly host?: ComponentHostKind;
		readonly force?: boolean;
	} = {},
) {
	const hoboHome = options.hoboHome ?? defaultHoboHome();
	const configPath = yardConfigPath(hoboHome);
	if (existsSync(configPath) && options.force !== true) {
		throw new Error(
			`local Yard already configured at ${configPath} — first-run already happened. Run \`hobo yard status\` or pass --force to overwrite`,
		);
	}
	const config = scaffoldBareMetalYardConfig({
		hoboHome,
		...(options.name !== undefined ? { name: options.name } : undefined),
		...(options.dataDir !== undefined
			? { dataDir: options.dataDir }
			: undefined),
		...(options.defaultPort !== undefined
			? { defaultPort: options.defaultPort }
			: undefined),
		...(options.componentHost !== undefined
			? { componentHost: options.componentHost }
			: options.host !== undefined
				? { componentHost: options.host }
				: undefined),
	});
	mkdirSync(hoboHome, { recursive: true });
	mkdirSync(config.dataDir, { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	return { config, configPath };
}

export function loadBareMetalYardConfig(
	hoboHome: string = defaultHoboHome(),
): BareMetalYardConfig | null {
	const configPath = yardConfigPath(hoboHome);
	if (!existsSync(configPath)) {
		return null;
	}
	const text = readFileSync(configPath, "utf8");
	JSON.parse(text);
	return parseBareMetalYardConfig(parseJsonValue(text));
}

/**
 * Open the installed local Yard (or init a default one when missing).
 * Uses the composition root's YardRuntime with a durable dataDir so plan/up
 * facts and Bindle serves share one control-plane scope.
 */
export function openBareMetalYard(
	options: { readonly hoboHome?: string; readonly autoInit?: boolean } = {},
): BareMetalYard {
	const hoboHome = options.hoboHome ?? defaultHoboHome();
	let config = loadBareMetalYardConfig(hoboHome);
	if (config === null) {
		if (options.autoInit === false) {
			throw new Error(
				`no local Yard at ${yardConfigPath(hoboHome)}; run \`hobo yard init\``,
			);
		}
		config = initBareMetalYard({ hoboHome }).config;
	}
	mkdirSync(config.dataDir, { recursive: true });
	const runtime = createDefaultYardRuntime({ dataDir: config.dataDir });
	return {
		config,
		runtime,
		close: () => {
			// SAFETY: assertion required at this I/O or test boundary.
			const store = runtime.store as { close?: () => void };
			store.close?.();
		},
	};
}

/**
 * Compose a real Yard topology for a Bindle deployment:
 * Yard owns provider; Camp is provider-neutral shape (no Bindle ownership).
 * Bindle attaches via deployment request, not Camp fields.
 * (Junction ⊃ Yard ⊃ Camp; Bindle is attached to Yard/Camp at deploy time.)
 */
export function composeBareMetalTopology(
	definition: BindleDefinition,
	options: {
		readonly yardName?: string;
		readonly campEnv?: string;
		readonly dataDir: string;
	},
): Yard {
	// Bindle is collected for side-effect validation only; it is not stored on Camp.
	void bindleScope(definition.name, (collector) => {
		for (const resource of Object.values(definition.resources)) {
			const port =
				resource.kind === "api" ||
				resource.kind === "web" ||
				resource.kind === "service"
					? "wasi:http"
					: resource.kind === "kv"
						? "hobo:key-value"
						: resource.kind === "bucket"
							? "hobo:object-store"
							: "hobo:data";
			collector.use(
				descriptorFromHandle({
					kind: resource.kind,
					name: resource.name,
					port,
				}),
			);
		}
	});

	const homeCamp = camp(options.campEnv ?? "dev", {
		envType: "development",
		require: ["managed-http-runtime"],
		runtimeRequirements: ["local"],
		labels: { bindle: definition.name },
	});

	return yard(options.yardName ?? "bare-metal", {
		provider: BARE_METAL_PROVIDER_ID,
		regions: ["local"],
		componentHosts: ["local", "wasm", "oci"],
		camps: [homeCamp],
		properties: {
			dataDir: options.dataDir,
		},
	});
}

/** Ensure the bare-metal provider is available for topology authoring. */
export function bareMetalProvider() {
	return createBareMetalProvider();
}
