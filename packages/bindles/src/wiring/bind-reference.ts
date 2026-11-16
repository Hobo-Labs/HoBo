import { parseResourceId } from "@hobo/core";
import { isJsonObject, isJsonString, type JsonObject } from "../json.js";

import {
	BindReferenceError,
	type ComponentHandle,
	type Handle,
	type ResourceHandle,
} from "./errors.js";
import {
	LAZY_TOKEN_PATTERN,
	type ManifestResource,
	RESOURCE_ID_PATTERN,
	type WiringManifest,
} from "./types.js";

export type {
	AnnotationValue,
	BindMountAnnotation,
	ComponentHandle,
	Handle,
	ResourceHandle,
	VolumeAnnotation,
	WaitForEntry,
} from "./errors.js";
export { BindReferenceError } from "./errors.js";

export function data(
	name: string,
	options: { paradigm?: string; allow?: readonly string[] } = {},
): ResourceHandle {
	assertResourceName(name, "data.name");
	const paradigm = options.paradigm ?? "relational";
	const allow = options.allow ? [...new Set(options.allow)].sort() : undefined;

	return {
		kind: "resource",
		name,
		type: "data.v1",
		port: "hobo:data",
		clientType: "DataClient",
		manifest() {
			let resource: ManifestResource = {
				type: "data.v1",
				port: "hobo:data",
				paradigm,
			};
			if (paradigm !== "project")
				resource = {
					...resource,
					connectionString: `{${name}.connectionString}`,
				};
			if (allow?.length) return { ...resource, allow: [...allow] };
			return resource;
		},
	};
}

export function service(
	name: string,
	options: {
		image?: string;
		bind?: Readonly<Record<string, ResourceHandle>>;
		env?: Readonly<Record<string, string>>;
		camp?: string;
	} = {},
): ComponentHandle {
	if (options.camp !== undefined) {
		throw new BindReferenceError(
			`resources.${name}.camp`,
			"cross-Camp placement is resolved by enclosing scopes",
		);
	}

	return componentHandle("service", name, {
		...(options.image !== undefined ? { image: options.image } : undefined),
		...(options.bind !== undefined ? { bind: options.bind } : undefined),
		...(options.env !== undefined ? { env: options.env } : undefined),
	});
}

export function createComponentHandle(
	kind: "service" | "container",
	name: string,
	options: {
		image?: string;
		bind?: Readonly<Record<string, ResourceHandle>>;
		env?: Readonly<Record<string, string>>;
		build?: JsonObject;
	},
): ComponentHandle {
	return componentHandle(kind, name, options);
}

export function compileBindleManifest(
	handles: readonly Handle[],
): WiringManifest {
	const resources: Record<string, ManifestResource> = {};
	const entries: Handle[] = [];

	for (const handle of handles) {
		assertHandle(handle);
		if (resources[handle.name]) {
			throw new BindReferenceError(
				`resources.${handle.name}`,
				"duplicate resource id",
			);
		}
		resources[handle.name] = handle.manifest();
		entries.push(handle);
	}

	for (const handle of entries) {
		if (handle.kind === "service" || handle.kind === "container") {
			validateLinks(handle, resources);
		}
	}

	for (const [id, resource] of Object.entries(resources)) {
		validateLazyReferences(id, resource, resources);
	}

	return {
		schema: "hobo.manifest/v1",
		resources,
	};
}

