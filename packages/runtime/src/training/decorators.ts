import {
	createComponentDecorator,
	componentMetadataOf as groundingComponentMetadataOf,
	param as groundingParam,
} from "ts-autocode-grounding";
import { finalizeTrainableClass, granularOptionsFor } from "./granular.js";
import { getTrainable, resolveTrainable, stub, training } from "./training.js";
import type { Trainable, TrainingOptions } from "./types.js";

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

export const TRAINABLE_METADATA = Symbol.for("hobo.trainable.metadata");

type TrainableMethod<This, I, O> = (this: This, input: I) => O | Promise<O>;
type TrainableField<I, O> = ((input: I) => O | Promise<O>) | Trainable<I, O>;

export interface TrainableDecorator<This, I, O> {
	(
		method: TrainableMethod<This, I, O>,
		context: ClassMethodDecoratorContext<This, TrainableMethod<This, I, O>>,
	): (this: This, input: I) => Promise<O>;
	(
		value: undefined,
		context: ClassFieldDecoratorContext<This, TrainableField<I, O>>,
	): (
		this: This,
		initial: ((input: I) => O | Promise<O>) | undefined,
	) => Trainable<I, O>;
}

export function trainable<This, I, O>(
	options: TrainingOptions<I, O>,
): TrainableDecorator<This, I, O>;
export function trainable(
	cls: new () => object,
	context?: ClassDecoratorContext,
): void;
export function trainable<This, I, O>(
	method: TrainableMethod<This, I, O>,
	context: ClassMethodDecoratorContext<This, TrainableMethod<This, I, O>>,
): (this: This, input: I) => Promise<O>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch across decorator call shapes
export function trainable(first: any, second?: any): any {
	if (first instanceof Function) {
		interface DecoratorContextBag {
			kind?: string;
			name?: PropertyKey;
			metadata?: DecoratorMetadataObject;
		}
		const context: DecoratorContextBag | undefined = second;
		if (context?.kind === "method") {
			const name = String(context.name);
			return createTrainableDecorator(
				granularOptionsFor(name, context.metadata, name),
			)(first as never, second as never);
		}
		finalizeTrainableClass(
			first as new () => object,
			context?.kind === "class" ? context.metadata : undefined,
		);
		return undefined;
	}
	return createTrainableDecorator(first as TrainingOptions);
}

function createTrainableDecorator<This, I, O>(
	options: TrainingOptions<I, O>,
): TrainableDecorator<This, I, O> {
	function decorate(
		value: TrainableMethod<This, I, O> | undefined,
		context:
			| ClassMethodDecoratorContext<This, TrainableMethod<This, I, O>>
			| ClassFieldDecoratorContext<This, TrainableField<I, O>>,
	) {
		const methodRef =
			options.methodRef ?? options.token?.description ?? String(context.name);
		const facts = { ...options, methodRef };
		if (context.metadata) {
			const registered =
				(context.metadata[TRAINABLE_METADATA] as string[] | undefined) ?? [];
			context.metadata[TRAINABLE_METADATA] = [...registered, methodRef];
		}

		const registerWith = (
			baseline: (input: I) => O | Promise<O>,
		): Trainable<I, O> =>
			getTrainable(methodRef)
				? resolveTrainable<I, O>(methodRef)
				: training<I, O>(baseline, facts);

		if (context.kind === "field") {
			return function (
				this: This,
				initial: ((input: I) => O | Promise<O>) | undefined,
			): Trainable<I, O> {
				return registerWith(initial ?? stub<I, O>());
			};
		}

		const method = value as TrainableMethod<This, I, O>;
		const registerFor = (self: This): Trainable<I, O> =>
			registerWith((input: I) => method.call(self, input));

		let bound: Trainable<I, O> | undefined;
		context.addInitializer?.(function (this: This) {
			bound ??= registerFor(this as This);
		});
		return function (this: This, input: I): Promise<O> {
			bound ??= registerFor(this);
			return bound(input);
		};
	}
	return decorate as TrainableDecorator<This, I, O>;
}

export const COMPONENT_METADATA = Symbol.for("hobo.component.metadata");

export interface ComponentOptions {
	readonly intent: string;
}

export interface ComponentMetadata {
	readonly intent: string;
	readonly name: string;
	readonly operations: readonly string[];
}

export const component = createComponentDecorator({
	component: COMPONENT_METADATA,
	operations: TRAINABLE_METADATA,
});

export const operation = trainable;

const paramFactory = groundingParam;
const param = paramFactory as never;

export { param };

export function componentMetadataOf(
	// biome-ignore lint/suspicious/noExplicitAny: introspects arbitrary classes
	cls: any,
): ComponentMetadata | undefined {
	return groundingComponentMetadataOf(cls, COMPONENT_METADATA) as
		| ComponentMetadata
		| undefined;
}
