import type {
	BindleBuilder,
	BindleConnectorRecord,
	ConnectorBinding,
	ConnectorDefinition,
	ConnectorSymbol,
} from "./types.js";

export type { ConnectorDefinition, ConnectorSymbol } from "./types.js";

const CONNECTOR_REGISTRY = Symbol.for("hobo.connector.registry/v1");

type ConnectorRegistry = Map<symbol, ConnectorDefinition>;
type BuilderConnectorRegistry = Map<string, ConnectorBinding>;

function registry(): ConnectorRegistry {
	const root = globalThis as typeof globalThis & {
		[CONNECTOR_REGISTRY]?: ConnectorRegistry;
	};
	root[CONNECTOR_REGISTRY] ??= new Map();
	return root[CONNECTOR_REGISTRY];
}

export function defineConnector<const D extends ConnectorDefinition>(
	definition: D,
): ConnectorSymbol<D> {
	if (definition.kind !== "connector-definition") {
		throw new TypeError(
			"connector definition must use kind connector-definition",
		);
	}
	if (!definition.id || !definition.origin) {
		throw new TypeError("connector definition requires id and origin");
	}
	const symbol = Symbol.for(
		`hobo.connector/${definition.id}`,
	) as ConnectorSymbol<D>;
	registry().set(
		symbol,
		Object.freeze({ ...definition }) as ConnectorDefinition,
	);
	return symbol;
}

export function connectorDefinition<D extends ConnectorDefinition>(
	symbol: ConnectorSymbol<D>,
): D {
	const definition = registry().get(symbol);
	if (!definition) {
		throw new Error(
			"unknown connector symbol; import the package that defines it before declaring the Bindle",
		);
	}
	return definition as D;
}

function createBinding<D extends ConnectorDefinition>(
	definition: D,
): ConnectorBinding<D> {
	const internal = { declaredAllow: [] as string[] };
	const binding: ConnectorBinding<D> = {
		kind: "connector",
		definition,
		get declaredAllow() {
			return internal.declaredAllow as ConnectorBinding<D>["declaredAllow"];
		},
		allow(...capabilities) {
			for (const capability of capabilities) {
				if (!definition.capabilities.includes(capability)) {
					throw new Error(
						`connector ${definition.id} does not advertise capability ${String(capability)}`,
					);
				}
			}
			internal.declaredAllow = [...new Set(capabilities)];
			return binding;
		},
	};
	return Object.freeze(binding);
}

const builderBindings = new WeakMap<object, BuilderConnectorRegistry>();

export function withConnectorDeclarations<T extends object>(
	base: T,
): T & BindleBuilder {
	const bindings: BuilderConnectorRegistry = new Map();
	const builderBase = {
		...base,
		connector<D extends ConnectorDefinition>(symbol: ConnectorSymbol<D>) {
			const definition = connectorDefinition(symbol);
			const existing = bindings.get(definition.id);
			if (existing) {
				const reuse = existing as ConnectorBinding<D>;
				return reuse;
			}
			const binding = createBinding(definition);
			bindings.set(definition.id, binding);
			return binding;
		},
	};
	const builder = builderBase as T & BindleBuilder;
	builderBindings.set(builder, bindings);
	return builder;
}

export function connectorRecordsForBuilder(
	builder: BindleBuilder,
): Readonly<Record<string, BindleConnectorRecord>> {
	const records: Record<string, BindleConnectorRecord> = {};
	for (const [name, binding] of builderBindings.get(builder) ?? []) {
		const definition = binding.definition;
		records[name] = Object.freeze({
			kind: "connector",
			name,
			target: definition.id,
			origin: definition.origin,
			auth: definition.auth,
			...(definition.audience ? { audience: definition.audience } : undefined),
			allow: Object.freeze([...binding.declaredAllow]),
		});
	}
	return Object.freeze(records);
}
