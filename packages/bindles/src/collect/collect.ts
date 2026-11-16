import { isJsonObject, type JsonObject } from "../json.js";
import {
	canonicalManifestHash,
	MANIFEST_SCHEMA,
	type ManifestHash,
	type ManifestV1,
	parseManifest,
} from "../manifest/index.js";
import type { BindleEdge } from "../types.js";
import {
	addContainer,
	type ComponentHandle,
	compileBindleManifest,
	type Handle,
	type ResourceHandle,
	type WiringManifest,
	data as wiringData,
	service as wiringService,
} from "../wiring/index.js";
import { type CollectionEvent, createCollectionEvents } from "./events.js";

// Run-to-collect (S1-12b). The static path (compileBindleManifest) enumerates an
// explicit handle array; run-to-collect instead RUNS the Bindle's components in
// resource-collection mode — the `define` closure declares resources by calling
// the collector — then folds the observed handles through the very same
// compileBindleManifest so the produced manifest IR is byte-identical to the
// static compile (canonicalManifestHash equal). Two runs of one target are
// deterministic. No manifest compilation is reinvented here.

export interface ComponentHostDescriptor {
	readonly kind: string;
	readonly version: string;
}

// The collector a Bindle's components receive while running in collection mode.
// Each factory mirrors a wiring factory, records the handle in declaration
// order, and returns it so bind maps can reference earlier resources.
export interface CollectionContext {
	data(
		name: string,
		options?: { paradigm?: string; allow?: readonly string[] },
	): ResourceHandle;
	service(
		name: string,
		options?: {
			image?: string;
			bind?: Readonly<Record<string, ResourceHandle>>;
			env?: Readonly<Record<string, string>>;
		},
	): ComponentHandle;
	container(
		name: string,
		source: string,
		options?: {
			bind?: Readonly<Record<string, ResourceHandle>>;
			env?: Readonly<Record<string, string>>;
		},
	): ComponentHandle;
}

export interface CollectionTarget {
	readonly bindleId: string;
	readonly componentHost: ComponentHostDescriptor;
	/** Resource ordering edges; connector references are resolved separately. */
	readonly dependencies?: readonly BindleEdge[];
	define(collect: CollectionContext): void;
}

export interface CollectionResult {
	readonly bindleId: string;
	readonly manifest: ManifestV1;
	readonly manifestHash: ManifestHash;
	readonly resources: readonly string[];
	readonly binds: readonly string[];
	readonly events: readonly CollectionEvent[];
}

export class CollectionEngineError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CollectionEngineError";
		this.code = code;
	}
}

// Wrap a compiled WiringManifest (schema + resources, no host) into the full
// manifest IR the rest of HoBo parses — the single seam both the run-to-collect
// engine and any static-compile comparison flow through, guaranteeing hash
// parity by construction.
export function manifestFromWiring(
	wiring: WiringManifest,
	componentHost: ComponentHostDescriptor,
): ManifestV1 {
	return parseManifest({
		schema: MANIFEST_SCHEMA,
		componentHost: { kind: componentHost.kind, version: componentHost.version },
		resources: wiring.resources,
	});
}

export function collectBindleManifest(
	target: CollectionTarget,
): CollectionResult {
	if (!(target?.define instanceof Function)) {
		throw new CollectionEngineError(
			"HOBO_COLLECT_TARGET_INVALID",
			"collection target must expose a define(collect) function",
		);
	}

	const handles: Handle[] = [];
	const collect: CollectionContext = {
		data(name, options) {
			const handle = wiringData(name, options);
			handles.push(handle);
			return handle;
		},
		service(name, options) {
			const handle = wiringService(name, options);
			handles.push(handle);
			return handle;
		},
		container(name, source, options) {
			const handle = addContainer(name, source, options);
			handles.push(handle);
			return handle;
		},
	};

	target.define(Object.freeze(collect));

	const compiled = compileBindleManifest(handles);
	const dependencies = new Map<string, Set<string>>();
	for (const edge of target.dependencies ?? []) {
		if (
			!Object.hasOwn(compiled.resources, edge.from) ||
			!Object.hasOwn(compiled.resources, edge.to)
		)
			throw new CollectionEngineError(
				"HOBO_COLLECT_DEPENDENCY_UNKNOWN",
				`Resource dependency ${edge.from} -> ${edge.to} refers to an undeclared resource`,
			);
		const targets = dependencies.get(edge.from) ?? new Set<string>();
		targets.add(edge.to);
		dependencies.set(edge.from, targets);
	}
	const wiring: WiringManifest = dependencies.size
		? {
				...compiled,
				resources: Object.fromEntries(
					Object.entries(compiled.resources).map(([name, resource]) => {
						const targets = dependencies.get(name);
						return [
							name,
							targets
								? {
										...resource,
										bind: [
											...new Set([...(resource.bind ?? []), ...targets]),
										].sort(),
									}
								: resource,
						];
					}),
				),
			}
		: compiled;
	const manifest = manifestFromWiring(wiring, target.componentHost);
	const manifestHash = canonicalManifestHash(manifest);

	const resources = Object.keys(manifest.value.resources).sort();
	const binds = collectBindKeys(manifest);
	const events = createCollectionEvents({
		bindleId: target.bindleId,
		manifestHash,
		resources,
		binds,
	});

	return Object.freeze({
		bindleId: target.bindleId,
		manifest,
		manifestHash,
		resources: Object.freeze(resources),
		binds: Object.freeze(binds),
		events,
	});
}

function collectBindKeys(manifest: ManifestV1): string[] {
	const keys: string[] = [];
	for (const [id, resource] of Object.entries(manifest.value.resources)) {
		// SAFETY: assertion required at this I/O or test boundary.
		const bindings = (resource as { bindings?: JsonObject }).bindings;
		if (bindings && isJsonObject(bindings)) {
			for (const alias of Object.keys(bindings)) {
				keys.push(`${id}.${alias}`);
			}
		}
	}
	return keys.sort();
}
