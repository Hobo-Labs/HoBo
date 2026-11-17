import { isResource, type ResourceLike } from "alchemy/Resource";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AlchemyIacError } from "./plan.js";

/** A structural authoring port. The adapter does not depend on the host SDK. */
export interface PrimitiveDeclaration {
	readonly kind: string;
	readonly name: string;
	readonly stableId: string;
	readonly declaredAllow: readonly string[];
	readonly dependsOn: readonly string[];
	readonly annotations: readonly {
		readonly provider: string;
		readonly option: string;
		readonly config: object;
	}[];
}

export interface BindleForAlchemy<Entrypoint, Requirements> {
	readonly name: string;
	readonly resources: Readonly<Record<string, PrimitiveDeclaration>>;
	readonly connectors?: Readonly<
		Record<string, { readonly kind: "connector" }>
	>;
	readonly edges: readonly { readonly from: string; readonly to: string }[];
	readonly requirements: Requirements;
	entrypoint(name: string): Entrypoint | undefined;
}

/** Provider authors assert the operations, annotations, and application binding they implement. */
export interface AlchemyPrimitiveMapper<Entrypoint, Requirements, Services> {
	readonly resourceTypes: readonly string[];
	readonly operations: readonly string[];
	readonly annotations: readonly string[];
	readonly bindsEntrypoint: boolean;
	/** Remaining limits in an otherwise usable primitive mapping. */
	readonly limitations?: readonly string[];
	readonly validate?: (
		input: AlchemyPrimitiveInput<Entrypoint, Requirements>,
	) => void;
	readonly build: (
		input: AlchemyPrimitiveInput<Entrypoint, Requirements> & {
			readonly dependencies: Readonly<Record<string, ResourceLike>>;
		},
	) => Effect.Effect<AlchemyMappedPrimitive<Entrypoint>, never, Services>;
}

export interface AlchemyPrimitiveInput<Entrypoint, Requirements> {
	readonly bindleName: string;
	readonly declaration: PrimitiveDeclaration;
	readonly requirements: Requirements;
	readonly entrypoint: Entrypoint | undefined;
	readonly dependencyDeclarations: Readonly<
		Record<string, PrimitiveDeclaration>
	>;
}

export interface AlchemyMappedPrimitive<Entrypoint> {
	readonly primary: ResourceLike;
	readonly resources: readonly ResourceLike[];
	readonly boundDependencies: readonly string[];
	readonly boundEntrypoint?: Entrypoint;
}

export interface AlchemyBindleMapping {
	readonly primary: Readonly<Record<string, ResourceLike>>;
	readonly resources: readonly ResourceLike[];
}

export type AlchemyRequirementsDecision =
	| { readonly status: "supported" }
	| { readonly status: "unsupported"; readonly reason: string };

export interface AlchemyBindleOptions<Requirements> {
	readonly assessRequirements: (
		requirements: Requirements,
	) => AlchemyRequirementsDecision;
}

export interface AlchemyPrimitiveSupport {
	readonly kind: string;
	readonly status: "supported" | "partial" | "unsupported";
	readonly resourceTypes: readonly string[];
	readonly supportedOperations: readonly string[];
	readonly unsupportedOperations: readonly string[];
	readonly supportedAnnotations: readonly string[];
	readonly bindsEntrypoint: boolean;
	readonly limitations: readonly string[];
}

/** Report provider-declared coverage for every entry in a host primitive catalog. */
export function describeAlchemyPrimitiveSupport<
	Entrypoint,
	Requirements,
	Services,
