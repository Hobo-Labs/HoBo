import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ACTION_TAXONOMY_SCHEMA,
  CONTROL_PLANE_ACTIONS,
  buildControlPlaneActionId,
  checkControlPlaneCompleteness,
  expandManage,
  highPrivilegeActionIds,
  lowerControlPlaneDecisionRequest,
  validateControlPlaneTaxonomy
} from "../src/control-plane-action-taxonomy.js";

const expectedRows = {
  "provider": ["register", "read", "list", "update", "deprecate"],
  "resource-definition": ["create", "read", "list", "update", "delete"],
  "resource-pack": ["install", "read", "list", "publish", "yank"],
  "listing": ["publish", "read", "list", "install", "yank", "approve"],
  "driver": ["register", "read", "list", "update"],
  "integration": ["register", "read", "list", "update", "deprecate"],
  "dispatcher": ["read", "configure"],
  "policy-pack": ["create", "read", "list", "update", "delete", "approve"],
  "role": ["create", "read", "list", "update", "delete", "bind"],
  "yard": ["create", "read", "list", "update", "delete", "configure"],
  "camp": ["create", "read", "list", "update", "delete", "configure"],
  "junction": ["create", "read", "list", "update", "delete", "configure"],
  "delta": ["create", "read", "update", "approve", "promote"],
  "deployment": ["read", "rollback"],
  "forge": ["execute", "read"],
  "operator": ["read", "configure", "dispatch", "disable"],
  "secret-broker": ["read-metadata", "rotate", "configure"],
  "audit": ["read", "export"],
  "derivative": ["upgrade", "read"],
  "registry": ["import", "read"],
  "relay": ["register", "attach", "read", "revoke"]
};

describe("control-plane action taxonomy contract", () => {
  it("pins every Plan 29 resource/verb row to a stable hobo:* action id", () => {
    assert.equal(CONTROL_PLANE_ACTIONS.schema, ACTION_TAXONOMY_SCHEMA);
    assert.deepEqual(Object.keys(CONTROL_PLANE_ACTIONS.resources), Object.keys(expectedRows));

    const validation = validateControlPlaneTaxonomy(CONTROL_PLANE_ACTIONS);

    assert.equal(validation.ok, true, validation.errors.join("\n"));
    for (const [resource, verbs] of Object.entries(expectedRows)) {
      assert.deepEqual(CONTROL_PLANE_ACTIONS.resources[resource].actions, verbs);
      for (const verb of verbs) {
        assert.equal(buildControlPlaneActionId(resource, verb), `hobo:${resource}:${verb}`);
      }
    }
  });

  it("fails the completeness gate for a CLI or MCP verb without an action id", () => {
    const result = checkControlPlaneCompleteness({
      taxonomy: CONTROL_PLANE_ACTIONS,
      controlPlaneVerbs: [
        {
          surface: "cli",
          command: "hobo registry import",
          resource: "registry",
          verb: "import"
        },
        {
          surface: "mcp",
          command: "relay.attach",
          resource: "relay",
          verb: "attach"
        },
        {
          surface: "cli",
          command: "hobo provider bless",
          resource: "provider",
          verb: "bless"
        }
      ]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingMappings, [
      {
        surface: "cli",
        command: "hobo provider bless",
        resource: "provider",
        verb: "bless",
        reason: "unknown action id hobo:provider:bless"
      }
    ]);
    assert.deepEqual(result.mappedActionIds, [
      "hobo:registry:import",
      "hobo:relay:attach"
    ]);
  });

  it("keeps secret-broker value reads ungrantable while allowing metadata and rotation", () => {
    const broker = CONTROL_PLANE_ACTIONS.resources["secret-broker"];

    assert.deepEqual(broker.actions, ["read-metadata", "rotate", "configure"]);
    assert.equal(broker.actions.includes("read"), false);
    assert.equal(broker.actions.includes("read-value"), false);
    assert.throws(
      () =>
        lowerControlPlaneDecisionRequest({
          subject: { kind: "user", id: "user:auditor" },
          resource: "secret-broker",
          verb: "read",
          phase: "runtime"
        }),
      /unknown action id hobo:secret-broker:read/
    );

    const metadataRead = lowerControlPlaneDecisionRequest({
      subject: { kind: "user", id: "user:auditor" },
      resource: "secret-broker",
      verb: "read-metadata",
      phase: "runtime"
    });

    assert.equal(metadataRead.resource.kind, "hobo:secret-broker");
    assert.equal(metadataRead.action, "read-metadata");
  });

  it("includes the high-privilege derivative, registry bundle import, and relay actions", () => {
    assert.deepEqual(highPrivilegeActionIds(CONTROL_PLANE_ACTIONS), [
      "hobo:derivative:upgrade",
      "hobo:registry:import",
      "hobo:relay:attach",
      "hobo:relay:register"
    ]);
  });

  it("lowers a control-plane operation into the policy DecisionRequest shape", () => {
    const request = lowerControlPlaneDecisionRequest({
      subject: {
        kind: "agent",
        id: "agent:planner",
        roles: ["Platform-Engineer"]
      },
      resource: "dispatcher",
      verb: "configure",
      phase: "author",
      context: {
        objective: "maximize-credits"
      }
    });

    assert.deepEqual(request, {
      subject: {
        kind: "agent",
        id: "agent:planner",
        roles: ["Platform-Engineer"]
      },
      action: "configure",
      resource: {
        kind: "hobo:dispatcher"
      },
      phase: "author",
      context: {
        objective: "maximize-credits"
      },
      actionId: "hobo:dispatcher:configure"
    });
  });

  it("expands manage only to verbs declared for that resource", () => {
    assert.deepEqual(expandManage("deployment"), ["read", "rollback"]);
    assert.equal(expandManage("deployment").includes("promote"), false);
    assert.deepEqual(expandManage("role"), ["create", "read", "list", "update", "delete", "bind"]);
  });
});
