import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../hobo-policy-ir-contract/src/policy-ir.js";

import {
  USER_AUTHORIZATION_ENGINE_ID,
  allow,
  authorizeUserRecord,
  createUserAuthorizationRuleset,
  lowerAllowToUserClaimRule,
  ownerClaimPolicyRule,
} from "../src/end-user-authorization-policy.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

test("verified ctx.user owner claims can read their own record and audit as the actor", () => {
  const result = authorizeUserRecord({
    ctx: verifiedUserContext({ id: "user:alice", scopes: ["record:read"] }),
    action: "record:read",
    resource: { kind: "record", id: "record:alpha" },
    record: {
      id: "record:alpha",
      ownerUserId: "user:alice",
      tenantId: "tenant-a",
    },
    requestBody: {
      ownerUserId: "user:bob",
    },
    ruleset: createUserAuthorizationRuleset({
      rules: [ownerClaimPolicyRule(recordOwnerRuleInput())],
    }),
  });

  assert.equal(result.request.subject.kind, "user");
  assert.equal(result.request.subject.id, "user:alice");
  assert.deepEqual(result.request.subject.roles, ["member"]);
  assert.deepEqual(result.request.subject.scopes, ["record:read"]);
  assert.equal(result.request.context.user.tenantId, "tenant-a");
  assert.equal(result.request.context.claimSource, "ctx.user.verified");

  assert.equal(result.decision.effect, "allow");
  assert.equal(result.decision.reason, "record owner claim satisfied");
  assert.equal(result.decision.evidence.engine, USER_AUTHORIZATION_ENGINE_ID);
  assert.deepEqual(result.decision.evidence.policyIds, ["allow-record-owner-read"]);

  assert.equal(result.auditEvent.type, "policy.Decided");
  assert.equal(result.auditEvent.subject.kind, "user");
  assert.equal(result.auditEvent.subject.id, "user:alice");
  assert.equal(result.auditEvent.data.evidence.inputHash, result.decision.evidence.inputHash);
});

test("verified ctx.user is denied when the record belongs to another user", () => {
  const result = authorizeUserRecord({
    ctx: verifiedUserContext({ id: "user:alice", scopes: ["record:read"] }),
    action: "record:read",
    resource: { kind: "record", id: "record:beta" },
    record: {
      id: "record:beta",
      ownerUserId: "user:bob",
      tenantId: "tenant-a",
    },
    ruleset: createUserAuthorizationRuleset({
      rules: [ownerClaimPolicyRule(recordOwnerRuleInput())],
    }),
  });

  assert.equal(result.decision.effect, "deny");
  assert.equal(result.decision.reason, "record owner claim did not match ctx.user");
  assert.match(result.decision.violations.join("\n"), /record owner user:bob does not match subject user:alice/);
  assert.deepEqual(result.decision.evidence.policyIds, ["allow-record-owner-read"]);
});

test("request body claims cannot forge ownership over the verified ctx.user subject", () => {
  const result = authorizeUserRecord({
    ctx: verifiedUserContext({ id: "user:alice", scopes: ["record:read"] }),
    action: "record:read",
    resource: { kind: "record", id: "record:gamma" },
    record: {
      id: "record:gamma",
      ownerUserId: "user:bob",
      tenantId: "tenant-a",
    },
    requestBody: {
      user: {
        id: "user:bob",
        verified: true,
      },
      ownerUserId: "user:alice",
    },
    ruleset: createUserAuthorizationRuleset({
      rules: [ownerClaimPolicyRule(recordOwnerRuleInput())],
    }),
  });

  assert.equal(result.request.subject.id, "user:alice");
  assert.equal(result.request.context.record.ownerUserId, "user:bob");
  assert.deepEqual(result.request.context.requestBodyClaims, {
    fields: ["ownerUserId", "user"],
    hasUserClaim: true,
  });
  assert.equal(Object.hasOwn(result.request.context, "requestBody"), false);
  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join("\n"), /request body user claims are ignored/);
});

test("absent or unresolved ctx.user fails closed before user policy rules run", () => {
  const absent = authorizeUserRecord({
    ctx: {},
    action: "record:read",
    resource: { kind: "record", id: "record:delta" },
    record: {
      id: "record:delta",
      ownerUserId: "user:alice",
      tenantId: "tenant-a",
    },
    ruleset: createUserAuthorizationRuleset({
      rules: [ownerClaimPolicyRule(recordOwnerRuleInput())],
    }),
  });
  const unresolved = authorizeUserRecord({
    ctx: {
      user: {
        id: "user:alice",
        verified: false,
      },
    },
    action: "record:read",
    resource: { kind: "record", id: "record:delta" },
    record: {
      id: "record:delta",
      ownerUserId: "user:alice",
      tenantId: "tenant-a",
    },
    ruleset: createUserAuthorizationRuleset({
      rules: [ownerClaimPolicyRule(recordOwnerRuleInput())],
    }),
  });

  for (const result of [absent, unresolved]) {
    assert.equal(result.request.subject.kind, "system");
    assert.equal(result.decision.effect, "deny");
    assert.equal(result.decision.reason, "ctx.user must be verified before user authorization");
    assert.deepEqual(result.decision.evidence.policyIds, []);
    assert.equal(result.auditEvent.type, "policy.Decided");
  }
});

test(".allow() lowers to the same user-claim policy rule instead of a second authz path", () => {
  const explicitRule = ownerClaimPolicyRule(recordOwnerRuleInput());
  const shorthand = allow(recordOwnerRuleInput());
  const loweredRule = lowerAllowToUserClaimRule(shorthand);

  assert.equal(shorthand.authoring, "allow-shorthand");
  assert.equal(shorthand.when, undefined);
  assert.equal(shorthand.decide, undefined);
  assert.equal(loweredRule.authoring, explicitRule.authoring);

  const requestInput = {
    ctx: verifiedUserContext({ id: "user:alice", scopes: ["record:read"] }),
    action: "record:read",
    resource: { kind: "record", id: "record:alpha" },
    record: {
      id: "record:alpha",
      ownerUserId: "user:alice",
      tenantId: "tenant-a",
    },
  };
  const explicit = authorizeUserRecord({
    ...requestInput,
    ruleset: createUserAuthorizationRuleset({ rules: [explicitRule] }),
  });
  const lowered = authorizeUserRecord({
    ...requestInput,
    ruleset: createUserAuthorizationRuleset({ rules: [loweredRule] }),
  });

  assert.equal(canonicalJson(explicit.decision), canonicalJson(lowered.decision));
  assert.equal(lowered.decision.evidence.engine, USER_AUTHORIZATION_ENGINE_ID);
});

test("typed declarations compile an end-user authorization policy consumer", () => {
  const result = spawnSync(
    process.execPath,
    [tscPath, "--noEmit", "--project", "tsconfig.types.json"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: false,
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

function verifiedUserContext(overrides = {}) {
  return {
    user: {
      id: "user:alice",
      verified: true,
      roles: ["member"],
      scopes: [],
      tenantId: "tenant-a",
      ...overrides,
    },
  };
}

function recordOwnerRuleInput() {
  return {
    id: "allow-record-owner-read",
    action: "record:read",
    resourceKind: "record",
    ownerField: "ownerUserId",
    tenantField: "tenantId",
    requiredScope: "record:read",
  };
}
