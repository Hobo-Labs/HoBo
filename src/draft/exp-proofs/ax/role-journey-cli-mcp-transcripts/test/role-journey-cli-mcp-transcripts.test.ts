import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  ROLE_JOURNEY_CLI_MCP_TRANSCRIPTS,
  REQUIRED_ROLE_JOURNEY_COVERAGE,
  REQUIRED_ROLE_JOURNEY_ROLES,
  classifyRoleJourneyScope,
  listAcceptedQuickstartFixtureIds,
  parseRoleJourneyCliMcpTranscripts,
  renderRoleJourneyTranscript,
  renderStepMcpResult,
} from "../src/role-journey-cli-mcp-transcripts.js";
import { isJsonObject, parseJsonObject, type JsonValue } from "../src/json.js";


describe("role journey CLI and MCP transcripts", () => {
  it("covers the six required role journeys with accepted quickstart fixture ids", () => {
    const acceptedFixtureIds = new Set(listAcceptedQuickstartFixtureIds());
    const proof = parseRoleJourneyCliMcpTranscripts(ROLE_JOURNEY_CLI_MCP_TRANSCRIPTS);

    assert.deepEqual(
      proof.journeys.map((journey) => journey.role).sort(),
      [...REQUIRED_ROLE_JOURNEY_ROLES].sort(),
    );

    for (const journey of proof.journeys) {
      assert.ok(
        acceptedFixtureIds.has(journey.primaryQuickstartFixtureId),
        `${journey.role} must start from an accepted HOBO-577 fixture`,
      );
      assert.ok(journey.sequence.length >= 3, `${journey.role} needs a real command sequence`);

      for (const step of journey.sequence) {
        assert.ok(step.command.startsWith("hobo "), `${step.id} must stay CLI-first`);
        assert.ok(acceptedFixtureIds.has(step.quickstartFixtureId), `${step.id} must reuse HOBO-577 fixtures`);
        assert.equal(step.jsonResult.fixtureId, step.quickstartFixtureId);
        assert.equal(step.jsonResult.proofMode, step.proofMode);
        assert.equal(step.mcpResult.fixtureId, step.quickstartFixtureId);
        assert.equal(step.mcpResult.proofMode, step.proofMode);
      }
    }
  });

  it("pins terminal output, JSON, MCP result, support, accessibility, and negative paths", () => {
    const proof = parseRoleJourneyCliMcpTranscripts(ROLE_JOURNEY_CLI_MCP_TRANSCRIPTS);

    for (const journey of proof.journeys) {
      const transcript = renderRoleJourneyTranscript(journey);
      assert.match(transcript, /proof-mode:/);
      assert.match(transcript, /support handoff:/);
      assert.match(transcript, /accessibility:/);
      assert.ok(
        journey.negativePaths.includes("blocked") &&
          journey.negativePaths.includes("stale-or-unknown-evidence"),
        `${journey.role} must carry blocked and stale/unknown evidence paths`,
      );

      for (const step of journey.sequence) {
        assert.equal(step.jsonResult.schema, "hobo.role-journey-cli-mcp-result/v1");
        assert.equal(step.mcpResult.resultSchema, "hobo.role-journey-cli-mcp-result/v1");
        assert.match(step.expectedTerminalOutput, /(blocked|ready|stale|support|rollback|migrate|deploy)/i);
        assert.match(step.accessibilityNote, /(plain text|screen reader|non-color|stable heading)/i);
        assert.match(step.supportHandoff, /support/i);
        assert.equal(renderStepMcpResult(step).tool, step.mcpResult.tool);
      }
    }
  });

  it("pins the Pact body to the complete parsed lower-camel contract", () => {
    const body = readPactBody();
    const proof = parseRoleJourneyCliMcpTranscripts(body);

    assert.equal(proof.journeys.length, REQUIRED_ROLE_JOURNEY_ROLES.length);
    assert.deepEqual(
      proof.journeys.map((journey) => journey.role).sort(),
      [...REQUIRED_ROLE_JOURNEY_ROLES].sort(),
    );

    for (const journey of proof.journeys) {
      assert.ok(journey.sequence.length >= 3, `${journey.role} must keep full transcript sequence in Pact`);
      for (const step of journey.sequence) {
        assert.equal(step.jsonResult.proofMode, step.proofMode);
        assert.equal(step.mcpResult.resultSchema, "hobo.role-journey-cli-mcp-result/v1");
        assert.match(step.supportHandoff, /support/i);
        assert.match(step.accessibilityNote, /(plain text|screen reader|non-color|stable heading)/i);
      }
    }
  });

  it("keeps CUE constraints on the same lower-camel JSON boundary as Pact and TypeScript", () => {
    const cue = readFileSync(
      new URL("../architecture/role_journey_cli_mcp_transcripts.cue", import.meta.url),
      "utf8",
    );

    for (const expected of [
      "targetPackage",
      "sourceQuickstartProof",
      "primaryQuickstartFixtureId",
      "quickstartFixtureId",
      "jsonResult",
      "mcpResult",
      "resultSchema",
    ]) {
      assert.match(cue, new RegExp(`\\b${expected}\\b`), `CUE must constrain ${expected}`);
    }

    for (const rejected of [
      "target_package",
      "source_quickstart_proof",
      "primary_quickstart_fixture_id",
      "quickstart_fixture_id",
      "json_result",
      "mcp_result",
      "result_schema",
    ]) {
      assert.doesNotMatch(cue, new RegExp(`\\b${rejected}\\b`), `CUE must not drift to ${rejected}`);
    }
  });

  it("covers deploy, manage, migrate, rollback, policy or contract denial, and support handoff", () => {
    const proof = parseRoleJourneyCliMcpTranscripts(ROLE_JOURNEY_CLI_MCP_TRANSCRIPTS);
    const aggregateCoverage = new Set(proof.journeys.flatMap((journey) => journey.coverage));

    for (const required of REQUIRED_ROLE_JOURNEY_COVERAGE) {
      assert.ok(aggregateCoverage.has(required), `missing coverage ${required}`);
    }
  });

  it("rejects production CLI, live provider, credentials, customer data, and dashboard-first scope creep", () => {
    assert.deepEqual(classifyRoleJourneyScope("Implement the production CLI parser."), {
      allowed: false,
      reason: "production-cli",
    });
    assert.deepEqual(classifyRoleJourneyScope("Call AWS with real credentials."), {
      allowed: false,
      reason: "live-provider-or-credential",
    });
    assert.deepEqual(classifyRoleJourneyScope("Use customer tenant data in the examples."), {
      allowed: false,
      reason: "customer-data",
    });
    assert.deepEqual(classifyRoleJourneyScope("Replace the transcript with an enterprise dashboard tour."), {
      allowed: false,
      reason: "dashboard-first",
    });
  });
});

function readPactBody(): JsonValue {
  const pact = parseJsonObject(
    readFileSync(
      new URL("../architecture/pacts/role_journey_cli_mcp_transcripts.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const interactions = pact.interactions;
  if (!Array.isArray(interactions) || !isJsonObject(interactions[0])) {
    return null;
  }
  const response = isJsonObject(interactions[0].response) ? interactions[0].response : {};
  return "body" in response ? response.body : null;
}
