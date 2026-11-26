import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DX_RESULT_REFUSAL_PROOF_ENVELOPES,
  REQUIRED_ENVELOPE_KINDS,
  buildCliJsonExamples,
  buildMcpToolResultExamples,
  buildSdkConsumerExamples,
  classifyOptimisticClaim,
  createDeterministicFixtureSet,
  parseDxResultRefusalProof,
  stableFixtureDigest,
} from "../src/dx-result-refusal-proof-envelopes.ts";

test("catalog defines every required typed result, gate, refusal, and proof-mode envelope", () => {
  const parsed = parseDxResultRefusalProof(DX_RESULT_REFUSAL_PROOF_ENVELOPES);

  assert.equal(parsed.issue, "HOBO-571");
  assert.equal(parsed.phase, "M1");
  assert.deepEqual(
    parsed.envelopes.map((envelope) => envelope.kind),
    REQUIRED_ENVELOPE_KINDS,
  );

  for (const envelope of parsed.envelopes) {
    assert.ok(envelope.humanCopy, envelope.kind);
    assert.match(envelope.code, /^hobo\.dx\.[a-z0-9-]+$/, envelope.kind);
    assert.ok(envelope.remediation, envelope.kind);
    assert.ok(envelope.fixtureId.startsWith("fixture:dx-result:"), envelope.kind);
    assert.ok(envelope.traceId.startsWith("trace-dx-"), envelope.kind);
    assert.ok(envelope.correlationId.startsWith("corr-dx-"), envelope.kind);
    assert.ok(envelope.redactionClass, envelope.kind);
    assert.ok(envelope.accessibilityNotes.length > 0, envelope.kind);
    assert.ok(envelope.copyNotes.length > 0, envelope.kind);
  }
});

test("SDK, CLI JSON, and MCP tool examples expose equivalent machine-readable cases", () => {
  const parsed = parseDxResultRefusalProof(DX_RESULT_REFUSAL_PROOF_ENVELOPES);
  const sdk = buildSdkConsumerExamples(parsed);
  const cli = buildCliJsonExamples(parsed);
  const mcp = buildMcpToolResultExamples(parsed);

  const sdkCases = sdk.map((entry) => [entry.kind, entry.result.code, entry.result.fixtureId]);
  const cliCases = cli.map((entry) => [entry.kind, entry.json.code, entry.json.fixture_id]);
  const mcpCases = mcp.map((entry) => [entry.kind, entry.toolResult.content[0].code, entry.toolResult.content[0].fixtureId]);
  const sdkErrorSemantics = sdk.map((entry) => [entry.kind, entry.result.ok]);
  const cliErrorSemantics = cli.map((entry) => [entry.kind, entry.json.ok]);
  const mcpErrorSemantics = mcp.map((entry) => [entry.kind, !entry.toolResult.isError]);

  assert.deepEqual(sdkCases, cliCases);
  assert.deepEqual(mcpCases, sdkCases);
  assert.deepEqual(cliErrorSemantics, sdkErrorSemantics);
  assert.deepEqual(mcpErrorSemantics, sdkErrorSemantics);
  assert.ok(cli.every((entry) => entry.json.proof_mode));
  assert.ok(mcp.every((entry) => entry.toolResult.isError === (entry.outcome === "refusal")));
  assert.equal(cli.find((entry) => entry.kind === "plan-warning")?.json.ok, true);
  assert.equal(cli.find((entry) => entry.kind === "support-handoff")?.json.ok, true);
});

test("deterministic fixtures separate happy paths from fail-closed paths and hash stably", () => {
  const parsed = parseDxResultRefusalProof(DX_RESULT_REFUSAL_PROOF_ENVELOPES);
  const fixtures = createDeterministicFixtureSet(parsed);

  assert.deepEqual(
    fixtures.happyPaths.map((fixture) => fixture.kind),
    ["success", "plan-warning", "rollback-available", "support-handoff"],
  );
  assert.deepEqual(
    fixtures.failClosedPaths.map((fixture) => fixture.kind),
    [
      "gatekeeper-denial",
      "approval-required",
      "contract-incompatibility",
      "stale-projection",
      "unknown-evidence",
      "non-reactive-sink",
      "migration-blocked",
    ],
  );
  const { stableDigest, ...unsignedFixtures } = fixtures;
  assert.match(stableDigest, /^[a-f0-9]{64}$/);
  assert.equal(stableDigest, stableFixtureDigest(unsignedFixtures));
  assert.equal(stableDigest, createDeterministicFixtureSet(parsed).stableDigest);
});

test("raw records parse once and fail closed when required proof evidence is absent", () => {
  assert.throws(
    () =>
      parseDxResultRefusalProof({
        ...DX_RESULT_REFUSAL_PROOF_ENVELOPES,
        envelopes: DX_RESULT_REFUSAL_PROOF_ENVELOPES.envelopes.map((envelope) =>
          envelope.kind === "unknown-evidence" ? { ...envelope, remediation: "" } : envelope,
        ),
      }),
    /unknown-evidence remediation must be non-empty/,
  );

  assert.throws(
    () =>
      parseDxResultRefusalProof({
        ...DX_RESULT_REFUSAL_PROOF_ENVELOPES,
        envelopes: DX_RESULT_REFUSAL_PROOF_ENVELOPES.envelopes.filter(
          (envelope) => envelope.kind !== "contract-incompatibility",
        ),
      }),
    /missing required envelope kind contract-incompatibility/,
  );
});

test("optimistic success and production claims are rejected without fixture proof", () => {
  assert.deepEqual(classifyOptimisticClaim("hobo up succeeded in production without fixture evidence"), {
    allowed: false,
    reason: "live or production success needs accepted fixture evidence before this proof may claim it",
    route: "dx-result-refusal-proof-envelopes",
  });

  assert.deepEqual(classifyOptimisticClaim("reference fixture proves the simulated plan warning path"), {
    allowed: true,
    reason: "claim is scoped to accepted proof evidence",
    route: "dx-result-refusal-proof-envelopes",
  });
});
