import { type JsonObject } from "./json.js";
export type MatchObjective = "cost" | "latency" | "single-provider" | "carbon" | "maximize-credits";

export type DriverId = "terraform" | "template" | "echo" | "container" | "custom-webhook";

export type MatchContext = {
  resourceType: string;
  tenant?: string;
  app?: string;
  env?: string;
  envType?: string;
  resourceClass?: string;
  resourceId?: string;
};

export type ResourceDefinitionMatch = Partial<MatchContext>;

export type ResourceDefinition = {
  apiVersion?: "hobo.resource-definition/v1";
  id: string;
  type: string;
  engine?: string;
  className?: string;
  paradigm?: string;
  provider: string;
  driver: DriverId;
  with?: JsonObject;
  match: ResourceDefinitionMatch;
  priority?: number;
  mapping?: string | JsonObject;
  coProvisioned?: Array<JsonObject>;
};

export type RankedDefinition = {
  definitionId: string;
  specificity: number;
  priority: number;
  objectiveScore: 0;
  rank: number;
};

export type RejectedCandidate = {
  definitionId: string;
  reason: string;
};

export type SuccessfulMatchingDecision = {
  ok: true;
  schema: "hobo.matching-engine/v1";
  context: MatchContext;
  objective: MatchObjective;
  catalogContentHash: `sha256:${string}`;
  winner: ResourceDefinition;
  ranking: RankedDefinition[];
  rejectedCandidates: RejectedCandidate[];
  tie: boolean;
  tiedDefinitionIds: string[];
  planWarnings: string[];
};

export type FailedMatchingDecision = {
  ok: false;
  schema: "hobo.matching-engine/v1";
  context: MatchContext;
  objective: MatchObjective;
  catalogContentHash: `sha256:${string}`;
  reason: string;
  ranking: [];
  rejectedCandidates: RejectedCandidate[];
  tie: false;
  tiedDefinitionIds: [];
  planWarnings: [];
};

export type MatchingDecision = SuccessfulMatchingDecision | FailedMatchingDecision;

export declare function decideResourceDefinition(input: {
  catalog: { snapshot(): { definitions: ResourceDefinition[]; contentHash: string } } | { definitions: ResourceDefinition[]; contentHash: string };
  context: MatchContext;
  objective?: MatchObjective;
}): MatchingDecision;

export declare function matchingDecisionToEvent(
  decision: SuccessfulMatchingDecision,
  overrides?: JsonObject
): JsonObject;

export declare function rankingSummary(decision: MatchingDecision): string[];
