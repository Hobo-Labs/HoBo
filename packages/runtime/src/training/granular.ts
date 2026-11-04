import {
	composeOptions,
	finalizeTrainableClass as finalizeWithRegistry,
	type GroundingOptions,
	intent as groundingIntent,
	granularOptionsFor as groundingOptionsFor,
} from "ts-autocode-grounding";
import type { JsonObject, JsonValue } from "../json.js";
import { getTrainable, resolveTrainable, training } from "./training.js";
import type { FieldDescription, Trainable, TrainingOptions } from "./types.js";

// Granular grounding decorators (Plan 2 Syntax 0): @intent / @returns on
// methods, `description()` values for `params:` maps (TC39 stage-3 only,
// ADR-0125). The decorator implementations — pending-grounding
// accumulation and option composition — live upstream in
// ts-autocode-grounding (ADR-0128); this module wires them to HoBo's
// training registry. Ambient
// `export declare class` declarations erase at compile time, so no
// decorator runs for them at all — they are honored by source scanning
// instead (scan.ts, the `hobo stub` path).

export {
	description,
	PENDING_GROUNDINGS,
	returns,
} from "ts-autocode-grounding";

export { composeOptions };

interface GroundingMethodContext {
	readonly name: string | symbol;
	metadata?: DecoratorMetadataObject;
}

export function intent(text: string) {
	return <This, Args extends unknown[], Result>(
		method: (this: This, ...args: Args) => Result,
		context: ClassMethodDecoratorContext<
			This,
			(this: This, ...args: Args) => Result
		>,
	): ((this: This, ...args: Args) => Result) => {
		const groundingContext: GroundingMethodContext = { name: context.name };
		if (context.metadata !== undefined) {
			groundingContext.metadata = context.metadata;
		}
		return groundingIntent(text)(method, groundingContext);
	};
}

/**
 * Register every granular-declared method of a class (bare `@trainable`).
 * Methods with pending groundings are registered; when nothing was
 * annotated, every own prototype method is registered with fully inferred
 * groundings — the decorators are all optional. Baselines bind to a
 * lazily constructed instance (DI semantics; falls back to the prototype
 * for non-constructible classes).
 */
export function finalizeTrainableClass(
	cls: new () => object,
	metadata: DecoratorMetadataObject | undefined,
): void {
	finalizeWithRegistry(
		cls,
		metadata,
		{
			has: (methodRef) => getTrainable(methodRef) !== undefined,
			register: (baseline, options) =>
				training(baseline, trainingOptionsOf(options)),
		},
		Symbol.for("hobo.trainable.metadata"),
	);
}

/** Resolve a bare-class-decorated method by `<Class>.<method>` ref. */
export function resolveDeclared<I, O>(classAndMethod: string): Trainable<I, O> {
	return resolveTrainable<I, O>(classAndMethod);
}

/** Compose options for a stage-3 bare `@trainable` method (granular or inferred). */
export function granularOptionsFor(
	methodRef: string,
	metadata: DecoratorMetadataObject | undefined,
	methodName: string,
): TrainingOptions {
	return trainingOptionsOf(
		groundingOptionsFor(methodRef, metadata, methodName),
	);
}

/**
 * What grounding's options hold, read off `GroundingOptions` itself rather
 * than off the interfaces it names today, so a bump that types one of these
 * places as a subtype (a field description or shape with a field added) or as
 * a union is copied, and checked, as that type.
 */
type Params = NonNullable<GroundingOptions["params"]>;
type Output = NonNullable<GroundingOptions["output"]>;
type Input = NonNullable<GroundingOptions["contract"]["input"]>;
/** A field description: a value of `params`, or the output's `returns`. */
type Field = Params[string] | Output["returns"];
/** A declared type: the contract's output, or a value of its input. */
type Declared =
	| NonNullable<GroundingOptions["contract"]["output"]>
	| Input[string];

/** What the registry registers: TrainingOptions with the methodRef it requires. */
type RegisteredOptions = TrainingOptions & { readonly methodRef: string };

/** A TrainingContract as trainingOptionsOf assembles it, one field at a time. */
interface AssembledContract {
	ref: string;
	input?: JsonValue;
	output?: JsonValue;
}

/** RegisteredOptions as trainingOptionsOf assembles them, one field at a time. */
interface AssembledOptions {
	methodRef: string;
	intent: string;
	contract: AssembledContract;
	params?: Readonly<Record<string, FieldDescription>>;
	output?: Readonly<Record<string, FieldDescription>>;
}

