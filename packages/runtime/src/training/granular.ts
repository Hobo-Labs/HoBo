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

export function resolveDeclared<I, O>(classAndMethod: string): Trainable<I, O> {
	return resolveTrainable<I, O>(classAndMethod);
}

export function granularOptionsFor(
	methodRef: string,
	metadata: DecoratorMetadataObject | undefined,
	methodName: string,
): TrainingOptions {
	return trainingOptionsOf(
		groundingOptionsFor(methodRef, metadata, methodName),
	);
}

type Params = NonNullable<GroundingOptions["params"]>;
type Output = NonNullable<GroundingOptions["output"]>;
type Input = NonNullable<GroundingOptions["contract"]["input"]>;
type Field = Params[string] | Output["returns"];
type Declared =
	| NonNullable<GroundingOptions["contract"]["output"]>
	| Input[string];

type RegisteredOptions = TrainingOptions & { readonly methodRef: string };

interface AssembledContract {
	ref: string;
	input?: JsonValue;
	output?: JsonValue;
}

interface AssembledOptions {
	methodRef: string;
	intent: string;
	contract: AssembledContract;
	params?: Readonly<Record<string, FieldDescription>>;
	output?: Readonly<Record<string, FieldDescription>>;
}

type NothingLeft = Readonly<Record<PropertyKey, never>>;

type Same<A, B> =
	(<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
		? true
		: false;

type OnPath<T, Path extends readonly unknown[]> = Path extends readonly [
	infer Head,
	...infer Rest,
]
	? Same<T, Head> extends true
		? true
		: OnPath<T, Rest>
	: false;

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

type StringKeyed<T> = [SymbolFree<T>] extends [true] ? T : never;

type NotAny<T> = 0 extends 1 & T ? never : T;

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

type Declares<T, Key extends PropertyKey> = T extends unknown
	? Key extends keyof T
		? true
		: never
	: never;

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

export function defineGrounding<I = JsonValue, O = JsonValue>(
	options: TrainingOptions<I, O> & { readonly methodRef: string },
): Trainable<I, O> {
	return training.define(options);
}
