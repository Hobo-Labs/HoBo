import { types } from "node:util";
import { isResource, type ResourceLike } from "alchemy/Resource";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AlchemyIacError } from "./plan.js";
import { observeUnexpectedSynchronousResult } from "./synchronous-result.js";

const supportIsProxy = types.isProxy;
const supportIsArray = Array.isArray;
const supportDescriptor = Object.getOwnPropertyDescriptor;
const supportGetPrototype = Object.getPrototypeOf;
const supportObjectPrototype = Object.prototype;
const supportHasOwn = Object.hasOwn;
const supportOwnKeys = Reflect.ownKeys;
const supportApply = Reflect.apply;
const supportFreeze = Object.freeze;
const supportCreate = Object.create;
const supportDefine = Object.defineProperty;
const supportString = String;
const supportTrim = String.prototype.trim;
const supportRegexExec = RegExp.prototype.exec;
const SupportSet = Set;
const supportSetHas = SupportSet.prototype.has;
const supportSetAdd = SupportSet.prototype.add;
const applyEntrypoint = Reflect.apply;
const hasOwnDescriptor = Object.hasOwn;
const isProxy = types.isProxy;

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

export interface AlchemyPrimitiveMapper<Entrypoint, Requirements, Services> {
	readonly resourceTypes: readonly string[];
	readonly operations: readonly string[];
	readonly annotations: readonly string[];
	readonly bindsEntrypoint: boolean;

	readonly limitations?: readonly string[];
	readonly validateGraph?: (graph: AlchemyPrimitiveGraph<Requirements>) => void;
	readonly validate?: (
		input: AlchemyPrimitiveInput<Entrypoint, Requirements>,
	) => void;
	readonly build: (
		input: AlchemyPrimitiveInput<Entrypoint, Requirements> & {
			readonly dependencies: Readonly<Record<string, ResourceLike>>;
			readonly priorPrimitives?: Readonly<Record<string, ResourceLike>>;
		},
	) => Effect.Effect<AlchemyMappedPrimitive<Entrypoint>, never, Services>;
}

export interface AlchemyPrimitiveGraph<Requirements> {
	readonly bindleName: string;
	readonly requirements: Requirements;
	readonly nodes: Readonly<
		Record<
			string,
			Readonly<{
				readonly declaration: PrimitiveDeclaration;
				readonly dependencies: readonly string[];
			}>
		>
	>;
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
	readonly sharedDependency?: string;
	readonly sharedPrimitive?: string;
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

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: support declarations are caller-owned data and captured intrinsics avoid invoking their accessors. */
function supportRecord(input: unknown): input is object {
	if (typeof input !== "object" || input === null || supportIsProxy(input))
		return false;
	const prototype = supportGetPrototype(input);
	return prototype === null || prototype === supportObjectPrototype;
}

function supportOwn(input: unknown, key: string): unknown {
	if (!supportRecord(input)) return undefined;
	const field = supportDescriptor(input, key);
	return field !== undefined &&
		supportHasOwn(field, "value") &&
		field.enumerable
		? field.value
		: undefined;
}

function appendSupportValue<Value>(items: Value[], value: Value): void {
	const field: PropertyDescriptor = supportCreate(null);
	field.value = value;
	field.enumerable = true;
	field.configurable = true;
	field.writable = true;
	supportDefine(items, supportString(items.length), supportFreeze(field));
}

function supportArray(input: unknown): readonly unknown[] | undefined {
	if (supportIsProxy(input) || !supportIsArray(input)) return undefined;
	const length = input.length;
	if (length > 256 || supportOwnKeys(input).length !== length + 1)
		return undefined;
	const values: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const field = supportDescriptor(input, supportString(index));
		if (
			field === undefined ||
			!supportHasOwn(field, "value") ||
			!field.enumerable
		)
			return undefined;
		appendSupportValue(values, field.value);
	}
	return supportFreeze(values);
}

function supportName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		supportApply(supportTrim, value, []) === value &&
		supportApply(supportRegexExec, /[\p{Cc}]/u, [value]) === null
	);
}

function supportNames(
	input: unknown,
	unique = false,
): readonly string[] | undefined {
	const values = supportArray(input);
	if (values === undefined) return undefined;
	const names: string[] = [];
	const seen = new SupportSet<string>();
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (
			!supportName(value) ||
			(unique && supportApply(supportSetHas, seen, [value]))
		)
			return undefined;
		supportApply(supportSetAdd, seen, [value]);
		appendSupportValue(names, value);
	}
	return supportFreeze(names);
}

interface CapturedSupportMapper {
	readonly resourceTypes: readonly string[];
	readonly operations: readonly string[];
	readonly annotations: readonly string[];
	readonly bindsEntrypoint: boolean;
	readonly limitations: readonly string[];
}