>(
	catalog: readonly {
		readonly factory: string;
		readonly allowVerbs: readonly string[];
	}[],
	mappers: Readonly<
		Record<string, AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>>
	>,
): AlchemyPrimitiveSupport[] {
	if (
		!Array.isArray(catalog) ||
		catalog.length > 256 ||
		catalog.some(
			(entry) =>
				!dataRecord(entry) ||
				!validName(entry.factory) ||
				!Array.isArray(entry.allowVerbs) ||
				entry.allowVerbs.length > 256 ||
				entry.allowVerbs.some((verb) => !validName(verb)) ||
				new Set(entry.allowVerbs).size !== entry.allowVerbs.length,
		) ||
		new Set(catalog.map((entry) => entry.factory)).size !== catalog.length
	)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"primitive catalog must be bounded and unique",
		);
	return catalog.map((entry) => {
		const candidate = Object.hasOwn(mappers, entry.factory)
			? mappers[entry.factory]
			: undefined;
		const mapper =
			candidate !== undefined &&
			candidate.resourceTypes.length > 0 &&
			candidate.resourceTypes.length <= 256 &&
			candidate.resourceTypes.every(validName) &&
			candidate.operations.length <= 256 &&
			candidate.annotations.length <= 256 &&
			(candidate.limitations === undefined ||
				(candidate.limitations.length <= 256 &&
					candidate.limitations.every(validName)))
				? candidate
				: undefined;
		const supportedOperations = entry.allowVerbs.filter((verb: string) =>
			mapper?.operations.includes(verb),
		);
		const unsupportedOperations = entry.allowVerbs.filter(
			(verb: string) => !mapper?.operations.includes(verb),
		);
		return {
			kind: entry.factory,
			status:
				mapper === undefined
					? "unsupported"
					: unsupportedOperations.length === 0 &&
							(mapper.limitations?.length ?? 0) === 0
						? "supported"
						: "partial",
			resourceTypes: mapper === undefined ? [] : [...mapper.resourceTypes],
			supportedOperations,
			unsupportedOperations,
			supportedAnnotations: mapper === undefined ? [] : [...mapper.annotations],
			bindsEntrypoint: mapper?.bindsEntrypoint ?? false,
			limitations: mapper === undefined ? [] : [...(mapper.limitations ?? [])],
		};
	});
}

