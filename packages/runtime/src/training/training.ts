import { create } from "@bufbuild/protobuf";
import {
	parseTrainingArtifact,
	parseTrainingArtifactProgram,
	type TrainingArtifact,
} from "@hobo/core";
import { TrainableManifestFactSchema } from "../_generated/trainable_manifest_fact_pb.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonValue,
} from "../json.js";
import {
	type FieldDescription,
	type RecordedTrainableCall,
	TRAINABLE,
	type Trainable,
	type TrainableManifestFact,
	type TrainableRecord,
	TrainingArtifactError,
	type TrainingContract,
	type TrainingExample,
	TrainingGroundingError,
	type TrainingOptions,
	TrainingResolutionError,
} from "./types.js";

const MAX_RECORDED_CALLS = 1_000;

const STUB_BASELINE = Symbol.for("hobo.trainable.stub");

interface MutableRecord {
	fact: TrainableManifestFact;
	options: TrainingOptions;
	calls: RecordedTrainableCall[];
	artifact: TrainingArtifact | null;
	baseline: ((input: JsonValue) => Promise<JsonValue>) | null;
	callable: Trainable;
}

const registry = new Map<string, MutableRecord>();
const tokenToRef = new Map<symbol, string>();
const trainableToRef = new WeakMap<object, string>();

function canonical(value: JsonValue): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: JsonValue | undefined): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || !isJsonObject(value)) return value ?? null;
	return Object.fromEntries(
		// SAFETY: assertion to `value as JsonBag` is required at this boundary.
		Object.keys(value as JsonBag)
			.sort()
			// SAFETY: assertion to `value as JsonBag` is required at this boundary.
			.map((key) => [key, sortKeys((value as JsonBag)[key] ?? null)]),
	);
}

function requireGrounding(
	methodRef: string,
	options: TrainingOptions,
): asserts options is TrainingOptions {
	const missing: string[] = [];
	if (!isJsonString(options.intent) || options.intent.trim().length === 0) {
		missing.push("intent");
	}
	const contract = options.contract;
	const hasRef = isJsonString(contract?.ref) && contract.ref.trim().length > 0;
	const hasLayout =
		contract?.input !== undefined && contract?.output !== undefined;
	// The shape is the non-negotiable grounding: a contract must name what
	// goes in and what comes out, either by reference or declared inline.
	// The rubric is optional — the gate falls back to the default
	// exact-match rubric over examples/traces.
	if (!contract || !(hasRef || hasLayout)) {
		missing.push("contract (a ref, or an inline input + output shape)");
	}
	if (missing.length > 0) {
		throw new TrainingGroundingError(methodRef, missing);
	}
}

/** Contract ref, synthesized from the declared shape when none is given. */
function contractRefFor(methodRef: string, options: TrainingOptions): string {
	const ref = options.contract.ref;
	return isJsonString(ref) && ref.trim().length > 0
		? ref
		: `decl://${methodRef}`;
}

function lowerToFact(
	methodRef: string,
	options: TrainingOptions,
	baseline: "body" | "stub",
): TrainableManifestFact {
	return Object.freeze(
		create(TrainableManifestFactSchema, {
			methodRef,
			intent: options.intent,
			contractRef: contractRefFor(methodRef, options),
			rubric: { ...options.rubric },
			params: lowerFields(options.params),
			output: lowerFields(options.output),
			invariants: [...(options.contract.invariants ?? [])],
			forbiddenOutputs: [...(options.contract.forbiddenOutputs ?? [])],
			baseline,
		}),
	);
}

function lowerFields(
	fields: Readonly<Record<string, FieldDescription>> | undefined,
): Record<string, { description: string; exampleJson: string }> {
	return Object.fromEntries(
		Object.entries(fields ?? {}).map(([name, field]) => [
			name,
			{
				description: field.description,
				exampleJson:
					field.example === undefined ? "" : JSON.stringify(field.example),
			},
		]),
	);
}