function supportOptionalNames(
	input: unknown,
	key: string,
): readonly string[] | undefined {
	if (!supportRecord(input)) return undefined;
	const field = supportDescriptor(input, key);
	if (field === undefined) return supportFreeze<string[]>([]);
	if (!supportHasOwn(field, "value") || !field.enumerable) return undefined;
	return field.value === undefined
		? supportFreeze<string[]>([])
		: supportNames(field.value);
}

function supportMapper(input: unknown): CapturedSupportMapper | undefined {
	const resourceTypes = supportNames(supportOwn(input, "resourceTypes"));
	const operations = supportNames(supportOwn(input, "operations"));
	const annotations = supportNames(supportOwn(input, "annotations"));
	const bindsEntrypoint = supportOwn(input, "bindsEntrypoint");
	const build = supportOwn(input, "build");
	const limitations = supportOptionalNames(input, "limitations");
	if (
		resourceTypes === undefined ||
		resourceTypes.length === 0 ||
		operations === undefined ||
		annotations === undefined ||
		limitations === undefined ||
		typeof bindsEntrypoint !== "boolean" ||
		typeof build !== "function" ||
		supportIsProxy(build)
	)
		return undefined;
	return supportFreeze({
		resourceTypes,
		operations,
		annotations,
		bindsEntrypoint,
		limitations,
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */

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
	const entries = supportArray(catalog);
	if (entries === undefined || !supportRecord(mappers))
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"primitive catalog must be bounded and unique",
		);
	const report: AlchemyPrimitiveSupport[] = [];
	const kinds = new SupportSet<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const kind = supportOwn(entry, "factory");
		const verbs = supportNames(supportOwn(entry, "allowVerbs"), true);
		if (
			!supportName(kind) ||
			verbs === undefined ||
			supportApply(supportSetHas, kinds, [kind])
		)
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				"primitive catalog must be bounded and unique",
			);
		supportApply(supportSetAdd, kinds, [kind]);
		const mapper = supportMapper(supportOwn(mappers, kind));
		const operations = new SupportSet<string>();
		if (mapper !== undefined)
			for (let position = 0; position < mapper.operations.length; position++) {
				const operation = mapper.operations[position];
				if (operation !== undefined)
					supportApply(supportSetAdd, operations, [operation]);
			}
		const supportedOperations: string[] = [];
		const unsupportedOperations: string[] = [];
		for (let position = 0; position < verbs.length; position++) {
			const verb = verbs[position];
			if (verb === undefined)
				throw new AlchemyIacError(
					"BINDLE_INVALID",
					"primitive verb is unavailable",
				);
			appendSupportValue(
				supportApply(supportSetHas, operations, [verb])
					? supportedOperations
					: unsupportedOperations,
				verb,
			);
		}
		appendSupportValue(
			report,
			supportFreeze({
				kind,
				status:
					mapper === undefined
						? "unsupported"
						: unsupportedOperations.length === 0 &&
								mapper.limitations.length === 0
							? "supported"
							: "partial",
				resourceTypes: mapper?.resourceTypes ?? supportFreeze<string[]>([]),
				supportedOperations: supportFreeze(supportedOperations),
				unsupportedOperations: supportFreeze(unsupportedOperations),
				supportedAnnotations:
					mapper?.annotations ?? supportFreeze<string[]>([]),
				bindsEntrypoint: mapper?.bindsEntrypoint ?? false,
				limitations: mapper?.limitations ?? supportFreeze<string[]>([]),
			}),
		);
	}
	return report;
}

interface OrderedPrimitive<Entrypoint, Requirements, Services> {
	declaration: PrimitiveDeclaration;
	entrypoint: Entrypoint | undefined;
	dependencies: string[];
	mapper: AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: declarations are checked before their fields are read. */
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
	return (
		typeof value === "object" &&
		value !== null &&
		!isProxy(value) &&
		!Array.isArray(value)
	);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

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
		if (typeof value !== "object" || isProxy(value) || ancestors.has(value))
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
					const key = String(index);
					const item = hasOwnDescriptor(properties, key)
						? properties[key]
						: undefined;
					if (
						item === undefined ||
						!hasOwnDescriptor(item, "value") ||
						!item.enumerable
					)
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
					!hasOwnDescriptor(item, "value") ||
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the returned data has the same recursively copied data shape as input.
		return copy(input, 0) as T;
	} catch {
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"bindle data must be bounded immutable data",
		);
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

