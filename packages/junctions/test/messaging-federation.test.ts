import { describe, expect, it } from "vitest";

import {
	deriveMessagingFederationPlan,
	JUNCTION_MESSAGING_FEDERATED_EVENT,
	junction,
} from "../src/index.js";
import { makeYard } from "./helpers.js";

describe("deriveMessagingFederationPlan", () => {
	it("federates topics pairwise with identity audiences", () => {
		const definition = junction("mesh", {
			yards: [makeYard("a", "aws"), makeYard("b", "azure")],
		});
		const plan = deriveMessagingFederationPlan({
			definition,
			topics: ["orders"],
			actorTypes: ["Cart"],
		});
		expect(plan.eventType).toBe(JUNCTION_MESSAGING_FEDERATED_EVENT);
		expect(plan.topics).toHaveLength(2);
		expect(plan.actorSignals).toHaveLength(2);
		expect(plan.topics[0]?.delivery).toBe("at-least-once");
		expect(plan.topics[0]?.identityAudience).toContain("orders");
	});
});
