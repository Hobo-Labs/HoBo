import { isAppKitKind } from "./app-kits.js";
import {
	connectorRecordsForBuilder,
	isConnectorDeclaredBy,
	withConnectorDeclarations,
} from "./connector.js";
import {
	containerDependencyAnnotation,
	externalDependencyAnnotation,
	wasmComponentDependencyAnnotation,
} from "./dependencies.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	assertNoBindleProviderSelection,
	parseBindleRequirements,
} from "./requirements.js";
import { defaultAppKitSessionReplayAnnotation } from "./session-replay.js";
import type {
	AllowVerbsFor,
	BindleBuilder,
	BindleDefinition,
	BindleDependency,
	BindleEdge,
	BindleEntrypoint,
	BindleHandlerObject,
	BindleRequirements,
	BindleResource,
	BindleResourceRecord,
	ComponentBinding,
	ConnectorBinding,
	ContainerDependencyOptions,
	ExternalDependencyOptions,
	ProviderAnnotation,
	ResourceKind,
	WasmComponentDependencyOptions,
} from "./types.js";
import { webAppAnnotationFromBinding } from "./webapp.js";

const METADATA_SYMBOL =
	(Symbol as { metadata?: symbol }).metadata ?? Symbol.for("Symbol.metadata");
const COMPONENT_METADATA = Symbol.for("hobo.component.metadata");
const TRAINABLE_METADATA = Symbol.for("hobo.trainable.metadata");

type BindingMetadataBag = ComponentBinding & {
	readonly [key: symbol]:
		| { readonly [key: symbol]: JsonValue | undefined }
		| undefined;
};

export const DEFAULT_BINDLE_NAME = "app";

function isBindingMetadataBag(
	value: ComponentBinding,
): value is BindingMetadataBag {
	return value instanceof Function;
}

function isInstantiableClassBinding(binding: ComponentBinding): boolean {
	if (!(binding instanceof Function) || !isBindingMetadataBag(binding)) {
		return false;
	}
	const metadata = binding[METADATA_SYMBOL];
	if (!metadata) return false;
	return (
		metadata[COMPONENT_METADATA] !== undefined ||
		metadata[TRAINABLE_METADATA] !== undefined
	);
}

type EntrypointFactory = BindleEntrypoint;

function toHandler(
	binding: ComponentBinding | undefined,
): EntrypointFactory | undefined {
	if (binding === undefined) return undefined;
	if (!(binding instanceof Function)) {
		throw new TypeError("bindle component binding must be a function or class");
	}
	if (isInstantiableClassBinding(binding)) {
		const Component = binding as new () => BindleHandlerObject;
		return () => new Component();
	}
	return binding as EntrypointFactory;
}

type InternalDependency =
	| InternalBindleResource<ResourceKind>
	| ConnectorBinding;

interface InternalBindleResource<K extends ResourceKind> {
	readonly kind: K;
	declaredAllow: string[];
	annotations: ProviderAnnotation[];
	dependencies: Set<InternalDependency>;
	handler: EntrypointFactory | undefined;
}

function isConnectorBinding(dep: InternalDependency): dep is ConnectorBinding {
	return "definition" in dep && dep.kind === "connector";
}

function createBindleResource<K extends ResourceKind, Message = unknown>(
	kind: K,
	owned: Map<object, InternalBindleResource<ResourceKind>>,
	handler?: EntrypointFactory,
): BindleResource<K, Message> {
	const internal: InternalBindleResource<K> = {
		kind,
		declaredAllow: [],
		annotations: isAppKitKind(kind)
			? [defaultAppKitSessionReplayAnnotation()]
			: [],
		dependencies: new Set(),
		handler,
	};
	const resource: BindleResource<K, Message> = {
		kind,
		dependsOn(...deps: BindleDependency[]): BindleResource<K, Message> {
			for (const dep of deps) {
				if (!isJsonObject(dep)) {
					throw new TypeError("bindle dependency must be a builder resource");
				}
				if (dep.kind === "connector") {
					internal.dependencies.add(dep);
					continue;
				}
				const dependency = owned.get(dep);
				if (!dependency) {
					throw new TypeError(
						"bindle dependency must belong to the same builder",
					);
				}
				internal.dependencies.add(dependency);
			}
			return resource;
		},
		withReference(...deps: BindleDependency[]): BindleResource<K, Message> {
			return resource.dependsOn(...deps);
		},
		allow(...verbs: AllowVerbsFor<K>[]): BindleResource<K, Message> {
			for (const verb of verbs) {
				if (!internal.declaredAllow.includes(verb as string)) {
					internal.declaredAllow.push(verb as string);
				}
			}
			return resource;
		},
		with(...annotations: ProviderAnnotation[]): BindleResource<K, Message> {
			for (const annotation of annotations) {
				if (
					annotation.option === "session-replay" ||
					annotation.option === "status-page"
				) {
					internal.annotations = internal.annotations.filter(
						(a) => a.option !== annotation.option,
					);
				}
				internal.annotations.push(annotation);
			}
			return resource;
		},
	};

	owned.set(resource, internal);
	return Object.freeze(resource);
}