interface OrderedPrimitive<Entrypoint, Requirements, Services> {
	declaration: PrimitiveDeclaration;
	entrypoint: Entrypoint | undefined;
	dependencies: string[];
	mapper: AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: identities and declarations come from a structural host boundary. */
function validName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function dataRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

/** Snapshot only finite, bounded data; executable callbacks are captured separately. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: bindle declarations are external data and are checked before they are copied. */
function snapshotData<T>(input: T): T {
	const ancestors = new Set<object>();
	let remaining = 16_384;
	let characters = 0;
	function copy(value: unknown, depth: number): unknown {
		if (--remaining < 0 || depth > 32) throw new Error("data exceeds limits");
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw new Error("invalid number");
			return value;
		}
		if (typeof value === "string") {
			characters += value.length;
			if (value.length > 65_536 || characters > 1_048_576)
				throw new Error("data exceeds string limits");
			return value;
		}
		if (typeof value !== "object" || ancestors.has(value))
			throw new Error("data is not an acyclic data value");
		const proto = Object.getPrototypeOf(value);
		if (
			(!Array.isArray(value) && proto !== Object.prototype && proto !== null) ||
			(Array.isArray(value) && proto !== Array.prototype) ||
			Object.getOwnPropertySymbols(value).length !== 0
		)
			throw new Error("data has unsupported properties");
		ancestors.add(value);
		try {
			const properties = Object.getOwnPropertyDescriptors(value);
			if (Array.isArray(value)) {
				if (
					value.length > 1024 ||
					Object.keys(properties).some(
						(key) =>
							key !== "length" &&
							(!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length),
					)
				)
					throw new Error("array is not bounded data");
				const result: unknown[] = [];
				for (let index = 0; index < value.length; index++) {
					const item = properties[String(index)];
					if (item === undefined || !("value" in item) || !item.enumerable)
						throw new Error("array contains a hole or accessor");
					result.push(copy(item.value, depth + 1));
				}
				return Object.freeze(result);
			}
			const keys = Object.keys(properties);
			if (keys.length > 256) throw new Error("object exceeds limits");
			const result: Record<string, unknown> = Object.create(proto);
			for (const key of keys) {
				const item = properties[key];
				if (
					!validName(key) ||
					item === undefined ||
					!("value" in item) ||
					!item.enumerable
				)
					throw new Error("object contains an accessor or invalid key");
				Object.defineProperty(result, key, {
					value: copy(item.value, depth + 1),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return Object.freeze(result);
		} finally {
			ancestors.delete(value);
		}
	}
	try {
		// SAFETY: the returned data has the same recursively copied data shape as input.
		return copy(input, 0) as T;
	} catch {
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"bindle data must be bounded immutable data",
		);
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

/** Compile only fully declared mappings, in dependency order, into actual Alchemy resources. */
export function mapBindleToAlchemy<Entrypoint, Requirements, Services>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	mappers: Readonly<
		Record<string, AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>>
	>,
	options: AlchemyBindleOptions<Requirements>,
): Effect.Effect<AlchemyBindleMapping, never, Services> {
	if (!dataRecord(bindle))
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"a bindle data record is required",
		);
	const bindleName = bindle.name;
	const entrypointOf = bindle.entrypoint;
	const requirements = snapshotData(bindle.requirements);
	const resourceDeclarations = snapshotData(bindle.resources);
	const edges = snapshotData(bindle.edges);
	const connectors =
		bindle.connectors === undefined
			? undefined
			: snapshotData(bindle.connectors);
	if (
		!validName(bindleName) ||
		!dataRecord(resourceDeclarations) ||
		!Array.isArray(edges) ||
		(connectors !== undefined && !dataRecord(connectors)) ||
		!(entrypointOf instanceof Function)
	)
		throw new AlchemyIacError("BINDLE_INVALID", "bindle structure is invalid");
	let unsupportedReason: string | undefined;
	try {
		const decision = options.assessRequirements(requirements);
		const status = Object.getOwnPropertyDescriptor(decision, "status");
		if (status === undefined || !("value" in status))
			throw new Error("invalid requirement decision");
		if (status.value === "unsupported") {
			const reason = Object.getOwnPropertyDescriptor(decision, "reason");
			/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the provider callback can return malformed data across the adapter boundary. */
			if (
				reason === undefined ||
				!("value" in reason) ||
				typeof reason.value !== "string" ||
				!validName(reason.value)
			)
				throw new Error("invalid requirement decision");
			/* oxlint-enable anti-slop/no-runtime-typeof */
			unsupportedReason = reason.value;
		} else if (status.value !== "supported") {
			throw new Error("invalid requirement decision");
		}
	} catch {
		throw new AlchemyIacError(
			"REQUIREMENTS_ASSESSMENT_FAILED",
			"provider could not assess bindle requirements",
		);
	}
	if (unsupportedReason !== undefined)
		throw new AlchemyIacError(
			"BINDLE_REQUIREMENTS_UNSUPPORTED",
			unsupportedReason,
		);
	if (connectors !== undefined && Object.keys(connectors).length > 0)
		throw new AlchemyIacError(
			"BINDLE_CONNECTORS_UNSUPPORTED",
			"connector authorization and runtime bindings are not mapped",
		);
	const entries = Object.entries(resourceDeclarations);
	if (
		!validName(bindleName) ||
		entries.length === 0 ||
		entries.length > 256 ||
		edges.length > 1024
	)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"a bounded named bindle and resource graph are required",
		);
	const rows = new Map<
		string,
		OrderedPrimitive<Entrypoint, Requirements, Services>
	>();
	for (const [name, declaration] of entries) {
		if (
			!dataRecord(declaration) ||
			!validName(name) ||
			!validName(declaration.kind) ||
			name !== declaration.name ||
			declaration.stableId !== `${declaration.kind}:${name}` ||
			!Array.isArray(declaration.declaredAllow) ||
			!Array.isArray(declaration.dependsOn) ||
			!Array.isArray(declaration.annotations) ||
			declaration.declaredAllow.length > 256 ||
			declaration.dependsOn.length > 256 ||
			declaration.annotations.length > 256 ||
			declaration.declaredAllow.some((verb) => !validName(verb)) ||
			declaration.dependsOn.some((dependency) => !validName(dependency)) ||
			declaration.annotations.some(
				(annotation) =>
					!dataRecord(annotation) ||
					!validName(annotation.provider) ||
					!validName(annotation.option) ||
					!dataRecord(annotation.config),
			) ||
			new Set(declaration.declaredAllow).size !==
				declaration.declaredAllow.length
		)
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				`invalid identity for resource ${name}`,
			);
		const candidate = Object.hasOwn(mappers, declaration.kind)
			? mappers[declaration.kind]
			: undefined;
		if (candidate === undefined)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				`no Alchemy mapping for ${declaration.kind}`,
			);
		type MutableMapper = {
			-readonly [Key in keyof AlchemyPrimitiveMapper<
				Entrypoint,
				Requirements,
				Services
			>]: AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>[Key];
		};
		const mapper: MutableMapper = {
			resourceTypes: Object.freeze([...candidate.resourceTypes]),
			operations: Object.freeze([...candidate.operations]),
			annotations: Object.freeze([...candidate.annotations]),
			bindsEntrypoint: candidate.bindsEntrypoint,
			build: candidate.build,
		};
		if (candidate.limitations !== undefined)
			mapper.limitations = Object.freeze([...candidate.limitations]);
		if (candidate.validate !== undefined) mapper.validate = candidate.validate;
		Object.freeze(mapper);
		if (
			mapper.resourceTypes.length === 0 ||
			mapper.resourceTypes.length > 256 ||
			mapper.operations.length > 256 ||
			mapper.annotations.length > 256 ||
			(mapper.limitations !== undefined &&
				(mapper.limitations.length > 256 ||
					mapper.limitations.some((limitation) => !validName(limitation)))) ||
			mapper.resourceTypes.some((type) => !validName(type))
		)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				`mapping for ${name} has invalid or missing capability metadata`,
			);
		const unsupportedOperation = declaration.declaredAllow.find(
			(verb) => !mapper.operations.includes(verb),
		);
		const unsupportedAnnotation = declaration.annotations.find(
			(annotation) =>
				!mapper.annotations.includes(
					`${annotation.provider}:${annotation.option}`,
				),
		);
		if (
			unsupportedOperation !== undefined ||
			unsupportedAnnotation !== undefined
		) {
			const missing =
				unsupportedOperation !== undefined
					? `operation ${unsupportedOperation}`
					: `annotation ${unsupportedAnnotation?.provider}:${unsupportedAnnotation?.option}`;
			const detail = mapper.limitations?.[0];
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				`mapping for ${name} does not support ${missing}${detail === undefined ? "" : `: ${detail}`}`,
			);
		}
		const entrypoint = entrypointOf.call(bindle, name);
		if (entrypoint !== undefined && !mapper.bindsEntrypoint)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				`mapping for ${name} cannot bind application logic`,
			);
		rows.set(name, { declaration, entrypoint, dependencies: [], mapper });
	}
	const seen = new Set<string>();
	for (const edge of edges) {
		if (!dataRecord(edge) || !validName(edge.from) || !validName(edge.to))
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				"dependency edge is invalid",
			);
		const row = rows.get(edge.from);
		const key = JSON.stringify([edge.from, edge.to]);
		if (
			row === undefined ||
			!rows.has(edge.to) ||
			edge.from === edge.to ||
			seen.has(key)
		)
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				"dependency edges must be unique and refer to declared resources",
			);
		seen.add(key);
		row.dependencies.push(edge.to);
	}
	for (const row of rows.values()) {
		const declaredKinds = [...row.declaration.dependsOn].sort();
		const mappedKinds = row.dependencies
			.map((dependency) => rows.get(dependency)?.declaration.kind)
			.sort();
		if (
			declaredKinds.length !== mappedKinds.length ||
			declaredKinds.some((kind, index) => kind !== mappedKinds[index])
		)
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				`resource ${row.declaration.name} has an unrepresented dependency`,
			);
	}
	const pending = new Set(rows.keys());
	const order: OrderedPrimitive<Entrypoint, Requirements, Services>[] = [];
	while (pending.size > 0) {
		const ready = [...pending]
			.sort()
			.filter((name) =>
				rows.get(name)?.dependencies.every((dep) => !pending.has(dep)),
			);
		if (ready.length === 0)
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				"dependency graph contains a cycle",
			);
		for (const name of ready) {
			const row = rows.get(name);
			if (row === undefined)
				throw new AlchemyIacError(
					"BINDLE_INVALID",
					"resource vanished during mapping",
				);
			order.push(row);
			pending.delete(name);
		}
	}
	for (const row of order) {
		const dependencyDeclarations: Record<string, PrimitiveDeclaration> =
			Object.create(null);
		for (const name of row.dependencies) {
			const dependency = rows.get(name);
			if (dependency === undefined)
				throw new AlchemyIacError(
					"BINDLE_GRAPH_UNSUPPORTED",
					"dependency declaration vanished",
				);
			dependencyDeclarations[name] = dependency.declaration;
		}
		row.mapper.validate?.({
			bindleName,
			declaration: row.declaration,
			requirements,
			entrypoint: row.entrypoint,
			dependencyDeclarations: Object.freeze(dependencyDeclarations),
		});
	}
	return Effect.gen(function* () {
		const currentStack = yield* Effect.serviceOption(StackContext);
		if (Option.isNone(currentStack))
			throw new AlchemyIacError(
				"BINDLE_CONTEXT_REQUIRED",
				"bindle mappings require an Alchemy stack context",
			);
		const stack = currentStack.value;
		const ownedResources = new Set<string>();
		const ownedActions = new Set<string>();
		/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-set -- SAFETY: Alchemy registers stack objects through these dictionaries; the proxy refuses entries owned outside this Bindle. */
		const guardRegistry = <T extends object>(
			registry: Record<string, T>,
			owned: Set<string>,
			kind: "resource" | "action",
		) =>
			new Proxy(registry, {
				get(target, key, receiver) {
					if (typeof key === "string") {
						if (Object.hasOwn(target, key) && !owned.has(key))
							throw new AlchemyIacError(
								"BINDLE_IDENTITY_COLLISION",
								`Alchemy ${kind} ${key} is already owned outside this Bindle`,
							);
						if (!Object.hasOwn(target, key) && key in Object.prototype)
							return undefined;
					}
					return Reflect.get(target, key, receiver);
				},
				set(target, key, value) {
					if (typeof key === "string") {
						if (Object.hasOwn(target, key) && !owned.has(key))
							throw new AlchemyIacError(
								"BINDLE_IDENTITY_COLLISION",
								`Alchemy ${kind} ${key} is already owned outside this Bindle`,
							);
						if (!Object.hasOwn(target, key)) {
							Object.defineProperty(target, key, {
								value,
								enumerable: true,
								configurable: true,
								writable: true,
							});
							owned.add(key);
							return true;
						}
						owned.add(key);
					}
					return Reflect.set(target, key, value);
				},
			});
		/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-set */
		const guardedStack = {
			...stack,
			resources: guardRegistry(stack.resources, ownedResources, "resource"),
			actions: guardRegistry(stack.actions, ownedActions, "action"),
		};
		const primary: Record<string, ResourceLike> = Object.create(null);
		const resources: ResourceLike[] = [];
		const fqns = new Set<string>();
		for (const row of order) {
			ownedActions.clear();
			const dependencies: Record<string, ResourceLike> = Object.create(null);
			const dependencyDeclarations: Record<string, PrimitiveDeclaration> =
				Object.create(null);
			for (const name of row.dependencies) {
				const resource = primary[name];
				const dependency = rows.get(name);
				if (resource === undefined || dependency === undefined)
					throw new AlchemyIacError(
						"BINDLE_GRAPH_UNSUPPORTED",
						"dependency has no Alchemy resource",
					);
				dependencies[name] = resource;
				dependencyDeclarations[name] = dependency.declaration;
			}
			const mapped = yield* row.mapper
				.build({
					bindleName,
					declaration: row.declaration,
					requirements,
					entrypoint: row.entrypoint,
					dependencies: Object.freeze(dependencies),
					dependencyDeclarations: Object.freeze(dependencyDeclarations),
				})
				.pipe(Effect.provideService(StackContext, guardedStack));
			if (
				mapped.resources.length === 0 ||
				resources.length + mapped.resources.length > 256 ||
				!mapped.resources.includes(mapped.primary) ||
				mapped.boundEntrypoint !== row.entrypoint ||
				mapped.boundDependencies.length !== row.dependencies.length ||
				new Set(mapped.boundDependencies).size !== row.dependencies.length ||
				row.dependencies.some(
					(name) => !mapped.boundDependencies.includes(name),
				)
			)
				throw new AlchemyIacError(
					"MAPPING_INCOMPLETE",
					`mapping for ${row.declaration.name} did not bind its full declaration`,
				);
			for (const resource of mapped.resources) {
				if (
					!isResource(resource) ||
					!validName(resource.FQN) ||
					!ownedResources.has(resource.FQN) ||
					!row.mapper.resourceTypes.includes(resource.Type) ||
					fqns.has(resource.FQN)
				)
					throw new AlchemyIacError(
						"MAPPING_INCOMPLETE",
						`mapping for ${row.declaration.name} returned an unsupported or duplicate Alchemy resource`,
					);
				fqns.add(resource.FQN);
				resources.push(resource);
			}
			primary[row.declaration.name] = mapped.primary;
		}
		return { primary, resources };
	});
}
