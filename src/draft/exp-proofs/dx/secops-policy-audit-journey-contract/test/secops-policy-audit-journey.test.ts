import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  replaySecopsPolicyDecision,
  reconstructRunCredentialAudit,
  runSecopsPolicyAuditJourney,
} from "../src/secops-policy-audit-journey.js";

describe("SecOps policy audit journey contract", () => {
  it("denies non-compliant hobo up with replayable policy.Decided and zero resources", async () => {
    const journey = await runSecopsPolicyAuditJourney({
      commandSurface: "cli",
      allowRequest: { scopes: ["object.read", "object.delete"] },
      waiver: null,
      now: "2026-06-28T10:00:00.000Z",
    });

    assert.equal(journey.status, "denied");
    assert.equal(journey.command, "hobo up --camp prod");
    assert.equal(journey.up.status, "blocked");
    assert.equal(journey.up.applied, false);
    assert.equal(journey.up.events.some((event) => event.type === "resource.Provisioned"), false);
    assert.deepEqual(journey.provisionedResourceIds, []);

    const policyDecision = journey.events.find((event) => event.type === "policy.Decided");
    assert.ok(policyDecision, "policy.Decided must be emitted");
    assert.equal(policyDecision.data.effect, "deny");
    assert.equal(policyDecision.data.reason, "mandatory deny-ceiling blocks object.delete in prod");
    assert.equal(policyDecision.data.evidence.inputHash, journey.replay.inputHash);
    assert.equal(replaySecopsPolicyDecision(policyDecision).effect, "deny");
    assert.equal(replaySecopsPolicyDecision(policyDecision).reason, policyDecision.data.reason);

    assert.equal(journey.output.includes("policy.Decided"), true);
    assert.equal(journey.secretLeakFindings.length, 0);
    assert.equal(journey.events.some((event) => event.type === "token.Granted"), false);
  });

  it("allows a separated-duty waiver only within TTL and reconstructs token grant/use/revoke", async () => {
    const journey = await runSecopsPolicyAuditJourney({
      commandSurface: "cli",
      allowRequest: { scopes: ["object.read", "object.delete"] },
      waiver: {
        id: "waiver-pol-7f31",
        author: "user:deployer",
        approver: "user:security-admin",
        approvedAt: "2026-06-28T10:02:00.000Z",
        expiresAt: "2026-06-28T10:12:00.000Z",
        reason: "EU capacity incident; temporary US failover.",
      },
      now: "2026-06-28T10:04:00.000Z",
    });

    assert.equal(journey.status, "deployed");
    assert.equal(journey.up.status, "deployed");
    assert.deepEqual(
      journey.events.filter((event) => event.type.startsWith("policy.Waiver")).map((event) => event.type),
      ["policy.WaiverApproved", "policy.WaiverExpired"],
    );
    assert.equal(journey.events.find((event) => event.type === "policy.WaiverExpired").data.expiresAt, "2026-06-28T10:12:00.000Z");

    const audit = reconstructRunCredentialAudit(journey.events, journey.runId);
    assert.deepEqual(audit.chains, [
      {
        user: "user:deployer",
        agent: "agent:hobo-cli",
        target: "provider:yard-provider",
        audience: "urn:hobo:prod:provider",
        scopes: ["object.delete", "object.read"],
        grants: [`grant-${journey.runId}`],
        uses: [`use-${journey.runId}`],
        secretRefs: [],
        revoked: true,
      },
    ]);
    assert.deepEqual(
      journey.events
        .filter((event) => event.type.startsWith("token."))
        .map((event) => event.type),
      ["token.Granted", "token.Used", "token.Revoked"],
    );
  });

  it("rejects self-approved and expired waivers without provisioning", async () => {
    const selfApproved = await runSecopsPolicyAuditJourney({
      waiver: {
        id: "waiver-self",
        author: "user:deployer",
        approver: "user:deployer",
        approvedAt: "2026-06-28T10:02:00.000Z",
        expiresAt: "2026-06-28T10:12:00.000Z",
      },
      now: "2026-06-28T10:04:00.000Z",
    });

    assert.equal(selfApproved.status, "denied");
    assert.equal(selfApproved.decision.reason, "self-approved waiver rejected by separation-of-duties");
    assert.equal(selfApproved.up.events.some((event) => event.type === "resource.Provisioned"), false);

    const expired = await runSecopsPolicyAuditJourney({
      waiver: {
        id: "waiver-expired",
        author: "user:deployer",
        approver: "user:security-admin",
        approvedAt: "2026-06-28T09:00:00.000Z",
        expiresAt: "2026-06-28T09:30:00.000Z",
      },
      now: "2026-06-28T10:04:00.000Z",
    });

    assert.equal(expired.status, "denied");
    assert.equal(expired.decision.reason, "waiver expired before hobo up");
    assert.ok(expired.events.some((event) => event.type === "policy.WaiverExpired"));
    assert.equal(expired.up.events.some((event) => event.type === "resource.Provisioned"), false);
  });

  it(".allow() narrows but cannot widen past the mandatory ceiling", async () => {
    const narrowed = await runSecopsPolicyAuditJourney({
      allowRequest: { scopes: ["object.read"] },
      now: "2026-06-28T10:04:00.000Z",
    });
    assert.equal(narrowed.allowAnalysis.status, "narrowed");
    assert.equal(narrowed.allowAnalysis.widened, false);

    const widened = await runSecopsPolicyAuditJourney({
      allowRequest: { scopes: ["object.read", "object.delete"] },
      now: "2026-06-28T10:04:00.000Z",
    });
    assert.equal(widened.status, "denied");
    assert.equal(widened.allowAnalysis.status, "widening-rejected");
    assert.equal(widened.allowAnalysis.widened, true);
    assert.equal(widened.decision.effect, "deny");
  });

  it("gates agent-initiated MCP deploy with the same ceiling and credential audit", async () => {
    const mcp = await runSecopsPolicyAuditJourney({
      commandSurface: "mcp",
      allowRequest: { scopes: ["object.read", "object.delete"] },
      waiver: {
        id: "waiver-mcp",
        author: "agent:hobo-cli",
        approver: "user:security-admin",
        approvedAt: "2026-06-28T10:02:00.000Z",
        expiresAt: "2026-06-28T10:12:00.000Z",
      },
      now: "2026-06-28T10:04:00.000Z",
    });

    assert.equal(mcp.status, "deployed");
    assert.equal(mcp.command, "MCP deploy -> hobo up --camp prod");
    assert.equal(mcp.mcp.tool, "deploy");
    assert.equal(mcp.events.find((event) => event.type === "policy.Decided").data.subjectRef, "agent:hobo-cli");
    assert.deepEqual(
      reconstructRunCredentialAudit(mcp.events, mcp.runId).chains[0].scopes,
      ["object.delete", "object.read"],
    );
  });
});
