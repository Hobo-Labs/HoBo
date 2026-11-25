import {
	createComponentDecorator,
	componentMetadataOf as groundingComponentMetadataOf,
	param as groundingParam,
} from "ts-autocode-grounding";
import { finalizeTrainableClass, granularOptionsFor } from "./granular.js";
import { getTrainable, resolveTrainable, stub, training } from "./training.js";
import type { Trainable, TrainingOptions } from "./types.js";

// The DI-style declaration form (ADR-0125): a TC39 stage-3 class-method
// decorator that lowers to the exact training() wrapper — byte-identical
// manifest facts. Like a DI container, decorating registers the trainable
// eagerly at instance construction (addInitializer), and the instance is
// resolvable from the registry by methodRef or injection token
// (resolveTrainable) — so a test/eval suite binds to the same instance via
// the token and its example table doubles as the live-training eval suite.
// The method body is the initial implementation the optimizer improves.
// Never compiled with experimentalDecorators.

// Symbol.metadata shims until the host runtime ships it (TS 5.2+ emits
// decorator metadata only when the symbol exists).
// SAFETY: assertion to `ol as { metadata?: symbol }).me` is required at this boundary.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

export const TRAINABLE_METADATA = Symbol.for("hobo.trainable.metadata");

type TrainableMethod<This, I, O> = (this: This, input: I) => O | Promise<O>;
type TrainableField<I, O> = ((input: I) => O | Promise<O>) | Trainable<I, O>;

export interface TrainableDecorator<This, I, O> {
	/** Method form: the body is the baseline the optimizer improves. */
	(
		method: TrainableMethod<This, I, O>,
		context: ClassMethodDecoratorContext<This, TrainableMethod<This, I, O>>,
	): (this: This, input: I) => Promise<O>;
	/**
	 * Field form: the initializer is the baseline — `stub()` (or no
	 * initializer at all) declares code to be generated; a function value is
	 * a hand-written baseline. The field's value becomes the registered
	 * trainable.
	 */
	(
		value: undefined,
		context: ClassFieldDecoratorContext<This, TrainableField<I, O>>,
	): (
		this: This,
		initial: ((input: I) => O | Promise<O>) | undefined,
	) => Trainable<I, O>;
}

/**
 * `trainable` is both the options factory (`@trainable(opts)`) and a BARE
 * decorator (`@trainable` with no call) — on a class it registers every
 * granular-declared method (`@intent`/`@returns`/`@description`), or every
 * own method with fully inferred groundings when nothing was annotated;
 * on a method it registers that method the same way. TC39 stage-3 call
 * shapes only (ADR-0125). Note: decorators never run on ambient `declare class`
 * declarations — those are honored by `scanDeclaredTrainables` (the
 * `hobo stub` source-scanning path).
 */
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
		// Bare stage-3 method: (method, methodContext).
		if (context?.kind === "method") {
			const name = String(context.name);
			return createTrainableDecorator(
				granularOptionsFor(name, context.metadata, name),
			)(
				// SAFETY: decorator dispatch erases This/I/O at this boundary.
				first as never,
				// SAFETY: stage-3 method context is the decorator second argument.
				second as never,
			);
		}
		// Bare class: stage-3 (cls, classContext).
		finalizeTrainableClass(
			// SAFETY: assertion to `ew () => object, conte` is required at this boundary.
			first as new () => object,
			context?.kind === "class" ? context.metadata : undefined,
		);
		return undefined;
	}
	// Options factory: @trainable({...}).
	// SAFETY: assertion to `rainingOptions); } func` is required at this boundary.
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
				// SAFETY: assertion to `tadata[TRAINABLE_METADATA] as string[] | undefined) ?? []; ` is required at this boundary.
				(context.metadata[TRAINABLE_METADATA] as string[] | undefined) ?? [];
			context.metadata[TRAINABLE_METADATA] = [...registered, methodRef];
		}

		// Container semantics: first registration wins (singleton provider);
		// later instances resolve the registered one.
		const registerWith = (
			baseline: (input: I) => O | Promise<O>,
		): Trainable<I, O> =>
			getTrainable(methodRef)
				? resolveTrainable<I, O>(methodRef)
				: training<I, O>(baseline, facts);

		if (context.kind === "field") {
			// `@operation(...) rankFeed = stub<I, O>();` — the initializer is
			// the baseline; omitting it entirely also declares generation.
			return function (
				this: This,
				initial: ((input: I) => O | Promise<O>) | undefined,
			): Trainable<I, O> {
				return registerWith(initial ?? stub<I, O>());
			};
		}

		// SAFETY: assertion to `inableMethod<This, I, O>; const re` is required at this boundary.
		const method = value as TrainableMethod<This, I, O>;
		const registerFor = (self: This): Trainable<I, O> =>
			registerWith((input: I) => method.call(self, input));

		let bound: Trainable<I, O> | undefined;
		// DI-style eager registration: the trainable enters the registry when
		// the class is constructed, before any call, so resolveTrainable()/
		// listTrainables() see it immediately.
		context.addInitializer?.(function (this: This) {
			// SAFETY: assertion to `); }); r` is required at this boundary.
			bound ??= registerFor(this as This);
		});
		return function (this: This, input: I): Promise<O> {
			// Fallback for hosts/tests that invoke the decorator without running
			// initializers: registration defers to the first call.
			bound ??= registerFor(this);
			return bound(input);
		};
	}
	// SAFETY: assertion to `TrainableDecorator<This, I, O>; } // ----` is required at this boundary.
	return decorate as TrainableDecorator<This, I, O>;
}

