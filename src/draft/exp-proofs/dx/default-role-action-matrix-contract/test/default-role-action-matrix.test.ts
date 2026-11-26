import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  BUILT_IN_ROLES,
  DEFAULT_ROLE_ACTION_MATRIX_SCHEMA,
  buildGrantSet,
  evaluateControlPlaneAuthorization,
  resolveRoleGrantSet,
} from "../src/default-role-action-matrix.js";

describe("default role action matrix contract", () => {
	it("rejects a non-object request at the parser boundary", () => {
		assert.throws(
			() => evaluateControlPlaneAuthorization([]),
			/input must be an object/,
		);
	});

	it("resolves every built-in role to its Plan 29 grant set", () => {
    assert.deepEqual(BUILT_IN_ROLES, [
      "Org-Admin",
      "Security/Policy-Admin",
      "Platform-Engineer",
      "Deployer",
      "Operator-Supervisor",
      "Auditor",
    ]);

    assert.deepEqual(resolveRoleGrantSet("Auditor"), [
      "hobo:audit:export",
      "hobo:audit:read",
      "hobo:camp:list",
      "hobo:camp:read",
      "hobo:delta:read",
      "hobo:deployment:read",
      "hobo:dispatcher:read",
      "hobo:driver:list",
      "hobo:driver:read",
      "hobo:forge:read",
      "hobo:integration:list",
      "hobo:integration:read",
      "hobo:junction:list",
      "hobo:junction:read",
      "hobo:operator:read",
      "hobo:policy-pack:list",
      "hobo:policy-pack:read",
      "hobo:provider:list",
      "hobo:provider:read",
      "hobo:resource-definition:list",
      "hobo:resource-definition:read",
      "hobo:resource-pack:list",
      "hobo:resource-pack:read",
      "hobo:role:list",
      "hobo:role:read",
      "hobo:yard:list",
      "hobo:yard:read",
    ]);

    assert.deepEqual(resolveRoleGrantSet("Deployer"), [
      "hobo:audit:read",
      "hobo:camp:read",
      "hobo:delta:create",
      "hobo:delta:promote",
      "hobo:delta:update",
      "hobo:dispatcher:read",
      "hobo:driver:read",
      "hobo:integration:read",
      "hobo:junction:read",
      "hobo:policy-pack:read",
      "hobo:provider:read",
      "hobo:resource-definition:read",
      "hobo:resource-pack:read",
      "hobo:yard:read",
    ]);

    assert.equal(buildGrantSet().schema, DEFAULT_ROLE_ACTION_MATRIX_SCHEMA);
  });

  it("denies unlisted grants and prevents Auditor writes or promotion", () => {
    const write = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:auditor", roles: ["Auditor"] },
      resource: "policy-pack",
      verb: "update",
      phase: "author",
    });
    const promote = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:auditor", roles: ["Auditor"] },
      resource: "delta",
      verb: "promote",
      phase: "apply",
      context: { targetEnvironment: "prod", deltaOpenedBy: "user:deployer" },
    });

    assert.equal(write.effect, "deny");
    assert.match(write.reason, /no built-in role grants/);
    assert.equal(promote.effect, "deny");
    assert.match(promote.violations.join("\n"), /Auditor/);
  });

  it("blocks policy-pack self-approval and requires Security Policy Admin approval", () => {
    const authorSelfApproves = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:alice", roles: ["Org-Admin"] },
      resource: "policy-pack",
      verb: "approve",
      phase: "apply",
      context: {
        policyPackId: "policy-pack:deny-egress",
        changeAuthorId: "user:alice",
      },
    });

    const securityAdminApproves = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:security-admin", roles: ["Security/Policy-Admin"] },
      resource: "policy-pack",
      verb: "approve",
      phase: "apply",
      context: {
        policyPackId: "policy-pack:deny-egress",
        changeAuthorId: "user:alice",
      },
    });

    assert.equal(authorSelfApproves.effect, "deny");
    assert.match(authorSelfApproves.violations.join("\n"), /author cannot approve/);
    assert.deepEqual(securityAdminApproves.obligations, []);
    assert.equal(securityAdminApproves.effect, "allow");
  });

  it("fails closed when policy approval cannot prove author separation", () => {
    const decision = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:security-admin", roles: ["Security/Policy-Admin"] },
      resource: "policy-pack",
      verb: "approve",
      phase: "apply",
    });

    assert.equal(decision.effect, "deny");
    assert.match(decision.violations.join("\n"), /changeAuthorId/);
  });

  it("requires prod delta promotion approval while allowing lower-environment promotion", () => {
    const prod = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:deployer", roles: ["Deployer"] },
      resource: "delta",
      verb: "promote",
      phase: "apply",
      context: {
        targetEnvironment: "prod",
        deltaOpenedBy: "user:someone-else",
      },
    });
    const staging = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:deployer", roles: ["Deployer"] },
      resource: "delta",
      verb: "promote",
      phase: "apply",
      context: {
        targetEnvironment: "staging",
        deltaOpenedBy: "user:deployer",
      },
    });
    const missingTarget = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:deployer", roles: ["Deployer"] },
      resource: "delta",
      verb: "promote",
      phase: "apply",
    });
    const missingOpener = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:deployer", roles: ["Deployer"] },
      resource: "delta",
      verb: "promote",
      phase: "apply",
      context: {
        targetEnvironment: "prod",
      },
    });

    assert.equal(prod.effect, "require-approval");
    assert.deepEqual(prod.obligations, [
      {
        kind: "policy.approval-required",
        actionId: "hobo:delta:promote",
        reason: "prod delta promotion requires approval",
        approverRole: "Security/Policy-Admin",
      },
    ]);
    assert.equal(staging.effect, "allow");
    assert.equal(missingTarget.effect, "deny");
    assert.match(missingTarget.violations.join("\n"), /targetEnvironment/);
    assert.equal(missingOpener.effect, "deny");
    assert.match(missingOpener.violations.join("\n"), /deltaOpenedBy/);
  });

  it("blocks the Delta opener from promoting that Delta to prod", () => {
    const decision = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:deployer", roles: ["Deployer"] },
      resource: "delta",
      verb: "promote",
      phase: "apply",
      context: {
        targetEnvironment: "prod",
        deltaOpenedBy: "user:deployer",
      },
    });

    assert.equal(decision.effect, "deny");
    assert.match(decision.violations.join("\n"), /delta opener cannot promote/);
  });

  it("enforces two-person approval even for Org Admin policy changes", () => {
    const decision = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:org-admin", roles: ["Org-Admin"] },
      resource: "policy-pack",
      verb: "approve",
      phase: "apply",
      context: {
        changeAuthorId: "user:org-admin",
        requiresTwoPersonApproval: true,
      },
    });

    assert.equal(decision.effect, "deny");
    assert.match(decision.violations.join("\n"), /two-person approval/);
  });

  it("prevents role:bind self-escalation beyond the binder grant set", () => {
    const allowed = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:security-admin", roles: ["Security/Policy-Admin"] },
      resource: "role",
      verb: "bind",
      phase: "author",
      context: {
        requestedGrantActionIds: ["hobo:policy-pack:read"],
        bindTargetPrincipalId: "user:analyst",
      },
    });

    const escalation = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:security-admin", roles: ["Security/Policy-Admin"] },
      resource: "role",
      verb: "bind",
      phase: "author",
      context: {
        requestedGrantActionIds: ["hobo:dispatcher:configure"],
        bindTargetPrincipalId: "user:security-admin",
      },
    });
    const hiddenBuiltInEscalation = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:security-admin", roles: ["Security/Policy-Admin"] },
      resource: "role",
      verb: "bind",
      phase: "author",
      context: {
        targetRole: "Org-Admin",
        bindTargetPrincipalId: "user:security-admin",
      },
    });
    const missingTargetGrantContract = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:security-admin", roles: ["Security/Policy-Admin"] },
      resource: "role",
      verb: "bind",
      phase: "author",
      context: {
        bindTargetPrincipalId: "user:analyst",
      },
    });
    const orgAdminBindsDeployer = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:org-admin", roles: ["Org-Admin"] },
      resource: "role",
      verb: "bind",
      phase: "author",
      context: {
        targetRole: "Deployer",
        bindTargetPrincipalId: "user:deployer",
      },
    });

    assert.equal(allowed.effect, "allow");
    assert.equal(escalation.effect, "deny");
    assert.match(escalation.violations.join("\n"), /cannot bind grants it does not already hold/);
    assert.equal(hiddenBuiltInEscalation.effect, "deny");
    assert.match(hiddenBuiltInEscalation.violations.join("\n"), /cannot bind grants it does not already hold/);
    assert.equal(missingTargetGrantContract.effect, "deny");
    assert.match(missingTargetGrantContract.violations.join("\n"), /targetRole or requestedGrantActionIds/);
    assert.equal(orgAdminBindsDeployer.effect, "allow");
  });

  it("keeps Operator Supervisor forge execution capped to Crew operator principals", () => {
    const human = evaluateControlPlaneAuthorization({
      subject: { kind: "user", id: "user:ops-supervisor", roles: ["Operator-Supervisor"] },
      resource: "forge",
      verb: "execute",
      phase: "repair",
    });
    const crewOperator = evaluateControlPlaneAuthorization({
      subject: { kind: "operator", id: "operator:swe-repair", roles: ["Operator-Supervisor"] },
      resource: "forge",
      verb: "execute",
      phase: "repair",
    });
    const platformEngineer = evaluateControlPlaneAuthorization({
      subject: {
        kind: "user",
        id: "user:platform-engineer",
        roles: ["Operator-Supervisor", "Platform-Engineer"],
      },
      resource: "forge",
      verb: "execute",
      phase: "repair",
    });

    assert.equal(human.effect, "deny");
    assert.match(human.violations.join("\n"), /Crew operator/);
    assert.equal(crewOperator.effect, "allow");
    assert.equal(platformEngineer.effect, "allow");
    assert.deepEqual(platformEngineer.obligations, []);
    assert.deepEqual(crewOperator.obligations, [
      {
        kind: "crew.operator-cap",
        actionId: "hobo:forge:execute",
        principalId: "operator:swe-repair",
      },
    ]);
  });
});
