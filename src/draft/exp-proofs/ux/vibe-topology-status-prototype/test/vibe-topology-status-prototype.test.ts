import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  REQUIRED_TOPOLOGY_STATUS_PROOF_MODES,
  REQUIRED_TOPOLOGY_STATUS_QUICKSTART_FIXTURE_IDS,
  REQUIRED_TOPOLOGY_STATUS_QUICKSTART_PROOF_MODES,
  REQUIRED_TOPOLOGY_STATUS_SCENARIOS,
  REQUIRED_TOPOLOGY_STATUS_STATES,
  REQUIRED_TOPOLOGY_STATUS_SURFACES,
  VIBE_TOPOLOGY_STATUS_PROTOTYPE,
  classifyTopologyStatusRequest,
  parseVibeTopologyStatusPrototype,
  renderTopologyStatusSnapshot,
  renderTopologyStatusSupportPacket,
  resolveTopologyStatusDependencies,
} from "../src/vibe-topology-status-prototype.ts";

describe("HOBO-561 topology/status prototype", () => {
  it("pins issue, phase, target package, proof path, and required surfaces", () => {
    const prototype = parseVibeTopologyStatusPrototype(VIBE_TOPOLOGY_STATUS_PROTOTYPE);

    assert.equal(prototype.issue, "HOBO-561");
    assert.equal(prototype.phase, "M2");
    assert.equal(
      prototype.targetPackage,
      "src/draft/exp-proofs/ux/vibe-topology-status-prototype",
    );
    assert.equal(
      prototype.proofNote,
      "docs/design/proofs/vibe-topology-status-prototype/README.md",
    );
    assert.deepEqual(
      prototype.surfaces.map((surface) => surface.id),
      REQUIRED_TOPOLOGY_STATUS_SURFACES,
    );
  });

  it("consumes accepted M1 dashboard, freshness/RBAC, and HOBO-577 quickstart fixtures", () => {
    const dependencies = resolveTopologyStatusDependencies();
    const prototype = parseVibeTopologyStatusPrototype(VIBE_TOPOLOGY_STATUS_PROTOTYPE);

    assert.deepEqual(
      dependencies.map((dependency) => dependency.issue),
      ["HOBO-544", "HOBO-545", "HOBO-577"],
    );
    assert.ok(
      dependencies.every((dependency) => dependency.status === "accepted"),
      "every upstream proof must be accepted before this M2 prototype composes it",
    );
    assert.ok(
      dependencies.some((dependency) =>
        dependency.evidence.includes("vibe-deployment-dashboard-mockups"),
      ),
    );
    assert.ok(
      dependencies.some((dependency) =>
        dependency.evidence.includes("vibe-dashboard-freshness-rbac-fixtures"),
      ),
    );
    assert.ok(
      dependencies.some((dependency) =>
        dependency.evidence.includes("resource-lifecycle-quickstart-examples"),
      ),
    );
    assert.deepEqual(
      prototype.quickstartFixtureRefs.map((ref) => ref.fixtureId),
      REQUIRED_TOPOLOGY_STATUS_QUICKSTART_FIXTURE_IDS,
    );
    assert.ok(prototype.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
    assert.deepEqual(
      new Set(prototype.quickstartFixtureRefs.map((ref) => ref.proofMode)),
      new Set(REQUIRED_TOPOLOGY_STATUS_QUICKSTART_PROOF_MODES),
    );
    assert.deepEqual(
      new Set(prototype.quickstartFixtureRefs.map((ref) => ref.consumingSurface)),
      new Set(REQUIRED_TOPOLOGY_STATUS_SURFACES),
    );
  });

  it("projects required snapshot states with source, freshness, RBAC, proof mode, and safe action", () => {
    const prototype = parseVibeTopologyStatusPrototype(VIBE_TOPOLOGY_STATUS_PROTOTYPE);

    assert.deepEqual(
      prototype.snapshots.map((snapshot) => snapshot.state),
      REQUIRED_TOPOLOGY_STATUS_STATES,
    );

    for (const snapshot of prototype.snapshots) {
      assert.ok(snapshot.sourceFixtureId.length > 0);
      assert.ok(snapshot.projectionSource.endsWith("View"));
      assert.ok(snapshot.freshnessLabel.length > 0);
      assert.match(snapshot.tenantRbacDisposition, /tenant|RBAC|redact|denied|scope/i);
      assert.match(snapshot.safeNextAction, /inspect|wait|route|rollback|review|handoff|escalate/i);
      assert.ok(REQUIRED_TOPOLOGY_STATUS_PROOF_MODES.includes(snapshot.proofMode));

      const summary = renderTopologyStatusSnapshot(snapshot);
      assert.match(summary, new RegExp(snapshot.state));
      assert.match(summary, new RegExp(snapshot.proofMode));
    }
  });

  it("covers happy, blocked, stale or unknown evidence, support handoff, accessibility, and proof-mode labels", () => {
    const prototype = parseVibeTopologyStatusPrototype(VIBE_TOPOLOGY_STATUS_PROTOTYPE);

    assert.deepEqual(
      prototype.scenarios.map((scenario) => scenario.id),
      REQUIRED_TOPOLOGY_STATUS_SCENARIOS,
    );

    const scenarioStates = new Set(prototype.scenarios.flatMap((scenario) => scenario.snapshotStates));
    for (const state of REQUIRED_TOPOLOGY_STATUS_STATES) {
      assert.ok(scenarioStates.has(state), `missing scenario coverage for ${state}`);
    }

    const proofModes = new Set(prototype.scenarios.flatMap((scenario) => scenario.proofModeLabels));
    for (const proofMode of REQUIRED_TOPOLOGY_STATUS_PROOF_MODES) {
      assert.ok(proofModes.has(proofMode), `missing proof-mode label ${proofMode}`);
    }

    const accessibilityText = prototype.accessibilityNotes.join(" ").toLowerCase();
    for (const phrase of ["keyboard", "screen reader", "color", "motion"]) {
      assert.match(accessibilityText, new RegExp(phrase));
    }
  });

  it("renders support packets without leaking withheld fields or creating live support tooling", () => {
    const prototype = parseVibeTopologyStatusPrototype(VIBE_TOPOLOGY_STATUS_PROTOTYPE);
    const supportSnapshots = prototype.snapshots.filter((snapshot) => snapshot.supportHandoff);

    assert.ok(supportSnapshots.length > 0);
    for (const snapshot of supportSnapshots) {
      const packet = renderTopologyStatusSupportPacket(snapshot);

      assert.equal(packet.issue, "HOBO-561");
      assert.match(packet.customerSafeWording, /No customer payloads or provider credentials/);
      assert.ok(packet.visibleFields.includes("correlationId"));
      assert.ok(packet.withheldFields.includes("rawProjectionPayload"));
      assert.ok(packet.withheldFields.includes("providerCredential"));
      assert.equal(packet.liveTicketCreated, false);
    }
  });

  it("aligns Pact and CUE architecture fixtures with the parsed prototype", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL("../architecture/pacts/vibe_topology_status_prototype.pact.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactPrototype = parseVibeTopologyStatusPrototype(
      pact.interactions[0].response.body,
    );
    assert.deepEqual(
      pactPrototype.snapshots.map((snapshot) => snapshot.state),
      REQUIRED_TOPOLOGY_STATUS_STATES,
    );
    assert.deepEqual(
      pactPrototype.sourceDependencies.map((dependency) => dependency.issue),
      ["HOBO-544", "HOBO-545", "HOBO-577"],
    );
    assert.deepEqual(
      pactPrototype.quickstartFixtureRefs.map((ref) => ref.fixtureId),
      REQUIRED_TOPOLOGY_STATUS_QUICKSTART_FIXTURE_IDS,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_topology_status_prototype.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "quickstartFixtureRefs",
      "sourceIssue",
      "fixtureId",
      "sourceFixtureId",
      "projectionSource",
      "freshnessLabel",
      "tenantRbacDisposition",
      "safeNextAction",
      "proofMode",
      "supportHandoff",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });

  it("fails closed for scope-out dashboard, graph, projection runtime, RBAC, provider, and launch claims", () => {
    assert.deepEqual(classifyTopologyStatusRequest("build production dashboard frontend"), {
      allowed: false,
      reason: "production-dashboard",
    });
    assert.deepEqual(classifyTopologyStatusRequest("ship the graph renderer"), {
      allowed: false,
      reason: "graph-renderer",
    });
    assert.deepEqual(classifyTopologyStatusRequest("implement projection runtime and GraphQL facade"), {
      allowed: false,
      reason: "projection-runtime",
    });
    assert.deepEqual(classifyTopologyStatusRequest("enforce tenant RBAC policy"), {
      allowed: false,
      reason: "rbac-implementation",
    });
    assert.deepEqual(classifyTopologyStatusRequest("traverse live provider topology"), {
      allowed: false,
      reason: "live-provider-traversal",
    });
    assert.deepEqual(classifyTopologyStatusRequest("publish launch readiness claims"), {
      allowed: false,
      reason: "launch-claim",
    });
    assert.deepEqual(
      classifyTopologyStatusRequest("compose accepted projection snapshots into a reference prototype"),
      { allowed: true, reason: "reference-prototype" },
    );
  });

  it("rejects disconnected or incomplete acceptance evidence", () => {
    assert.throws(
      () =>
        parseVibeTopologyStatusPrototype({
          ...VIBE_TOPOLOGY_STATUS_PROTOTYPE,
          snapshots: VIBE_TOPOLOGY_STATUS_PROTOTYPE.snapshots.filter(
            (snapshot) => snapshot.state !== "rolled-back",
          ),
        }),
      /required snapshot state/,
    );

    assert.throws(
      () =>
        parseVibeTopologyStatusPrototype({
          ...VIBE_TOPOLOGY_STATUS_PROTOTYPE,
          sourceDependencies: VIBE_TOPOLOGY_STATUS_PROTOTYPE.sourceDependencies.filter(
            (dependency) => dependency.issue !== "HOBO-577",
          ),
        }),
      /source dependency/,
    );

    assert.throws(
      () =>
        parseVibeTopologyStatusPrototype({
          ...VIBE_TOPOLOGY_STATUS_PROTOTYPE,
          accessibilityNotes: ["Keyboard order is documented.", "Screen reader labels exist."],
        }),
      /accessibility/,
    );

    assert.throws(
      () =>
        parseVibeTopologyStatusPrototype({
          ...VIBE_TOPOLOGY_STATUS_PROTOTYPE,
          quickstartFixtureRefs: VIBE_TOPOLOGY_STATUS_PROTOTYPE.quickstartFixtureRefs.filter(
            (ref) => ref.fixtureId !== "rlq-recover-scope-out-v1",
          ),
        }),
      /quickstart fixture/,
    );

    assert.throws(
      () =>
        parseVibeTopologyStatusPrototype({
          ...VIBE_TOPOLOGY_STATUS_PROTOTYPE,
          quickstartFixtureRefs: [
            {
              ...VIBE_TOPOLOGY_STATUS_PROTOTYPE.quickstartFixtureRefs[0],
              sourceIssue: "HOBO-544",
            },
            ...VIBE_TOPOLOGY_STATUS_PROTOTYPE.quickstartFixtureRefs.slice(1),
          ],
        }),
      /sourceIssue/,
    );
  });
});
