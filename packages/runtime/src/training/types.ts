import type { TrainingArtifact } from "@hobo/core";
import type { TrainableManifestFact } from "../_generated/trainable_manifest_fact_pb.js";
import type { JsonValue } from "../json.js";

export type {
	FieldMetadata,
	TrainableManifestFact,
} from "../_generated/trainable_manifest_fact_pb.js";

export const TRAINABLE = Symbol.for("hobo.trainable");

export interface TrainingExample<I = JsonValue, O = JsonValue> {
	readonly input: I;
	readonly output: O;
}

export interface TrainingContract<I = JsonValue, O = JsonValue> {
	readonly ref?: string;
	readonly input?: JsonValue;
	readonly output?: JsonValue;
	readonly invariants?: readonly string[];
	readonly forbiddenOutputs?: readonly string[];
	readonly examples?: readonly TrainingExample<I, O>[];
}

export interface FieldDescription {
	readonly description: string;
	readonly example?: JsonValue;
}

export interface TrainingOptions<I = JsonValue, O = JsonValue> {
	readonly intent: string;
	readonly contract: TrainingContract<I, O>;
	readonly rubric?: Readonly<Record<string, number>>;
	readonly params?: Readonly<Record<string, FieldDescription>>;
	readonly output?: Readonly<Record<string, FieldDescription>>;
	readonly methodRef?: string;
	readonly token?: symbol;
}

export interface RecordedTrainableCall<I = JsonValue, O = JsonValue> {
	readonly input: I;
	readonly output: O;
	readonly served: "body" | "matched-example" | "matched-demo" | "canned";
	readonly order: number;
}

export interface Trainable<I = JsonValue, O = JsonValue> {
	(input: I): Promise<O>;
	readonly [TRAINABLE]: true;
	readonly methodRef: string;
}

export interface TrainableRecord<I = JsonValue, O = JsonValue> {
	readonly fact: TrainableManifestFact;
	readonly options: TrainingOptions<I, O>;
	readonly calls: readonly RecordedTrainableCall<I, O>[];
	readonly artifact: TrainingArtifact | null;
}

export class TrainingGroundingError extends Error {
	readonly code = "hobo.training.grounding" as const;
	readonly missing: readonly string[];

	constructor(methodRef: string, missing: readonly string[]) {
		super(
			`trainable method "${methodRef}" is missing required grounding: ${missing.join(
				", ",
			)} (ADR-0025: intent + a shaped contract make code rewritable; the rubric is optional — the gate defaults to exact-match over examples/traces)`,
		);
		this.name = "TrainingGroundingError";
		this.missing = missing;
	}
}

export class TrainingArtifactError extends Error {
	readonly code = "hobo.training.artifact" as const;

	constructor(message: string) {
		super(message);
		this.name = "TrainingArtifactError";
	}
}

export class TrainingResolutionError extends Error {
	readonly code = "hobo.training.resolution" as const;

	constructor(ref: string | symbol) {
		super(
			`no trainable registered for ${String(ref)} — register it first (training(), training.define(), training.infer(), or an instantiated @trainable class)`,
		);
		this.name = "TrainingResolutionError";
	}
}
