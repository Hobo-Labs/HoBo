import {
  decideResourceDefinition,
  matchingDecisionToEvent,
  rankingSummary,
  type MatchObjective,
  type MatchingDecision,
  type SuccessfulMatchingDecision
} from "@hobo/draft-matching-engine-skeleton-contract";
import { type JsonObject } from "../../src/json.js";


const objective: MatchObjective = "cost";
const decision: MatchingDecision = decideResourceDefinition({
  catalog: {
    snapshot: () => ({
      definitions: [],
      contentHash: "abc123"
    })
  },
  context: { resourceType: "database" },
  objective
});

const ranking: string[] = rankingSummary(decision);

if (decision.ok) {
  const success: SuccessfulMatchingDecision = decision;
  const objectiveScore: 0 = success.ranking[0]?.objectiveScore ?? 0;
  const event: JsonObject = matchingDecisionToEvent(success);
  void [objectiveScore, event];
}

// @ts-expect-error unknown objectives are outside the matching contract.
const badObjective: MatchObjective = "random";

// @ts-expect-error resourceType is required to gather candidate definitions.
decideResourceDefinition({ catalog: { definitions: [], contentHash: "abc123" }, context: {} });

void badObjective;

void ranking;