function record(
	entry: MutableRecord,
	call: Omit<RecordedTrainableCall, "order">,
): void {
	if (entry.calls.length >= MAX_RECORDED_CALLS) entry.calls.shift();
	entry.calls.push(Object.freeze({ ...call, order: entry.calls.length }));
}

/** Demos from an applied artifact's platform-normalized program. */
function artifactDemos(
	artifact: TrainingArtifact | null,
): readonly TrainingExample[] {
	if (!artifact) return [];
	const program = parseTrainingArtifactProgram(artifact.programJson);
	return program.demos.map((demo) => ({
		input: JSON.parse(demo.inputJson),
		output: JSON.parse(demo.outputJson),
	}));
}

/**
 * The stub baseline (ADR-0076 mock mode): serve applied-artifact demos
 * first, then the recorded contract examples — exact input match, falling
 * back to the first example as the canned typed response. Every call is
 * recorded as specification-by-example for the training loop.
 */
async function serveStub(
	entry: MutableRecord,
	input: JsonValue,
): Promise<JsonValue> {
	const key = canonical(input);
	const demos = artifactDemos(entry.artifact);
	for (const demo of demos) {
		if (canonical(cloneAsJson(demo.input)) === key) {
			const output = cloneAsJson(demo.output);
			record(entry, { input, output, served: "matched-demo" });
			return output;
		}
	}
	const examples = entry.options.contract.examples ?? [];
	for (const example of examples) {
		if (canonical(cloneAsJson(example.input)) === key) {
			const output = cloneAsJson(example.output);
			record(entry, {
				input,
				output,
				served: "matched-example",
			});
			return output;
		}
	}
	const canned = demos[0] ?? examples[0];
	if (!canned) {
		throw new TrainingArtifactError(
			`stub baseline for "${entry.fact.methodRef}" has no contract examples or applied demos to serve`,
		);
	}
	const cannedOutput = cloneAsJson(canned.output);
	record(entry, { input, output: cannedOutput, served: "canned" });
	return cannedOutput;
}

function register(
	methodRef: string,
	options: TrainingOptions,
	baseline: ((input: JsonValue) => Promise<JsonValue>) | null,
): Trainable {
	requireGrounding(methodRef, options);
	if (baseline === null) {
		const examples = options.contract.examples ?? [];
		// A declared output shape is enough to register: the stub serves
		// examples/demos when they exist and reports cleanly at call time
		// when they don't yet. Without a shape, examples are the only thing
		// a stub could serve, so they stay required.
		if (examples.length === 0 && options.contract.output === undefined) {
			throw new TrainingGroundingError(methodRef, [
				"contract.examples (or a declared output shape)",
			]);
		}
	}
	const partial = {
		fact: lowerToFact(methodRef, options, baseline === null ? "stub" : "body"),
		options,
		calls: [],
		artifact: null,
		baseline,
	};
	// SAFETY: registry entry is completed after callable is attached.
	const entry: MutableRecord = partial as never;

	const callable = async (input: JsonValue): Promise<JsonValue> => {
		if (entry.baseline === null) {
			return serveStub(entry, input);
		}
		const output = await entry.baseline(input);
		record(entry, { input, output, served: "body" });
		return output;
	};
	Object.defineProperty(callable, TRAINABLE, { value: true });
	Object.defineProperty(callable, "methodRef", { value: methodRef });
	trainableToRef.set(callable, methodRef);
	// SAFETY: assertion to `able as Trainable; r` is required at this boundary.
	entry.callable = callable as Trainable;
	registry.set(methodRef, entry);
	if (options.token) tokenToRef.set(options.token, methodRef);
	return entry.callable;
}

function resolveMethodRef(
	options: TrainingOptions,
	fn?: { readonly name?: string },
): string {
	const ref =
		options.methodRef ??
		options.token?.description ??
		// SAFETY: assertion to `s { name?: string } | undefined)?.n` is required at this boundary.
		(fn as { name?: string } | undefined)?.name;
	if (!isJsonString(ref) || ref.trim().length === 0) {
		throw new TrainingGroundingError("<anonymous>", ["methodRef"]);
	}
	return ref;
}

