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
		catalog.length > 256 ||
		catalog.some(
			(entry) => !validName(entry.factory) || entry.allowVerbs.length > 256,
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
		const supportedOperations = entry.allowVerbs.filter((verb) =>
			mapper?.operations.includes(verb),
		);
		const unsupportedOperations = entry.allowVerbs.filter(
			(verb) => !mapper?.operations.includes(verb),
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

function validName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

/** Compile only fully declared mappings, in dependency order, into actual Alchemy resources. */
export function mapBindleToAlchemy<Entrypoint, Requirements, Services>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	mappers: Readonly<
		Record<string, AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>>
	>,
	options: AlchemyBindleOptions<Requirements>,
): Effect.Effect<AlchemyBindleMapping, never, Services> {
	let unsupportedReason: string | undefined;
	try {
		const decision = options.assessRequirements(bindle.requirements);
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
	if (
		bindle.connectors !== undefined &&
		Object.keys(bindle.connectors).length > 0
	)
		throw new AlchemyIacError(
			"BINDLE_CONNECTORS_UNSUPPORTED",
			"connector authorization and runtime bindings are not mapped",
		);
	const entries = Object.entries(bindle.resources);
	if (
		!validName(bindle.name) ||
		entries.length === 0 ||
		entries.length > 256 ||
		bindle.edges.length > 1024
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
		const mapper = Object.hasOwn(mappers, declaration.kind)
			? mappers[declaration.kind]
			: undefined;
		if (
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
			new Set(declaration.declaredAllow).size !==
				declaration.declaredAllow.length
		)
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				`invalid identity for resource ${name}`,
			);
		if (mapper === undefined)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				`no Alchemy mapping for ${declaration.kind}`,
			);
		if (
			mapper.resourceTypes.length === 0 ||
			mapper.resourceTypes.length > 256 ||
			mapper.operations.length > 256 ||
			mapper.annotations.length > 256 ||
			(mapper.limitations !== undefined &&
				(mapper.limitations.length > 256 ||
					mapper.limitations.some((limitation) => !validName(limitation)))) ||
			mapper.resourceTypes.some((type) => !validName(type)) ||
			declaration.declaredAllow.some(
				(verb) => !mapper.operations.includes(verb),
			) ||
			declaration.annotations.some(
				(annotation) =>
					!mapper.annotations.includes(
						`${annotation.provider}:${annotation.option}`,
					),
			)
		)
			throw new AlchemyIacError(
				"PRIMITIVE_UNSUPPORTED",
				`mapping for ${name} does not cover its declared operations or annotations`,
			);
		const entrypoint = bindle.entrypoint(name);
		if (entrypoint !== undefined && !mapper.bindsEntrypoint)
			throw new AlchemyIacError(
				"ENTRYPOINT_UNSUPPORTED",
				`mapping for ${name} cannot bind application logic`,
			);
		rows.set(name, { declaration, entrypoint, dependencies: [], mapper });
	}
	const seen = new Set<string>();
	for (const edge of bindle.edges) {
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
			bindleName: bindle.name,
			declaration: row.declaration,
			requirements: bindle.requirements,
			entrypoint: row.entrypoint,
			dependencyDeclarations,
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
				bindleName: bindle.name,
				declaration: row.declaration,
				requirements: bindle.requirements,
				entrypoint: row.entrypoint,
				dependencies,
				dependencyDeclarations,
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
