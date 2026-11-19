import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  REQUIRED_JOURNEY_COVERAGE,
  REQUIRED_PROOF_MODES,
  WORKSPACE_PROJECT_STATES,
  VIBE_WORKSPACE_PROJECT_STATE_MODEL,
  classifyWorkspaceProjectStateScope,
  listWorkspaceProjectWireframes,
  parseVibeWorkspaceProjectStateModel,
} from "../src/vibe-workspace-project-states.ts";

describe("vibe workspace/project state proof", () => {
  it("pins the HOBO-541 package, proof note, and six required workspace/project states", () => {
    const model = parseVibeWorkspaceProjectStateModel(VIBE_WORKSPACE_PROJECT_STATE_MODEL);

    assert.equal(model.issue, "HOBO-541");
    assert.equal(model.targetPackage, "src/draft/exp-proofs/ux/vibe-workspace-project-states");
    assert.equal(model.proofNote, "docs/design/proofs/vibe-workspace-project-states/README.md");
    assert.deepEqual(
      model.fixtures.map((fixture) => fixture.state),
      WORKSPACE_PROJECT_STATES,
    );
  });

  it("makes every state fixture carry workspace, project, provider-readiness, blocker, action, and evidence fields", () => {
    const model = parseVibeWorkspaceProjectStateModel(VIBE_WORKSPACE_PROJECT_STATE_MODEL);

    for (const fixture of model.fixtures) {
      assert.match(fixture.workspace.id, /^wsp-[a-z0-9-]+$/);
      assert.match(fixture.project.id, /^prj-[a-z0-9-]+$/);
      assert.ok(fixture.providerReadiness.status.length > 0);
      assert.ok(fixture.blockerOwner.length > 0);
      assert.ok(fixture.safeNextAction.label.length > 0);
      assert.match(fixture.evidenceLink.href, /^docs\/design\/proofs\/[a-z0-9-]+\/README\.md#/);
      assert.equal(fixture.safeNextAction.destructive, false);
      assert.equal(fixture.safeNextAction.opensLiveProvider, false);
    }
  });

  it("covers happy, blocked, stale or unknown, support handoff, and accessibility journeys", () => {
    const model = parseVibeWorkspaceProjectStateModel(VIBE_WORKSPACE_PROJECT_STATE_MODEL);
    const coverage = new Set(model.fixtures.flatMap((fixture) => fixture.pathCoverage));

    for (const required of REQUIRED_JOURNEY_COVERAGE) {
      assert.ok(coverage.has(required), `missing ${required}`);
    }
    assert.ok(model.fixtures.some((fixture) => fixture.supportHandoff.required));
    assert.ok(model.fixtures.every((fixture) => fixture.accessibilityNotes.length >= 2));
  });

  it("represents mockups and wireframes for each state without claiming production UI", () => {
    const model = parseVibeWorkspaceProjectStateModel(VIBE_WORKSPACE_PROJECT_STATE_MODEL);
    const wireframes = listWorkspaceProjectWireframes(model);

    assert.deepEqual(
      wireframes.map((wireframe) => wireframe.state),
      WORKSPACE_PROJECT_STATES,
    );
    for (const wireframe of wireframes) {
      assert.ok(wireframe.regions.includes("primary-status"));
      assert.ok(wireframe.regions.includes("safe-next-action"));
      assert.ok(wireframe.caption.length > 0);
    }
  });

  it("labels live, simulated, reference fixture, and scope-out proof modes explicitly", () => {
    const model = parseVibeWorkspaceProjectStateModel(VIBE_WORKSPACE_PROJECT_STATE_MODEL);
    const modes = new Set([
      ...model.modeNotes.map((note) => note.proofMode),
      ...model.fixtures.map((fixture) => fixture.proofMode),
      ...model.fixtures.map((fixture) => fixture.evidenceLink.proofMode),
    ]);

    for (const mode of REQUIRED_PROOF_MODES) {
      assert.ok(modes.has(mode), `missing proof mode ${mode}`);
    }
  });

  it("rejects live providers, customer data, launch claims, account/auth/billing, and production UI creep", () => {
    for (const request of [
      "call a live provider to make this workspace green",
      "show customer data from a real tenant",
      "publish launch claims from this mockup",
      "wire this into the account service and auth flow",
      "build the production dashboard UI",
      "add billing upgrade logic",
    ]) {
      assert.equal(classifyWorkspaceProjectStateScope(request).allowed, false, request);
    }

    assert.equal(
      classifyWorkspaceProjectStateScope("add a reference fixture row for blocked project evidence").allowed,
      true,
    );
  });

  it("fails closed when state coverage, evidence, or safe-action fields drift", () => {
    assert.throws(
      () =>
        parseVibeWorkspaceProjectStateModel({
          ...VIBE_WORKSPACE_PROJECT_STATE_MODEL,
          fixtures: VIBE_WORKSPACE_PROJECT_STATE_MODEL.fixtures.filter(
            (fixture) => fixture.state !== "failed",
          ),
        }),
      /missing workspace project state failed/,
    );

    assert.throws(
      () =>
        parseVibeWorkspaceProjectStateModel({
          ...VIBE_WORKSPACE_PROJECT_STATE_MODEL,
          fixtures: VIBE_WORKSPACE_PROJECT_STATE_MODEL.fixtures.map((fixture) =>
            fixture.state === "blocked"
              ? {
                  ...fixture,
                  safeNextAction: {
                    ...fixture.safeNextAction,
                    opensLiveProvider: true,
                  },
                }
              : fixture,
          ),
        }),
      /blocked safeNextAction must not open live providers/,
    );

    assert.throws(
      () =>
        parseVibeWorkspaceProjectStateModel({
          ...VIBE_WORKSPACE_PROJECT_STATE_MODEL,
          fixtures: VIBE_WORKSPACE_PROJECT_STATE_MODEL.fixtures.map((fixture) =>
            fixture.state === "value-proven"
              ? {
                  ...fixture,
                  evidenceLink: {
                    ...fixture.evidenceLink,
                    href: "",
                  },
                }
              : fixture,
          ),
        }),
      /value-proven evidenceLink.href must not be empty/,
    );
  });

  it("keeps Pact and CUE boundary artifacts aligned with the parsed model shape", () => {
    const pact = JSON.parse(
      readFileSync(
        new URL("../architecture/pacts/vibe_workspace_project_states.pact.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactModel = parseVibeWorkspaceProjectStateModel(pact.interactions[0].response.body);
    assert.deepEqual(
      pactModel.fixtures.map((fixture) => fixture.state),
      WORKSPACE_PROJECT_STATES,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_workspace_project_states.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "targetPackage",
      "proofNote",
      "providerReadiness",
      "blockerOwner",
      "safeNextAction",
      "evidenceLink",
      "supportHandoff",
      "accessibilityNotes",
      "proofMode",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });
});