function refFor(ref: string | symbol | Trainable): string {
	if (isJsonString(ref)) return ref;
	if (Object.prototype.toString.call(ref) === "[object Symbol]") {
		// SAFETY: symbol keys are registered training tokens.
		const mapped = tokenToRef.get(ref as never);
		if (!mapped) throw new TrainingResolutionError(String(ref));
		return mapped;
	}
	// SAFETY: remaining refs are registered Trainable callables.
	const trainableRef = ref as Trainable;
	return trainableToRef.get(trainableRef) ?? trainableRef.methodRef;
}

/** `training(fn, opts)` — the canonical wrapper form (ADR-0025). */
export function training<I, O>(
	fn: (input: I) => O | Promise<O>,
	options: TrainingOptions<I, O>,
): Trainable<I, O> {
	// SAFETY: assertion to `s as TrainingOptions, fn);` is required at this boundary.
	const methodRef = resolveMethodRef(options as TrainingOptions, {
		name: fn.name,
	});
	const baseline =
		STUB_BASELINE in fn && fn[STUB_BASELINE] === true
			? null
			: async (input: JsonValue) => {
					// SAFETY: trainable wrapper preserves the user input type.
					const typed: I = input as never;
					return await fn(typed);
				};
	// SAFETY: stub-or-body baseline is the registered callable payload.
	const registered = register(methodRef, options as never, baseline as never);
	// SAFETY: registered trainable keeps the caller I/O types.
	return registered as never;
}

/**
 * `training.define(opts)` — the signature-only, empty-implementation form
 * (ADR-0125): no body; served by the contract-derived stub baseline until
 * the training engine synthesizes an implementation (ADR-0010 cold start).
 */
training.define = function define<I, O>(
	options: TrainingOptions<I, O> & { readonly methodRef: string },
): Trainable<I, O> {
	// SAFETY: assertion to `( options.methodRef, // SAFETY: assertion to `as TrainingOptions, null` is required at` is required at this boundary.
	return register(
		options.methodRef,
		// SAFETY: training.define erases I/O at the registry boundary.
		options as never,
		null,
	) as never;
};

/**
 * `training.infer(fn)` — the bare-marker form (ADR-0125): a function whose
 * body carries only the `"use training"` directive, with NO author-supplied
 * bindings. The groundings are inferred (and typically generated by
 * `hobo stub`, which scans source for marked functions): methodRef from the
 * name, intent from a leading comment in the body or a generated sentence,
 * a synthesized `inferred://` contract ref, and a default exact-match
 * rubric. Overrides refine any of them without changing syntax form.
 */
training.infer = function infer<I, O>(
	fn: (input: I) => O | Promise<O>,
	overrides: Partial<TrainingOptions<I, O>> = {},
): Trainable<I, O> {
	// SAFETY: assertion to `as TrainingOptions, fn); co` is required at this boundary.
	const methodRef = resolveMethodRef(overrides as TrainingOptions, {
		name: fn.name,
	});
	const source = fn.toString();
	if (
		!source.includes('"use training"') &&
		!source.includes("'use training'")
	) {
		throw new TrainingGroundingError(methodRef, ['"use training" directive']);
	}
	const options: TrainingOptions = {
		intent: overrides.intent ?? inferIntent(methodRef, source),
		// SAFETY: assertion to `.contract ?? { ref: `inferred://${methodRef}`, }) as TrainingContract, rubric` is required at this boundary.
		contract: (overrides.contract ?? {
			ref: `inferred://${methodRef}`,
		}) as TrainingContract,
		rubric: overrides.rubric ?? { exactMatch: 1 },
		...(overrides.params ? { params: overrides.params } : undefined),
		...(overrides.output ? { output: overrides.output } : undefined),
		...(overrides.token ? { token: overrides.token } : undefined),
		methodRef,
	};
	// SAFETY: assertion to `ethodRef, options, async (input: JsonValue) => // SAFETY: assertion to `), ) as T` is required` is required at this boundary.
	return register(methodRef, options, async (input: JsonValue) => {
		// SAFETY: inferred trainable preserves the user input type.
		const typed: I = input as never;
		return cloneAsJson(await fn(typed));
	}) as never;
};