// ---------------------------------------------------------------------------
// Component-level declarative surface (Plan 2 Syntax 0): a class IS a
// declared component; its @operation methods ARE the declared operations.
// Both lower to the exact trainable machinery above — the sugar never has
// its own semantics.
// ---------------------------------------------------------------------------

export const COMPONENT_METADATA = Symbol.for("hobo.component.metadata");

export interface ComponentOptions {
	/** What the component is for — the component-level generation intent. */
	readonly intent: string;
}

export interface ComponentMetadata {
	readonly intent: string;
	readonly name: string;
	/** methodRefs of the component's @operation/@trainable methods. */
	readonly operations: readonly string[];
}

/**
 * `@component({ intent })` — TC39 stage-3 class decorator marking a class
 * as a declared component. Its `@operation` methods accumulate in the same
 * `Symbol.metadata` record (method decorators evaluate before the class
 * decorator), so the finished metadata is the component's full declaration:
 * intent + operation refs. `b.api(Component)` / `b.web(...)` /
 * `b.service(...)` accept the decorated class directly; instantiation
 * registers every operation's trainable (DI semantics, same as @trainable).
 * Built on ts-autocode-grounding's composer over HoBo's metadata symbols
 * (ADR-0128), so @hobo/bindles' structural detection is unchanged.
 */
export const component = createComponentDecorator({
	component: COMPONENT_METADATA,
	operations: TRAINABLE_METADATA,
});

/**
 * `@operation(opts)` — the method decorator for a declared component's
 * operations. Identical lowering to `@trainable` (byte-identical manifest
 * facts); the distinct name is the component-domain vocabulary: an
 * operation declares its SHAPE (contract `input` + `output`, or a contract
 * `ref`) and intent; the rubric is optional. A body is the baseline the
 * optimizer improves; `stub()` (or an empty body via `training.define`)
 * declares code to be generated.
 */
export const operation = trainable;

/**
 * `param(description, example?)` — per-parameter annotation for the
 * `params`/`output` maps of @operation/@trainable options. TC39 stage-3
 * decorators (the only kind this repo compiles — never
 * `experimentalDecorators`, ADR-0125) do not include parameter decorators,
 * so parameter metadata rides the options object; this helper keeps the
 * declaration one expression per parameter.
 */
const paramFactory = groundingParam;
// SAFETY: grounding param helper is the FieldDescription factory at this boundary.
const param = paramFactory as never;

export { param };

/** Read a decorated class's component metadata (undefined when not one). */
export function componentMetadataOf(
	// biome-ignore lint/suspicious/noExplicitAny: introspects arbitrary classes
	cls: any,
): ComponentMetadata | undefined {
	// SAFETY: assertion to `taOf(cls, COMPONENT_METADATA) as | ComponentMetadata | undefined; } ` is required at this boundary.
	return groundingComponentMetadataOf(cls, COMPONENT_METADATA) as
		| ComponentMetadata
		| undefined;
}