/**
 * What destructuring a grounding value leaves once every field it carries has
 * been named: nothing. A field upstream adds, keyed by a name or by a symbol,
 * lands in the rest, which then no longer satisfies this, so it cannot be
 * dropped without a compile error. (`Record<string, never>` would constrain
 * only string keys, and let a symbol-keyed field through.)
 */
type NothingLeft = Readonly<Record<PropertyKey, never>>;

/** `true` when `A` and `B` are one type (each a subtype of the other is not enough). */
type Same<A, B> =
	(<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
		? true
		: false;

/** `true` when `T` is one of the types in `Path`. */
type OnPath<T, Path extends readonly unknown[]> = Path extends readonly [
	infer Head,
	...infer Rest,
]
	? Same<T, Head> extends true
		? true
		: OnPath<T, Rest>
	: false;

/**
 * `true` when no object type in `T`, at any depth, has a symbol key, an array
 * type's own keys aside; `false`, or `boolean` for a union where only some
 * members do, otherwise. Each member of a union is read on its own (`keyof` a
 * union has only the keys every member shares), and an array is read only
 * through its elements, since every array's type has symbol-keyed members of
 * its own, so a symbol key added to an array type itself is not seen. `Path`
 * holds the types being read further up: a type that refers to itself is read
 * once, and meeting it again on the way down adds nothing, since that first
 * reading covers every key it has, so a recursive shape neither loops nor
 * fails.
 */
type SymbolFree<T, Path extends readonly unknown[] = []> = T extends unknown
	? OnPath<T, Path> extends true
		? true
		: T extends readonly (infer Element)[]
			? SymbolFree<Element, [...Path, T]>
			: T extends object
				? [Extract<keyof T, symbol>] extends [never]
					? { [Key in keyof T]-?: SymbolFree<T[Key], [...Path, T]> }[keyof T]
					: false
				: true
	: never;

/**
 * `T`, provided no object type in it has a symbol key (`SymbolFree`: at any
 * depth, an array type's own keys aside), else `never`, so that a value of it
 * passed where this is the parameter type stops compiling. `Object.entries`
 * skips a symbol-keyed entry of a map, and a symbol-keyed field of a shape is
 * carried past the `JsonObject` type unchecked (a symbol key is not compared
 * with a string index signature), so either would be dropped without a word.
 */
type StringKeyed<T> = [SymbolFree<T>] extends [true] ? T : never;

/**
 * `T`, unless `T` is `any`: then `never`, which not even `any` satisfies. `any`
 * converts to every type unchecked, so a field grounding retyped to `any` would
 * otherwise be copied as whatever it holds. `methodRef`, `intent`,
 * `contract.ref` and the output's `returns`, each copied as it is typed, are
 * held to it (an output retyped to `any` makes its `returns` `any` too);
 * `params`, `contract.input`, `contract.output` and the field description
 * `params` holds already fail `StringKeyed` with `any` in them.
 */
type NotAny<T> = 0 extends 1 & T ? never : T;

/**
 * ts-autocode-grounding composes HoBo's TrainingOptions; copy them field by
 * field. Every field of the options, the contract, the output and each field
 * description is named, and assigned where TrainingOptions (and the registry's
 * required `methodRef`) types it, with no assertion; what is not named must be
 * nothing. `params` and `contract.input`, maps by name, are copied entry by
 * entry, so their keys may not be symbols; a declared shape is copied whole as
 * JSON, so it may hold no field that is not JSON and no symbol key, at any
 * depth but on an array type itself (`SymbolFree`). Each of these is read as
 * `GroundingOptions` types it, not as the interface grounding names for it
 * today. So a ts-autocode bump stops this compiling when it renames a field,
 * adds one (keyed by a name or a symbol, to the options, the contract, the
 * output or a field description, directly or by typing the place as a subtype
 * or a union with one), makes `methodRef` or `intent` optional, retypes one,
 * to `any` included (`NotAny`), keys `params` or `contract.input` by symbols
 * too, or gives a declared shape a field that is not JSON or a symbol key
 * (scripts/test/ts-autocode-grounding-drift.test.ts puts one on the shape, on
 * an object one field down, on a member of a union, and on the shape a
 * type-alias shape holds of itself).
 * A cast here would let that drift through, and `training()` would then
 * register the method under its function name, with no intent, or without the
 * added field. What the check reads is the types: a property grounding sets
 * on a value without declaring it in its type is not seen. A shape whose type
 * alias refers to itself is read once, but a shape field typed by an
 * interface (as one where upstream's `ShapeDescriptor` refers to itself would
 * be) and a `readonly` array field fail to compile, since `JsonObject` takes
 * neither (an interface has no index signature, and `JsonValue`'s arrays are
 * mutable), so a bump that brings one fails closed; a field description typed
 * as a union with a member that has no `example` compiles, and that member is
 * copied with none; and an array is read only through its elements, so a
 * symbol key on the array type itself
 * (`tags?: string[] & { [GROUNDED]: string }`) compiles, unseen.
 */
function trainingOptionsOf(options: GroundingOptions): RegisteredOptions {
	const { methodRef, intent, contract, params, output, ...uncopied } = options;
	uncopied satisfies NothingLeft;
	const { ref, input, output: declaredOutput, ...uncopiedContract } = contract;
	uncopiedContract satisfies NothingLeft;
	methodRef satisfies NotAny<typeof methodRef>;
	intent satisfies NotAny<typeof intent>;
	ref satisfies NotAny<typeof ref>;
	const trainingContract: AssembledContract = { ref };
	if (input !== undefined) {
		trainingContract.input = declaredJsonByName(input);
	}
	if (declaredOutput !== undefined) {
		trainingContract.output = declaredJson(declaredOutput);
	}
	const registered: AssembledOptions = {
		methodRef,
		intent,
		contract: trainingContract,
	};
	if (params !== undefined) {
		registered.params = fieldsByName(params);
	}
	if (output !== undefined) {
		const { returns, ...uncopiedOutput } = output;
		uncopiedOutput satisfies NothingLeft;
		returns satisfies NotAny<typeof returns>;
		registered.output = { returns: fieldOf(returns) };
	}
	return registered;
}

/** A declared type as JSON: its own fields, each of which must be JSON. */
function declaredJson(declared: StringKeyed<Declared>): JsonObject {
	return { ...declared };
}

function declaredJsonByName(input: StringKeyed<Input>): JsonObject {
	const json: Record<string, JsonValue> = {};
	for (const [name, declared] of Object.entries(input)) {
		json[name] = declaredJson(declared);
	}
	return json;
}

function fieldsByName(params: StringKeyed<Params>) {
	const described: Record<string, FieldDescription> = {};
	for (const [name, field] of Object.entries(params)) {
		described[name] = fieldOf(field);
	}
	return described;
}

/** `true` when some member of `T` declares `Key`, else `never`. */
type Declares<T, Key extends PropertyKey> = T extends unknown
	? Key extends keyof T
		? true
		: never
	: never;

/**
 * A field's description and example, the example kept as given: the manifest
 * lowers it with `JSON.stringify` when the method registers (training.ts
 * `lowerFields`), as it always has, so a function inside it is dropped there
 * and a BigInt or circular value throws there, at registration, not when the
 * class is decorated. `example` is read as optional on every field: where
 * grounding types a field as a union with a member that has none, that
 * member is copied with no example rather than refused. Some field must still
 * declare it, so a bump that drops `example` altogether stops this compiling.
 */
function fieldOf(
	field: Field & { readonly example?: unknown },
): FieldDescription {
	true satisfies Declares<Field, "example">;
	const { description, example, ...uncopied } = field;
	uncopied satisfies NothingLeft;
	return example === undefined
		? { description }
		: {
				description,
				// SAFETY: grounding types a field's example `unknown`, and the
				// registry has always held it as given and lowered it at
				// registration; converting it here would change both.
				example: example as JsonValue,
			};
}

/**
 * `defineGrounding(options)`: the callee of the registrations `hobo stub`
 * generates from an ambient `@trainable declare class` into
 * `src/_generated/declared/<Class>.ts` (ts-autocode-grounding's
 * `generateDeclaredRegistrations`, wrapped in scan.ts). The emitter
 * writes `import { defineGrounding } from "@hobo/runtime"`, so this is the name
 * HoBo answers to. It is `training.define`: the signature-only form, registered
 * in HoBo's training registry and served by the contract-derived stub baseline
 * (ADR-0125). ts-autocode-grounding exports a `defineGrounding` of its own that
 * only checks and freezes the options and registers nothing, so it is not the
 * one re-exported here (ADR-0128).
 */
export function defineGrounding<I = JsonValue, O = JsonValue>(
	options: TrainingOptions<I, O> & { readonly methodRef: string },
): Trainable<I, O> {
	return training.define(options);
}