/** Intent inference: a leading comment after the directive, else generated. */
function inferIntent(methodRef: string, source: string): string {
	const comment = source.match(
		/["']use training["'];?\s*(?:\/\/\s*(.+)|\/\*\*?\s*([\s\S]*?)\*\/)/,
	);
	const text = (comment?.[1] ?? comment?.[2])?.replace(/\s*\*\s*/g, " ").trim();
	if (text) return text;
	return `Inferred: implement ${methodRef} to reproduce and improve its recorded behavior.`;
}

/**
 * Explicit stub baseline marker: `training(stub(), opts)` is the spelled-out
 * form of `training.define(opts)`.
 */
export function stub<I = JsonValue, O = JsonValue>(): (input: I) => Promise<O> {
	const marker = async (): Promise<O> => {
		throw new TrainingArtifactError(
			"stub() baseline is served by the runtime, never called directly",
		);
	};
	Object.defineProperty(marker, STUB_BASELINE, { value: true });
	return marker;
}

export function isTrainable<T>(value: T): value is T & Trainable {
	return (
		value instanceof Function &&
		// SAFETY: assertion to ` [TRAINABLE]?: JsonValue })[TRAINABL` is required at this boundary.
		(value as { [TRAINABLE]?: JsonValue })[TRAINABLE] === true
	);
}

/** Manifest lowering: the facts every authoring form produces. */
export function listTrainables(): readonly TrainableManifestFact[] {
	return [...registry.values()].map((entry) => entry.fact);
}

/**
 * DI-style resolution: return the registered servable instance by methodRef
 * or injection token — the container-`resolve` counterpart to the @trainable
 * decorator's registration. Tests and eval suites resolve by the same token
 * the declaration used, so one example table can drive both.
 */
export function resolveTrainable<I = JsonValue, O = JsonValue>(
	ref: string | symbol,
): Trainable<I, O> {
	const entry = registry.get(refFor(ref));
	if (!entry) throw new TrainingResolutionError(ref);
	// SAFETY: assertion to `le as Trainable<I, O>; } export ` is required at this boundary.
	// SAFETY: registry lookup restores the caller's Trainable I/O types.
	return entry.callable as never;
}

export function getTrainable(
	ref: string | symbol | Trainable,
): TrainableRecord | undefined {
	let methodRef: string;
	try {
		methodRef = refFor(ref);
	} catch {
		return undefined;
	}
	const entry = registry.get(methodRef);
	if (!entry) return undefined;
	return {
		fact: entry.fact,
		options: entry.options,
		calls: [...entry.calls],
		artifact: entry.artifact,
	};
}

/** Test/build-time helper: clears the module registry. */
export function resetTrainables(): void {
	registry.clear();
	tokenToRef.clear();
}

/**
 * Apply a training artifact (ADR-0125 apply-at-load promotion): parses the
 * serialized optimized program, checks it targets this method, and attaches
 * it so the runtime serves it (stub baselines serve its demos immediately).
 * Reversible by applying `null`.
 */
export function applyTrainingArtifact(
	trainable: Trainable | string | symbol,
	artifact: JsonValue | null,
): TrainingArtifact | null {
	const methodRef = refFor(trainable);
	const entry = registry.get(methodRef);
	if (!entry) {
		throw new TrainingArtifactError(
			`no trainable method registered as "${methodRef}"`,
		);
	}
	if (artifact === null) {
		entry.artifact = null;
		return null;
	}
	const parsed = parseTrainingArtifact(artifact);
	if (parsed.methodRef !== methodRef) {
		throw new TrainingArtifactError(
			`artifact targets "${parsed.methodRef}", not "${methodRef}"`,
		);
	}
	entry.artifact = parsed;
	return parsed;
}

export function getAppliedArtifact(
	trainable: Trainable | string | symbol,
): TrainingArtifact | null {
	return registry.get(refFor(trainable))?.artifact ?? null;
}
