import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  CLI_MANAGE_TRANSCRIPT_PROTOTYPE,
  REQUIRED_FIXTURE_SOURCES,
  REQUIRED_MANAGE_STATES,
  assertCliMcpParity,
  classifyManagePrototypeScope,
  parseManageTranscriptPrototype,
  renderHumanTranscript,
  renderJsonTranscript,
} from "../src/cli-manage-inspect-logs-drift-prototype.ts";

describe("CLI manage inspect/logs/drift prototype", () => {
  it("pins the HOBO-574 package, proof note, and required manage states", () => {
    const proof = parseManageTranscriptPrototype(CLI_MANAGE_TRANSCRIPT_PROTOTYPE);

    assert.equal(proof.issue, "HOBO-574");
    assert.equal(proof.phase, "M2");
    assert.equal(
      proof.targetPackage,
      "src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype",
    );
    assert.equal(
      proof.proofNote,
      "docs/design/proofs/cli-manage-inspect-logs-drift-prototype/README.md",
    );
    assert.deepEqual(
      proof.scenes.map((scene) => scene.state),
      REQUIRED_MANAGE_STATES,
    );
  });

  it("uses the accepted fixture sources for inspect, logs, drift, token/audit, and support evidence", () => {
    const proof = parseManageTranscriptPrototype(CLI_MANAGE_TRANSCRIPT_PROTOTYPE);
    const fixtureSources = new Set(proof.scenes.flatMap((scene) => scene.fixtureSources));

    for (const source of REQUIRED_FIXTURE_SOURCES) {
      assert.ok(fixtureSources.has(source), `expected fixture source ${source}`);
    }

    assert.ok(
      proof.scenes.every((scene) => scene.proofMode === "reference fixture"),
      "all scenes stay reference-fixture until live behavior exists",
    );
  });

  it("renders human terminal transcript and machine JSON for every manage state", () => {
    const proof = parseManageTranscriptPrototype(CLI_MANAGE_TRANSCRIPT_PROTOTYPE);

    for (const scene of proof.scenes) {
      const human = renderHumanTranscript(scene);
      const json = renderJsonTranscript(scene);

      assert.ok(human.includes(scene.cli.command), `${scene.state} includes CLI command`);
      assert.ok(human.includes(scene.human.summary), `${scene.state} includes human summary`);
      assert.equal(json.state, scene.state);
      assert.equal(json.code, scene.machine.code);
      assert.equal(json.fixtureId, scene.fixtureId);
      assert.equal(json.proofMode, "reference fixture");
      assert.ok(json.redaction.redacted, `${scene.state} has redaction evidence`);
    }
  });

  it("keeps CLI transcript and MCP tool result semantically equivalent", () => {
    const proof = parseManageTranscriptPrototype(CLI_MANAGE_TRANSCRIPT_PROTOTYPE);

    for (const scene of proof.scenes) {
      assert.deepEqual(assertCliMcpParity(scene), {
        state: scene.state,
        equivalent: true,
      });
    }

    const divergentScene = {
      ...proof.scenes[0],
      mcp: {
        ...proof.scenes[0].mcp,
        result: {
          ...proof.scenes[0].mcp.result,
          remediation: "Different next action.",
        },
      },
    };

    assert.equal(assertCliMcpParity(divergentScene).equivalent, false);
  });

  it("aligns Pact and CUE architecture fixtures with the parsed prototype", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/cli_manage_inspect_logs_drift_prototype.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactProof = parseManageTranscriptPrototype(pact.interactions[0].response.body);
    assert.deepEqual(
      pactProof.scenes.map((scene) => scene.state),
      REQUIRED_MANAGE_STATES,
    );

    const cue = readFileSync(
      new URL(
        "../architecture/cli_manage_inspect_logs_drift_prototype.cue",
        import.meta.url,
      ),
      "utf8",
    );
    for (const field of [
      "targetPackage",
      "proofNote",
      "fixtureSources",
      "proofMode",
      "correlationId",
      "redaction",
      "mcp",
      "machine",
      "human",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });

  it("rejects production observability, live log streaming, real support tooling, customer data, and dashboard-first creep", () => {
    assert.deepEqual(
      classifyManagePrototypeScope("Implement production observability pipelines for log streaming"),
      { allowed: false, reason: "production-observability" },
    );
    assert.deepEqual(
      classifyManagePrototypeScope("Tail live logs from a real provider account"),
      { allowed: false, reason: "live-log-or-provider" },
    );
    assert.deepEqual(
      classifyManagePrototypeScope("Attach customer data and unredacted logs to the bundle"),
      { allowed: false, reason: "customer-data" },
    );
    assert.deepEqual(
      classifyManagePrototypeScope("Build real support tooling and ticket queue automation"),
      { allowed: false, reason: "real-support-tooling" },
    );
    assert.deepEqual(
      classifyManagePrototypeScope("Start with dashboard-first run inspector mockups"),
      { allowed: false, reason: "dashboard-first" },
    );
    assert.deepEqual(
      classifyManagePrototypeScope("Add a deterministic reference fixture for hobo inspect"),
      { allowed: true, reason: "reference-fixture" },
    );
  });
});
