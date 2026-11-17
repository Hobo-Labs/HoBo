import {
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
} from "./json.js";

interface DiscoveryEnv {
	[key: string]: string;
}

import type {
	BindleDefinition,
	ContainerDependencyOptions,
	ExternalDependencyOptions,
	ProviderAnnotation,
	WasmComponentDependencyOptions,
} from "./types.js";

/** Required Camp component-host runtimes implied by bindle dependencies. */
export type RequiredRuntimeKind = "wasm" | "oci";

// public-contract: serialized option name read by brokers and Camp hosts.
export const DEPENDENCY_OPTION = "dependency" as const;

/**
 * Build the dependency annotation stored on external/container/wasm-component
 * resources (and readable by broker + Camp hosts).
 */
export function dependencyAnnotation(config: {
	readonly runtime: "wasm" | "oci" | "none";
	readonly kind: "external" | "container" | "wasm-component";
	readonly image?: string;
	readonly source?: string;
	readonly witWorld?: string;
	readonly endpoints?: JsonObject;
	readonly connectionString?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly managedBy?: {
		readonly provider: string;
		readonly via: "marketplace";
	};
}): ProviderAnnotation {
	const frozen: JsonBag = {
		runtime: config.runtime,
		kind: config.kind,
	};
	if (config.image !== undefined) frozen.image = config.image;
	if (config.source !== undefined) frozen.source = config.source;
	if (config.witWorld !== undefined) frozen.witWorld = config.witWorld;
	if (config.endpoints !== undefined)
		frozen.endpoints = { ...config.endpoints };
	if (config.connectionString !== undefined) {
		frozen.connectionString = config.connectionString;
	}
	if (config.env !== undefined) frozen.env = { ...config.env };
	if (config.managedBy !== undefined)
		frozen.managedBy = {
			provider: config.managedBy.provider,
			via: config.managedBy.via,
		};
	return Object.freeze({
		provider: "hobo",
		option: DEPENDENCY_OPTION,
		config: Object.freeze(frozen),
	});
}

export function externalDependencyAnnotation(
	options: ExternalDependencyOptions = {},
): ProviderAnnotation {
	return dependencyAnnotation({
		runtime: "none",
		kind: "external",
		...(options.connectionString !== undefined
			? { connectionString: options.connectionString }
			: undefined),
		...(options.endpoints !== undefined
			? { endpoints: options.endpoints }
			: undefined),
		...(options.managedBy !== undefined
			? { managedBy: options.managedBy }
			: undefined),
	});
}

export function containerDependencyAnnotation(
	options: ContainerDependencyOptions,
): ProviderAnnotation {
	if (!isJsonString(options.image) || options.image.length === 0) {
		throw new TypeError("container() requires a non-empty image ref");
	}
	return dependencyAnnotation({
		runtime: "oci",
		kind: "container",
		image: options.image,
		...(options.endpoints !== undefined
			? { endpoints: options.endpoints }
			: undefined),
		...(options.env !== undefined ? { env: options.env } : undefined),
	});
}

export function wasmComponentDependencyAnnotation(
	options: WasmComponentDependencyOptions,
): ProviderAnnotation {
	if (!isJsonString(options.source) || options.source.length === 0) {
		throw new TypeError("wasmComponent() requires a non-empty source");
	}
	return dependencyAnnotation({
		runtime: "wasm",
		kind: "wasm-component",
		source: options.source,
		...(options.witWorld !== undefined
			? { witWorld: options.witWorld }
			: undefined),
		...(options.endpoints !== undefined
			? { endpoints: options.endpoints }
			: undefined),
	});
}

export function isDependencyAnnotation(
	annotation: ProviderAnnotation,
): boolean {
	return annotation.option === DEPENDENCY_OPTION;
}

export function dependencyRuntimeOf(
	annotation: ProviderAnnotation,
): "wasm" | "oci" | "none" | undefined {
	if (!isDependencyAnnotation(annotation)) return undefined;
	const runtime = annotation.config.runtime;
	if (runtime === "wasm" || runtime === "oci" || runtime === "none") {
		return runtime;
	}
	return undefined;
}

/**
 * Runtimes the broker must have installed for this bindle to place.
 * - container deps → oci
 * - wasm-component deps → wasm
 * External BYO (runtime: none) does not require a special host runtime.
 */
export function collectRequiredRuntimes(
	definition: BindleDefinition,
): readonly RequiredRuntimeKind[] {
	return requiredRuntimesForResources(definition.resources);
}

/** Runtime hosts implied by the actual resources and dependency annotations. */
export function requiredRuntimesForResources(
	resources: BindleDefinition["resources"],
): readonly RequiredRuntimeKind[] {
	const required = new Set<RequiredRuntimeKind>();
	for (const record of Object.values(resources)) {
		if (record.kind === "container") required.add("oci");
		if (record.kind === "wasm-component") required.add("wasm");
		for (const annotation of record.annotations) {
			const runtime = dependencyRuntimeOf(annotation);
			if (runtime === "wasm" || runtime === "oci") required.add(runtime);
		}
	}
	return Object.freeze([...required].sort());
}

/**
 * Parse dependency config from a resource's annotations (first match).
 */
export function readDependencyConfig(
	annotations: readonly ProviderAnnotation[],
): JsonObject | null {
	for (const annotation of annotations) {
		if (isDependencyAnnotation(annotation)) {
			return annotation.config;
		}
	}
	return null;
}

/**
 * Public endpoint discovery only (ADR-0141).
 * Never emits ConnectionStrings__* or credential-bearing values.
 * Resource access is via WIT links / ctx.bindings — not process env secrets.
 */
export function discoveryEnvForDependency(
	resourceName: string,
	config: JsonObject | null,
	resolved: {
		readonly httpUrl?: string;
		/** Ignored — connection strings must not enter process env (ADR-0141). */
		readonly connectionString?: string;
	},
): DiscoveryEnv {
	return discoveryEndpointsForDependency(resourceName, config, resolved);
}

/** Alias: public HTTP/named endpoints only. */
export function discoveryEndpointsForDependency(
	resourceName: string,
	config: JsonObject | null,
	resolved: {
		readonly httpUrl?: string;
		readonly connectionString?: string;
	},
): DiscoveryEnv {
	const env: DiscoveryEnv = {};
	// Intentionally ignore connectionString — dual-path credential env is banned.
	void resolved.connectionString;
	void config?.connectionString;
	if (resolved.httpUrl !== undefined) {
		env[`services__${resourceName}__http__0`] = resolved.httpUrl;
	} else if (
		config?.endpoints &&
		isJsonObject(config.endpoints) &&
		config.endpoints !== null
	) {
		// SAFETY: assertion required at this I/O or test boundary.
		const endpoints = config.endpoints as JsonObject;
		const http = endpoints.http;
		if (isJsonString(http) && http.length > 0) {
			env[`services__${resourceName}__http__0`] = http;
		}
	}
	return env;
}