function createBuilder() {
	const owned = new Map<object, InternalBindleResource<ResourceKind>>();
	const createResource = <K extends ResourceKind, Message = unknown>(
		kind: K,
		handler?: EntrypointFactory,
	) => createBindleResource<K, Message>(kind, owned, handler);
	const createUnbound = <K extends ResourceKind>(
		kind: K,
		args: readonly never[],
	) => {
		assertNoFactoryArguments(kind, args);
		return createResource(kind);
	};
	const base = {
		api: (binding?: ComponentBinding, ...extra: never[]) => {
			assertNoFactoryArguments("api", extra);
			return createResource("api", toHandler(binding));
		},
		web: (binding?: ComponentBinding, ...extra: never[]) => {
			assertNoFactoryArguments("web", extra);
			const resource = createResource("web", toHandler(binding));
			const webapp = webAppAnnotationFromBinding(binding);
			if (webapp) {
				resource.with(webapp);
			}
			return resource;
		},
		kv: (...args: never[]) => createUnbound("kv", args),
		bucket: (...args: never[]) => createUnbound("bucket", args),
		queue: <Message = JsonValue>(...args: never[]) => {
			assertNoFactoryArguments("queue", args);
			return createResource<"queue", Message>("queue");
		},
		topic: <Message = JsonValue>(...args: never[]) => {
			assertNoFactoryArguments("topic", args);
			return createResource<"topic", Message>("topic");
		},
		secret: (...args: never[]) => createUnbound("secret", args),
		data: (...args: never[]) => createUnbound("data", args),
		schedule: (...args: never[]) => createUnbound("schedule", args),
		project: (...args: never[]) => createUnbound("project", args),
		websocket: (binding?: ComponentBinding, ...extra: never[]) => {
			assertNoFactoryArguments("websocket", extra);
			return createResource("websocket", toHandler(binding));
		},
		job: (binding?: ComponentBinding, ...extra: never[]) => {
			assertNoFactoryArguments("job", extra);
			return createResource("job", toHandler(binding));
		},
		service: (binding?: ComponentBinding, ...extra: never[]) => {
			assertNoFactoryArguments("service", extra);
			return createResource("service", toHandler(binding));
		},
		flag: (...args: never[]) => createUnbound("flag", args),
		auth: (...args: never[]) => createUnbound("auth", args),
		crypto: (...args: never[]) => createUnbound("crypto", args),
		notify: (...args: never[]) => createUnbound("notify", args),
		guardrail: (...args: never[]) => createUnbound("guardrail", args),
		ui: (binding?: ComponentBinding, ...extra: never[]) => {
			assertNoFactoryArguments("ui", extra);
			return createResource("ui", toHandler(binding));
		},
		experiment: (...args: never[]) => createUnbound("experiment", args),
		rollout: (...args: never[]) => createUnbound("rollout", args),
		external: (options: ExternalDependencyOptions = {}) =>
			createResource("external").with(
				externalDependencyAnnotation(options),
			) as BindleResource<"external">,
		container: (options: ContainerDependencyOptions) =>
			createResource("container").with(
				containerDependencyAnnotation(options),
			) as BindleResource<"container">,
		wasmComponent: (options: WasmComponentDependencyOptions) =>
			createResource("wasm-component").with(
				wasmComponentDependencyAnnotation(options),
			) as BindleResource<"wasm-component">,
	};
	return { builder: Object.freeze(withConnectorDeclarations(base)), owned };
}

function assertNoFactoryArguments(kind: ResourceKind, args: readonly never[]) {
	if (args.length > 0) {
		throw new TypeError(
			`bindle ${kind} factory does not accept resource names`,
		);
	}
}

function toResourceRecord<K extends ResourceKind>(
	name: string,
	internal: InternalBindleResource<K>,
): BindleResourceRecord<K> {
	const stableId = `${internal.kind}:${name}` as `${K}:${string}`;
	return Object.freeze({
		kind: internal.kind,
		name,
		stableId,
		declaredAllow: Object.freeze([...internal.declaredAllow]),
		annotations: Object.freeze(
			internal.annotations.map((entry) => Object.freeze({ ...entry })),
		),
		dependsOn: Object.freeze(
			[...internal.dependencies].map((dep) =>
				isConnectorBinding(dep) ? `connector:${dep.definition.id}` : dep.kind,
			),
		),
	});
}