export function mapBindleToAlchemy<Entrypoint, Requirements, Services>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	mappers: Readonly<
		Record<string, AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>>
	>,
	options: AlchemyBindleOptions<Requirements>,
): Effect.Effect<AlchemyBindleMapping, never, Services> {
	/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: Bindle objects and callbacks cross an external boundary and must be validated before reflection or invocation. */
	if (
		isProxy(bindle) ||
		typeof bindle !== "object" ||
		bindle === null ||
		Array.isArray(bindle)
	)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"a bindle data record is required",
		);
	const data = <Key extends keyof BindleForAlchemy<Entrypoint, Requirements>>(
		key: Key,
	): BindleForAlchemy<Entrypoint, Requirements>[Key] => {
		const property = Object.getOwnPropertyDescriptor(bindle, key);
		if (property === undefined || !hasOwnDescriptor(property, "value"))
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				"bindle fields must be own data",
			);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this is the unchanged own-data value of the typed Bindle input.
		return property.value as BindleForAlchemy<Entrypoint, Requirements>[Key];
	};
	const bindleName = data("name");
	if (typeof bindleName !== "string" || !validName(bindleName))
		throw new AlchemyIacError("BINDLE_INVALID", "bindle name is invalid");
	const entrypointOf = data("entrypoint");
	if (typeof entrypointOf !== "function" || isProxy(entrypointOf))
		throw new AlchemyIacError("BINDLE_INVALID", "bindle entrypoint is invalid");
	/* oxlint-enable anti-slop/no-runtime-typeof */
	const requirements = snapshotData(data("requirements"));
	const resourceDeclarations = snapshotData(data("resources"));
	const edges = snapshotData(data("edges"));
	const connectorProperty = Object.getOwnPropertyDescriptor(
		bindle,
		"connectors",
	);
	if (
		connectorProperty !== undefined &&
		!hasOwnDescriptor(connectorProperty, "value")
	)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"bindle connectors must be own data",
		);
	const connectorData = connectorProperty?.value;
	const connectors =
		connectorData === undefined ? undefined : snapshotData(connectorData);
	if (
		!dataRecord(resourceDeclarations) ||
		!Array.isArray(edges) ||
		(connectors !== undefined && !dataRecord(connectors))
	)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"bindle containers must be bounded data",
		);
	const entries = Object.entries(resourceDeclarations);
	if (entries.length === 0 || entries.length > 256 || edges.length > 1024)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"a bounded resource graph is required",
		);
	for (const [name, declaration] of entries) {
		if (
			!dataRecord(declaration) ||
			!validName(name) ||
			!validName(declaration.kind) ||
			declaration.name !== name ||
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
			)
		)
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				`invalid identity for resource ${name}`,
			);
	}
	for (const edge of edges)
		if (!dataRecord(edge) || !validName(edge.from) || !validName(edge.to))
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				"bindle edges must be valid data",
			);
	let unsupportedReason: string | undefined;
	try {
		const decision = options.assessRequirements(requirements);
		observeUnexpectedSynchronousResult(decision);
		if (isProxy(decision)) throw new Error("invalid requirement decision");
		const status = Object.getOwnPropertyDescriptor(decision, "status");
		if (status === undefined || !hasOwnDescriptor(status, "value"))
			throw new Error("invalid requirement decision");
		if (status.value === "unsupported") {
			const reason = Object.getOwnPropertyDescriptor(decision, "reason");
			/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the provider callback can return malformed data across the adapter boundary. */
			if (
				reason === undefined ||
				!hasOwnDescriptor(reason, "value") ||
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
		if (candidate.validateGraph !== undefined)
			mapper.validateGraph = candidate.validateGraph;
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the own-data resolver has the typed Bindle entrypoint contract.
		const entrypoint = applyEntrypoint(entrypointOf, bindle, [name]) as
			| Entrypoint
			| undefined;
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
	const graphNodes: Record<
		string,
		AlchemyPrimitiveGraph<Requirements>["nodes"][string]
	> = Object.create(null);
	for (const [name, row] of rows)
		graphNodes[name] = Object.freeze({
			declaration: row.declaration,
			dependencies: Object.freeze([...row.dependencies]),
		});
	const graph = Object.freeze({
		bindleName,
		requirements,
		nodes: Object.freeze(graphNodes),
	});
	for (const row of order) {
		const graphValidation: unknown = row.mapper.validateGraph?.(graph);
		if (graphValidation !== undefined) {
			observeUnexpectedSynchronousResult(graphValidation);
			throw new AlchemyIacError(
				"BINDLE_VALIDATION_UNAVAILABLE",
				"graph validation must complete synchronously without a return value",
			);
		}
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
		const validation: unknown = row.mapper.validate?.({
			bindleName,
			declaration: row.declaration,
			requirements,
			entrypoint: row.entrypoint,
			dependencyDeclarations: Object.freeze(dependencyDeclarations),
		});
		if (validation !== undefined) {
			observeUnexpectedSynchronousResult(validation);
			throw new AlchemyIacError(
				"BINDLE_VALIDATION_UNAVAILABLE",
				"primitive validation must complete synchronously without a return value",
			);
		}
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
		let resourceWrites = 0;
		let actionWrites = 0;
		/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-set -- SAFETY: Alchemy registers stack objects through these dictionaries; the proxy refuses entries owned outside this Bindle. */
		const guardRegistry = <T extends object>(
			registry: Record<string, T>,
			owned: Set<string>,
			kind: "resource" | "action",
		) => {
			const markWrite = () => {
				if (kind === "resource") resourceWrites++;
				else actionWrites++;
			};
			const claim = (target: Record<string, T>, key: string) => {
				if (Object.hasOwn(target, key) && !owned.has(key))
					throw new AlchemyIacError(
						"BINDLE_IDENTITY_COLLISION",
						`Alchemy ${kind} ${key} is already owned outside this Bindle`,
					);
				owned.add(key);
			};
			return new Proxy(registry, {
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
					markWrite();
					if (typeof key === "string") {
						claim(target, key);
						if (!Object.hasOwn(target, key)) {
							Object.defineProperty(target, key, {
								value,
								enumerable: true,
								configurable: true,
								writable: true,
							});
							return true;
						}
					}
					return Reflect.set(target, key, value);
				},
				defineProperty(target, key, descriptor) {
					markWrite();
					if (typeof key === "string") claim(target, key);
					return Reflect.defineProperty(target, key, descriptor);
				},
				deleteProperty(target, key) {
					markWrite();
					if (
						typeof key === "string" &&
						Object.hasOwn(target, key) &&
						!owned.has(key)
					)
						throw new AlchemyIacError(
							"BINDLE_IDENTITY_COLLISION",
							`Alchemy ${kind} ${key} is already owned outside this Bindle`,
						);
					return Reflect.deleteProperty(target, key);
				},
			});
		};
		/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-set */
		const guardedStack = {
			...stack,
			resources: guardRegistry(stack.resources, ownedResources, "resource"),
			actions: guardRegistry(stack.actions, ownedActions, "action"),
		};
		const primary: Record<string, ResourceLike> = Object.create(null);
		const resources: ResourceLike[] = [];
		const fqns = new Set<string>();
		const stillRegistered = (resource: ResourceLike) => {
			const descriptor = Object.getOwnPropertyDescriptor(
				stack.resources,
				resource.FQN,
			);
			return (
				descriptor !== undefined &&
				Object.hasOwn(descriptor, "value") &&
				descriptor.value === resource
			);
		};
		for (const row of order) {
			ownedActions.clear();
			const previousResources = new Set(ownedResources);
			const previousResourceWrites = resourceWrites;
			const previousActionWrites = actionWrites;
			const previousBindings = new Map(
				Object.entries(stack.bindings).map(([key, value]) => [key, [...value]]),
			);
			const bindingsUnchanged = () => {
				const entries = Object.entries(stack.bindings);
				return (
					entries.length === previousBindings.size &&
					entries.every(([key, value]) => {
						const previous = previousBindings.get(key);
						return (
							previous !== undefined &&
							previous.length === value.length &&
							previous.every((item, index) => item === value[index])
						);
					})
				);
			};
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
					priorPrimitives: Object.freeze(
						Object.assign(Object.create(null), primary),
					),
					dependencyDeclarations: Object.freeze(dependencyDeclarations),
				})
				.pipe(Effect.provideService(StackContext, guardedStack));
			const shared = mapped.sharedDependency ?? mapped.sharedPrimitive;
			if (
				resources.length + mapped.resources.length > 256 ||
				(mapped.sharedDependency !== undefined &&
					mapped.sharedPrimitive !== undefined) ||
				(shared === undefined &&
					(mapped.resources.length === 0 ||
						!mapped.resources.includes(mapped.primary))) ||
				(shared !== undefined &&
					(!validName(shared) ||
						(mapped.sharedDependency !== undefined &&
							(!row.dependencies.includes(shared) ||
								dependencies[shared] !== mapped.primary)) ||
						(mapped.sharedPrimitive !== undefined &&
							(row.mapper.validateGraph === undefined ||
								primary[shared] !== mapped.primary)) ||
						mapped.resources.length !== 0 ||
						resourceWrites !== previousResourceWrites ||
						actionWrites !== previousActionWrites ||
						!bindingsUnchanged() ||
						!isResource(mapped.primary) ||
						!row.mapper.resourceTypes.includes(mapped.primary.Type) ||
						!stillRegistered(mapped.primary))) ||
				!resources.every(stillRegistered) ||
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
					!stillRegistered(resource) ||
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
			if (
				[...ownedResources].some(
					(name) =>
						!previousResources.has(name) &&
						!mapped.resources.some((resource) => resource.FQN === name),
				)
			)
				throw new AlchemyIacError(
					"MAPPING_INCOMPLETE",
					`mapping for ${row.declaration.name} registered an unreported Alchemy resource`,
				);
			primary[row.declaration.name] = mapped.primary;
		}
		return { primary, resources };
	});
}
