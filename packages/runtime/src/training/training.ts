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
		Object.keys(value as JsonBag)
			.sort()
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
	if (!contract || !(hasRef || hasLayout)) {
		missing.push("contract (a ref, or an inline input + output shape)");
	}
	if (missing.length > 0) {
		throw new TrainingGroundingError(methodRef, missing);
	}
}

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
		(fn as { name?: string } | undefined)?.name;
	if (!isJsonString(ref) || ref.trim().length === 0) {
		throw new TrainingGroundingError("<anonymous>", ["methodRef"]);
	}
	return ref;
}

function refFor(ref: string | symbol | Trainable): string {
	if (isJsonString(ref)) return ref;
	if (Object.prototype.toString.call(ref) === "[object Symbol]") {
		const mapped = tokenToRef.get(ref as never);
		if (!mapped) throw new TrainingResolutionError(String(ref));
		return mapped;
	}
	const trainableRef = ref as Trainable;
	return trainableToRef.get(trainableRef) ?? trainableRef.methodRef;
}

export function training<I, O>(
	fn: (input: I) => O | Promise<O>,
	options: TrainingOptions<I, O>,
): Trainable<I, O> {
	const methodRef = resolveMethodRef(options as TrainingOptions, {
		name: fn.name,
	});
	const baseline =
		STUB_BASELINE in fn && fn[STUB_BASELINE] === true
			? null
			: async (input: JsonValue) => {
					const typed: I = input as never;
					return await fn(typed);
				};
	const registered = register(methodRef, options as never, baseline as never);
	return registered as never;
}

training.define = function define<I, O>(
	options: TrainingOptions<I, O> & { readonly methodRef: string },
): Trainable<I, O> {
	return register(options.methodRef, options as never, null) as never;
};

training.infer = function infer<I, O>(
	fn: ((input: I) => O | Promise<O>) & { readonly trainingIntent?: string },
	overrides: Partial<TrainingOptions<I, O>> = {},
): Trainable<I, O> {
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
		intent:
			overrides.intent ??
			fn.trainingIntent ??
			`Inferred: implement ${methodRef} to reproduce and improve its recorded behavior.`,
		contract: (overrides.contract ?? {
			ref: `inferred://${methodRef}`,
		}) as TrainingContract,
		rubric: overrides.rubric ?? { exactMatch: 1 },
		...(overrides.params ? { params: overrides.params } : undefined),
		...(overrides.output ? { output: overrides.output } : undefined),
		...(overrides.token ? { token: overrides.token } : undefined),
		methodRef,
	};
	return register(methodRef, options, async (input: JsonValue) => {
		const typed: I = input as never;
		return cloneAsJson(await fn(typed));
	}) as never;
};

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
		(value as { [TRAINABLE]?: JsonValue })[TRAINABLE] === true
	);
}

export function listTrainables(): readonly TrainableManifestFact[] {
	return [...registry.values()].map((entry) => entry.fact);
}

export function resolveTrainable<I = JsonValue, O = JsonValue>(
	ref: string | symbol,
): Trainable<I, O> {
	const entry = registry.get(refFor(ref));
	if (!entry) throw new TrainingResolutionError(ref);
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

export function resetTrainables(): void {
	registry.clear();
	tokenToRef.clear();
}

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