export function bindle(
	build: (builder: BindleBuilder) => Record<string, BindleResource>,
): BindleDefinition;
export function bindle(
	name: string,
	build: (builder: BindleBuilder) => Record<string, BindleResource>,
): BindleDefinition;
export function bindle(
	name: string,
	requirements: Partial<BindleRequirements> | JsonObject,
	build: (builder: BindleBuilder) => Record<string, BindleResource>,
): BindleDefinition;
export function bindle(
	nameOrBuild:
		| string
		| ((builder: BindleBuilder) => Record<string, BindleResource>),
	buildOrRequirements?:
		| ((builder: BindleBuilder) => Record<string, BindleResource>)
		| Partial<BindleRequirements>
		| JsonObject,
	maybeBuild?: (builder: BindleBuilder) => Record<string, BindleResource>,
): BindleDefinition {
	const nameless = nameOrBuild instanceof Function;
	let name: string;
	let build: (builder: BindleBuilder) => Record<string, BindleResource>;
	let requirementsInput: JsonValue | Partial<BindleRequirements> = {};

	if (nameless) {
		name = DEFAULT_BINDLE_NAME;
		build = nameOrBuild;
	} else {
		if (!isJsonString(nameOrBuild) || nameOrBuild.length === 0) {
			throw new TypeError("bindle name must be a non-empty string");
		}
		name = nameOrBuild;
		if (buildOrRequirements instanceof Function) {
			build = buildOrRequirements;
		} else {
			requirementsInput = buildOrRequirements ?? {};
			if (!(maybeBuild instanceof Function)) {
				throw new TypeError("bindle requires a builder function");
			}
			build = maybeBuild;
		}
	}

	let requirements = parseBindleRequirements(requirementsInput);
	const { builder, owned } = createBuilder();
	const built = build(builder);
	const connectors = connectorRecordsForBuilder(builder);
	const resourceByName = new Map<
		InternalBindleResource<ResourceKind>,
		string
	>();
	const resources: Record<string, BindleResourceRecord> = {};
	const edges: BindleEdge[] = [];
	const stableIds = new Set<string>();
	const handlers = new Map<string, EntrypointFactory>();

	for (const [resourceName, resource] of Object.entries(built)) {
		if (!isJsonString(resourceName) || resourceName.length === 0) {
			throw new TypeError("bindle resource names must be non-empty strings");
		}
		const internal = owned.get(resource);
		if (!internal) {
			throw new TypeError(
				"bindle build must return resources from the same BindleBuilder",
			);
		}
		if (resourceByName.has(internal)) {
			throw new TypeError(
				"bindle resources must have exactly one returned alias",
			);
		}
		const stableId = `${internal.kind}:${resourceName}`;
		if (stableIds.has(stableId)) {
			throw new TypeError(`duplicate bindle resource stableId "${stableId}"`);
		}
		stableIds.add(stableId);
		resourceByName.set(internal, resourceName);
		resources[resourceName] = toResourceRecord(resourceName, internal);
		if (internal.handler) handlers.set(resourceName, internal.handler);
	}
	if (resourceByName.size !== owned.size) {
		throw new TypeError("bindle build must return every declared resource");
	}

	for (const [resource, resourceName] of resourceByName) {
		for (const dep of resource.dependencies) {
			if (isConnectorBinding(dep)) {
				if (!isConnectorDeclaredBy(builder, dep)) {
					throw new TypeError(
						"bindle connector dependency must belong to the same builder",
					);
				}
				edges.push(
					Object.freeze({
						from: resourceName,
						to: `connector:${dep.definition.id}`,
					}),
				);
				continue;
			}
			const depName = resourceByName.get(dep);
			if (!depName) {
				throw new TypeError(
					"bindle dependency must be returned by the builder",
				);
			}
			edges.push(Object.freeze({ from: resourceName, to: depName }));
		}
	}

	if (isEmptyRequirements(requirements)) {
		requirements = inferRequirementsFromResources(resources);
	}

	const definition: BindleDefinition = {
		name,
		resources: Object.freeze(resources),
		...(Object.keys(connectors).length > 0 ? { connectors } : undefined),
		edges: Object.freeze(edges),
		requirements,
		entrypoint: (resourceName: string): EntrypointFactory | undefined =>
			handlers.get(resourceName),
	};
	Object.defineProperty(definition, "entrypoint", { enumerable: false });
	const frozen = Object.freeze(definition);
	assertNoBindleProviderSelection(frozen);
	return frozen;
}

function isEmptyRequirements(requirements: BindleRequirements): boolean {
	return (
		requirements.require.length === 0 &&
		requirements.prefer.length === 0 &&
		requirements.runtimes.length === 0 &&
		Object.keys(requirements.labels).length === 0
	);
}

export function inferRequirementsFromResources(
	resources: Readonly<Record<string, BindleResourceRecord>>,
): BindleRequirements {
	const require = new Set<string>();
	const runtimes = new Set<string>();
	for (const resource of Object.values(resources)) {
		switch (resource.kind) {
			case "web":
			case "api":
			case "service":
			case "ui":
			case "websocket":
			case "job":
				require.add("http");
				runtimes.add("wasm");
				break;
			case "kv":
				require.add("kv");
				break;
			case "queue":
				require.add("queue");
				break;
			case "bucket":
				require.add("bucket");
				break;
			case "topic":
				require.add("topic");
				break;
			case "data":
				require.add("data");
				break;
			case "project":
				require.add("project");
				break;
			case "secret":
				require.add("secret");
				break;
			case "wasm-component":
				runtimes.add("wasm");
				break;
			case "container":
				require.add("container");
				runtimes.add("oci");
				break;
			default:
				break;
		}
	}
	if (runtimes.has("oci")) {
		runtimes.delete("wasm");
	}
	return parseBindleRequirements({
		require: [...require].sort(),
		runtimes: [...runtimes].sort(),
	});
}
