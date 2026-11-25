import { isJsonObject, isJsonString, type JsonObject } from "../json.js";

export const TOPOLOGY_CONTRACT_VERSION = "hobo.topology-objects/v1" as const;

export interface ProviderSelection {
	readonly kind: "provider-selection";
	readonly providerId: string;
	readonly selector: string;
	readonly options: JsonObject;
}

export interface BindleResourceDescriptor {
	readonly kind: string;
	readonly name: string;
	readonly stableId: string;
	readonly portRef: readonly string[];
	readonly providerAgnostic: true;
}

export interface BindleScope {
	readonly kind: "bindle";
	readonly contract: typeof TOPOLOGY_CONTRACT_VERSION;
	readonly name: string;
	readonly source: "programmatic";
	readonly configFile: false;
	readonly providerAgnostic: true;
	readonly providerIds: readonly [];
	readonly resources: readonly BindleResourceDescriptor[];
}

export interface BindleCollector {
	use(resource: BindleResourceInput): BindleResourceDescriptor;
}

function asResourceDescriptor(
	resource: BindleResourceInput,
): BindleResourceDescriptor {
	// SAFETY: resources without toDescriptor are already descriptor records.
	return resource as BindleResourceDescriptor;
}

type BindleResourceView = {
	readonly toDescriptor?: () => BindleResourceDescriptor;
	readonly kind?: string;
	readonly name?: string;
	readonly stableId?: string;
	readonly portRef?: readonly string[];
	readonly provider?: string;
	readonly defaultProvider?: unknown;
	readonly tiers?: unknown;
	readonly bindings?: unknown;
	readonly providerAnnotations?: unknown;
	readonly options?: { readonly providerOptions?: unknown };
	readonly annotations?: { readonly with?: unknown };
};

export type BindleResourceInput = BindleResourceDescriptor | BindleResourceView;

export function bindleScope(
	name: string,
	builder: (collector: BindleCollector) => void,
): BindleScope {
	requireName("bindle name", name);
	if (!(builder instanceof Function)) {
		throw new TypeError("bindle builder must be a function");
	}

	const resources: BindleResourceDescriptor[] = [];
	const byStableId = new Set<string>();
	const collector: BindleCollector = Object.freeze({
		use(resource: BindleResourceInput) {
			assertNoProviderSpecificFields(resource);
			const descriptor = normalizeResourceDescriptor(resource);
			assertNoProviderSpecificFields(descriptor);
			if (byStableId.has(descriptor.stableId)) {
				throw new Error(`duplicate Bindle resource ${descriptor.stableId}`);
			}
			byStableId.add(descriptor.stableId);
			resources.push(descriptor);
			return descriptor;
		},
	});

	builder(collector);

	return deepFreeze({
		kind: "bindle",
		contract: TOPOLOGY_CONTRACT_VERSION,
		name,
		source: "programmatic",
		configFile: false,
		providerAgnostic: true,
		providerIds: [],
		resources,
	});
}

export function descriptorFromHandle(handle: {
	readonly kind: string;
	readonly name: string;
	readonly port?: string;
}): BindleResourceDescriptor {
	const kind = handle.kind === "resource" ? "data" : handle.kind;
	const port =
		handle.port ??
		(kind === "service" || kind === "container" ? "wasi:http" : "hobo:data");
	return deepFreeze({
		kind,
		name: handle.name,
		stableId: `${kind}:${handle.name}`,
		portRef: [port],
		providerAgnostic: true,
	});
}

function normalizeResourceDescriptor(
	resource: BindleResourceInput,
): BindleResourceDescriptor {
	// SAFETY: assertion required at this I/O or test boundary.
	const layout = resource as BindleResourceView;
	const descriptor =
		layout.toDescriptor instanceof Function
			? layout.toDescriptor()
			: // SAFETY: assertion required at this I/O or test boundary.
				asResourceDescriptor(resource);
	if (!isPlainObject(descriptor)) {
		throw new TypeError("Bindle resources must be descriptor objects");
	}

	const kind = String(descriptor.kind);
	const resourceName = String(descriptor.name);
	const stableId = String(descriptor.stableId);
	requireName("resource kind", kind);
	requireName("resource name", resourceName);
	requireName("resource stableId", stableId);
	if (!Array.isArray(descriptor.portRef)) {
		throw new TypeError(`resource ${stableId} portRef must be an array`);
	}
	assertNoProviderSpecificFields(descriptor);

	return deepFreeze({
		kind,
		name: resourceName,
		stableId,
		portRef: [...descriptor.portRef],
		providerAgnostic: true,
	});
}

export function assertNoProviderSpecificFields(
	value: BindleResourceInput,
): void {
	if (!value || !isJsonObject(value)) return;
	// SAFETY: assertion required at this I/O or test boundary.
	const layout = value as BindleResourceView;
	const annotations = layout.annotations?.with;
	const providerOptions = layout.options?.providerOptions;
	if (
		layout.provider ||
		layout.defaultProvider ||
		layout.tiers ||
		layout.bindings ||
		layout.providerAnnotations ||
		providerOptions ||
		annotations
	) {
		throw new Error(
			"provider-specific options belong on Camp mappings, not Bindle resources",
		);
	}
}

function requireName(label: string, value: string): void {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
}

function isPlainObject<T>(value: T): value is T & JsonObject {
	return Boolean(value && isJsonObject(value) && !Array.isArray(value));
}

function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined || Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			deepFreeze(child);
		}
		return Object.freeze(value);
	}
	if (!isJsonObject(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}
