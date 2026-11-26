import { type JsonValue, type JsonObject } from "./json.js";
export interface GeneratedRegionRef {
  regionId: string;
  artifactRef: string;
  startOffset: number;
  endOffset: number;
  owner: "training-engine" | string;
}

export type GeneratedRegionOffset<Region extends GeneratedRegionRef = GeneratedRegionRef> = number & {
  readonly __generatedRegionId: Region["regionId"];
};

export interface TrajectoryReward {
  source: string;
  rubricRef: string;
  eventId?: string;
  score: number;
  observedAt?: string;
}

export interface OpenInferenceSpan {
  id: string;
  parentId: string | null;
  name: string;
  startTime: string;
  endTime: string;
  attributes: JsonObject & {
    "openinference.span.kind": "LLM" | "CHAIN" | "TOOL" | "RETRIEVER" | "RERANKER" | "EMBEDDING" | "AGENT" | "GUARDRAIL" | "EVALUATOR" | "PROMPT";
  };
  inputs?: JsonObject;
  outputs?: JsonObject;
}

export interface TrainingTrajectory<Region extends GeneratedRegionRef = GeneratedRegionRef> {
  schema: "hobo.training.trajectory/v1";
  id: string;
  traceparent: string;
  run: {
    id: string;
    tenantId: string;
    bindle: string;
    agent: {
      id: string;
      principalRef: string;
    };
  };
  subject: {
    method: string;
    contractRef: string;
    generatedRegion: Region;
  };
  spans: OpenInferenceSpan[];
  payloads: Record<string, {
    classification: "public" | "pii" | "secret" | "confidential" | "regulated";
    redaction: "none" | "raw" | "tokenized" | "encrypted";
    value?: JsonValue;
    tokenRef?: string;
    encryptedRef?: `run://${string}`;
  }>;
  reward: TrajectoryReward;
}

export interface CandidateEdit<Region extends GeneratedRegionRef = GeneratedRegionRef> {
  startOffset: GeneratedRegionOffset<Region>;
  endOffset: GeneratedRegionOffset<Region>;
  replacement: string;
}

export interface CandidatePatch<Region extends GeneratedRegionRef = GeneratedRegionRef> {
  schema: "hobo.training.candidate-patch/v1";
  id: string;
  engineId: string;
  region: GeneratedRegionRef & Region;
  edits: CandidateEdit<Region>[];
  provenance: {
    trajectoryHashes: `sha256:${string}`[];
    rubricRef: string;
    contractRef: string;
  };
}

export interface OptimizeRequest<Region extends GeneratedRegionRef = GeneratedRegionRef> {
  schema: "hobo.training.optimize-request/v1";
  requestId: string;
  generatedRegion: Region;
  trajectories: TrainingTrajectory<Region>[];
  rubric: {
    id: string;
    objective: string;
  };
  contract: {
    ref: string;
    method: string;
    allowedRegionId: Region["regionId"];
  };
}

export interface TrainingError {
  code: string;
  message: string;
}

export interface TrainingEngineAdapter<Region extends GeneratedRegionRef = GeneratedRegionRef> {
  engineId: string;
  optimize(request: OptimizeRequest<Region>): CandidatePatch<Region>;
}

export declare const TRAINING_ENGINE_PORT: "hobo:training-engine/training-engine@0.1.0";
export declare const TRAINING_EVENT_TYPES: readonly [
  "training.RunStarted",
  "training.TrajectoryCaptured",
  "training.RewardObserved",
  "training.CandidateProposed",
  "training.CandidateEvaluated",
  "training.Promoted",
  "training.Rejected"
];
export declare function createGoldenTrajectory(): TrainingTrajectory;
export declare function makeOptimizeRequest(input?: Partial<OptimizeRequest>): OptimizeRequest;
export declare function createStubTrainingEngine(): TrainingEngineAdapter;
export declare function optimizeTrainingCandidate(engine: TrainingEngineAdapter, request: OptimizeRequest): {
  ok: boolean;
  errors: string[];
  candidate: CandidatePatch | null;
};