function componentHandle(
	kind: "service" | "container",
	name: string,
	options: {
		image?: string;
		bind?: Readonly<Record<string, ResourceHandle>>;
		env?: Readonly<Record<string, string>>;
		build?: JsonObject;
	},
): ComponentHandle {
	assertResourceName(name, `${kind}.name`);

	const bind = normalizeBindMap(options.bind);
	const bindings = Object.fromEntries(
		Object.entries(bind).map(([alias, target]) => [
			alias,
			{
				port: target.port,
				resource: target.name,
				clientType: target.clientType,
			},
		]),
	);

	const handle: ComponentHandle = {
		kind,
		name,
		bindings,
		env: { ...options.env },
		endpoints: {},
		annotations: {},
		typescript: {
			ctxBindings: renderCtxBindings(bind),
		},
		binding(alias) {
			const found = bindings[alias];
			if (!found) {
				throw new BindReferenceError(
					`resources.${name}.bindings.${alias}`,
					`ctx.bindings.${alias} is not declared on service ${name}`,
				);
			}
			return found;
		},
		manifest() {
			// ADR-0141: links + typed bindings only — never ConnectionStrings__* ambient grants.
			const env = { ...this.env };
			const links: Array<{ import: string; to: string }> = [];

			for (const [alias, target] of Object.entries(bind)) {
				void alias;
				links.push({ import: target.port, to: target.name });
			}

			const resource: ManifestResource = {
				type: "component.v1",
				runtime: "wasm",
				exports: ["wasi:http/incoming-handler"],
				links,
				env,
				bindings,
			};

			if (options.image) {
				Object.assign(resource, { image: options.image });
			}
			if (options.build) {
				Object.assign(resource, { build: options.build });
			}
			if (Object.keys(this.endpoints).length > 0) {
				Object.assign(resource, { endpoints: { ...this.endpoints } });
			}
			if (Object.keys(this.annotations).length > 0) {
				Object.assign(resource, { annotations: { ...this.annotations } });
			}

			return resource;
		},
	};

	return handle;
}

export function normalizeBindMap(
	bind: Readonly<Record<string, ResourceHandle>> = {},
): Readonly<Record<string, ResourceHandle>> {
	if (!isHandleMap(bind)) {
		throw new BindReferenceError("bind", "must be a resource map");
	}

	for (const [alias, target] of Object.entries(bind)) {
		assertResourceName(alias, `bind.${alias}`);
		if (target?.kind !== "resource") {
			throw new BindReferenceError(
				`bind.${alias}`,
				"must reference a declared resource handle",
			);
		}
	}

	return bind;
}

export function validateLinks(
	handle: ComponentHandle,
	resources: Readonly<Record<string, ManifestResource>>,
): void {
	const links = resources[handle.name]?.links ?? [];

	links.forEach((link, index) => {
		const target = resources[link.to];
		if (!target) {
			throw new BindReferenceError(
				`resources.${handle.name}.links[${index}].to`,
				`unknown resource ${link.to}`,
			);
		}
		if (target.port !== link.import) {
			throw new BindReferenceError(
				`resources.${handle.name}.links[${index}].import`,
				`no matching declared resource for ${link.import}`,
			);
		}
	});
}

export function validateLazyReferences(
	resourceId: string,
	resource: ManifestResource,
	resources: Readonly<Record<string, ManifestResource>>,
): void {
	visitResourceStrings(resource, `resources.${resourceId}`, (value, path) => {
		const match = LAZY_TOKEN_PATTERN.exec(value);
		if (!match) {
			return;
		}

		const referencedResource = match[1];
		if (!referencedResource || !resources[referencedResource]) {
			throw new BindReferenceError(
				path,
				`unknown resource ${referencedResource}`,
			);
		}
	});
}

function renderCtxBindings(
	bind: Readonly<Record<string, ResourceHandle>>,
): string {
	return Object.entries(bind)
		.map(([alias, target]) => `readonly ${alias}: ${target.clientType};`)
		.join("\n");
}

function visitResourceStrings<T>(
	value: T,
	path: string,
	visitor: (value: string, path: string) => void,
): void {
	if (isJsonString(value)) {
		visitor(value, path);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			visitResourceStrings(item, `${path}[${index}]`, visitor);
		});
		return;
	}
	if (isHandleMap(value)) {
		for (const [key, child] of Object.entries(value)) {
			visitResourceStrings(child, `${path}.${key}`, visitor);
		}
	}
}

export function assertHandle<T>(handle: T): asserts handle is T & Handle {
	if (
		!isJsonObject(handle) ||
		!isJsonString(handle.kind) ||
		!["resource", "service", "container"].includes(handle.kind) ||
		!isJsonString(handle.name) ||
		!(handle.manifest instanceof Function)
	) {
		throw new BindReferenceError(
			"handles",
			"must contain HoBo resource handles",
		);
	}
}

export function assertResourceName(name: string, path: string): void {
	if (!isJsonString(name) || !RESOURCE_ID_PATTERN.test(name)) {
		throw new BindReferenceError(path, "invalid resource id");
	}
	parseResourceId(name);
}

function isHandleMap<T>(value: T): value is T & JsonObject {
	return isJsonObject(value) && !Array.isArray(value);
}
