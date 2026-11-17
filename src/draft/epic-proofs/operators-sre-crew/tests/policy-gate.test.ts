import { expect, it } from "vitest";
import { runCrewReferenceSimulation } from "../services/crew-reference-architecture.js";

const deny = {
  id: "sre/lockdown",
  version: "3.1.0",
  rules: [
    {
      id: "deny-remediation",
      when: () => true,
      decide: () => ({ effect: "deny", reason: "maintenance freeze" }),
    },
  ],
};

it.each(["provider-degraded-api", "regional-dr-failover"])(
  "does not run %s writes when policy denies",
  async (scenarioId) => {
    const result = await runCrewReferenceSimulation({
      scenarioIds: [scenarioId],
      policyPack: deny,
    });
    const scenario = result.scenarios[0];
    expect(scenario.status).toBe("escalated");
    const decision = scenario.events.find(
      (event) => event.type === "policy.Decided",
    );
    expect(decision.body).toMatchObject({
      effect: "deny",
      evidence: { packId: "sre/lockdown", packVersion: "3.1.0" },
    });
    expect(
      scenario.events.some((event) =>
        [
          "liveFix.CanaryStarted",
          "liveFix.CanaryCompleted",
          "dr.TrafficShiftReady",
        ].includes(event.type),
      ),
    ).toBe(false);
  },
);

it("does not turn a denied policy into an approved remediation", async () => {
  const result = await runCrewReferenceSimulation({
    scenarioIds: ["prod-contract-skew"],
    humanDecisions: { "prod-contract-skew": "approve" },
    policyPack: deny,
  });
  const scenario = result.scenarios[0];
  expect(scenario.status).toBe("escalated");
  expect(
    scenario.events.some((event) => event.type === "liveFix.CanaryStarted"),
  ).toBe(false);
});

it("denies an action absent from a configured pack", async () => {
  const result = await runCrewReferenceSimulation({
    scenarioIds: ["provider-degraded-api"],
    policyPack: { id: "sre/empty", version: "1.0.0", rules: [] },
  });
  expect(result.scenarios[0].status).toBe("escalated");
  expect(
    result.scenarios[0].events.find((event) => event.type === "policy.Decided")
      .body.effect,
  ).toBe("deny");
});

it("audits a policy error and stops remediation", async () => {
  const broken = {
    id: "sre/broken",
    version: "1.0.0",
    rules: [
      {
        id: "bad-rule",
        when: () => {
          throw new Error("private failure");
        },
        decide: () => ({ effect: "allow", reason: "unused" }),
      },
    ],
  };
  const result = await runCrewReferenceSimulation({
    scenarioIds: ["provider-degraded-api"],
    policyPack: broken,
  });
  const scenario = result.scenarios[0];
  const decision = scenario.events.find(
    (event) => event.type === "policy.Decided",
  );
  expect(scenario.status).toBe("escalated");
  expect(decision.body).toMatchObject({
    effect: "deny",
    evidence: { packId: "sre/broken", packVersion: "1.0.0" },
  });
  expect(JSON.stringify(decision)).not.toContain("private failure");
  expect(
    scenario.events.some((event) => event.type === "liveFix.CanaryStarted"),
  ).toBe(false);
});
