import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  POLICY_WAIVER_APPROVED,
  POLICY_WAIVER_REQUESTED,
  approvePolicyPackChange,
  approvePolicyWaiver,
  compilePolicyPack,
  definePolicyRule,
  evaluatePolicyWaiver,
  proposePolicyPackChange,
  requestPolicyWaiver,
} from "../src/policy-authoring-waiver.js";

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
const now = new Date("2026-06-26T00:00:00.000Z");
const expiresAt = new Date("2026-06-26T01:00:00.000Z");

const author = Object.freeze({
  kind: "user",
  id: "user:alice",
  roles: ["Platform-Engineer"],
  allowedActionIds: ["hobo:policy-pack:update"],
});

const approver = Object.freeze({
  kind: "user",
  id: "user:bob",
  roles: ["Security-Admin"],
  allowedActionIds: ["hobo:policy-pack:approve"],
});

const target = Object.freeze({
  resource: "policy-pack",
  resourceId: "policy-pack:checkout",
  verb: "update",
  phase: "author",
});

test("typed declarations compile a TypeScript policy authoring consumer", () => {
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

test("typed TypeScript rule compiles into a policy pack routed through create/update/approve actions", () => {
  const rule = definePolicyRule({
    id: "require-approval-before-policy-update",
    mode: "default",
    effect: "deny",
    target,
    reason: "policy updates need explicit approval in production",
  });
  const pack = compilePolicyPack({
    id: "yard-policy-governance",
    scope: "yard",
    version: "1.0.0",
    author,
    rules: [rule],
  });
  const createChange = proposePolicyPackChange({
    operation: "create",
    pack,
    author,
    approverRole: "Security-Admin",
  });
  const updateChange = proposePolicyPackChange({
    operation: "update",
    pack,
    author,
    approverRole: "Security-Admin",
  });

  assert.equal(rule.authoring, "typed-typescript-policy-rule");
  assert.equal(pack.schema, "hobo.policy-pack/v1");
  assert.deepEqual(pack.requiredControlPlaneActions, [
    "hobo:policy-pack:create",
    "hobo:policy-pack:update",
    "hobo:policy-pack:approve",
  ]);
  assert.deepEqual(pack.rules, [
    {
      id: "require-approval-before-policy-update",
      mode: "default",
      denies: ["hobo:policy-pack:update:author"],
      allows: [],
      limits: [],
      reason: "policy updates need explicit approval in production",
      target: {
        resource: "policy-pack",
        resourceKind: "hobo:policy-pack",
        resourceId: "policy-pack:checkout",
        verb: "update",
        phase: "author",
        actionId: "hobo:policy-pack:update",
        tuple: "hobo:policy-pack:update:author",
      },
    },
  ]);
  assert.deepEqual(createChange.controlPlaneActions, [
    "hobo:policy-pack:create",
    "hobo:policy-pack:approve",
  ]);
  assert.deepEqual(updateChange.controlPlaneActions, [
    "hobo:policy-pack:update",
    "hobo:policy-pack:approve",
  ]);
});

test("waiver request requires a configured approver role and emits policy.WaiverRequested", () => {
  const pack = defaultDenyPack();
  const missingApprover = requestPolicyWaiver({
    requester: author,
    target,
    policyPacks: [pack],
    approverRole: "",
    reason: "temporary rollout unblock",
    now,
    expiresAt,
  });
  const requested = requestPolicyWaiver({
    requester: author,
    target,
    policyPacks: [pack],
    approverRole: "Security-Admin",
    reason: "temporary rollout unblock",
    now,
    expiresAt,
  });

  assert.equal(missingApprover.ok, false);
  assert.equal(missingApprover.code, "missing-approver-role");
  assert.equal(requested.ok, true);
  assert.equal(requested.waiver.status, "requested");
  assert.equal(requested.waiver.approverRole, "Security-Admin");
  assert.deepEqual(requested.events.map((event) => event.type), [POLICY_WAIVER_REQUESTED]);
  assert.equal(requested.events[0].data.target.tuple, "hobo:policy-pack:update:author");
});

test("approved waiver is scoped, time-bounded, audited, and expires", () => {
  const pack = defaultDenyPack();
  const requested = requestPolicyWaiver({
    requester: author,
    target,
    policyPacks: [pack],
    approverRole: "Security-Admin",
    reason: "temporary rollout unblock",
    now,
    expiresAt,
  });
  assert.equal(requested.ok, true);

  const approved = approvePolicyWaiver({
    waiver: requested.waiver,
    approver,
    now: new Date("2026-06-26T00:05:00.000Z"),
  });
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.events.map((event) => event.type), [
    POLICY_WAIVER_REQUESTED,
    POLICY_WAIVER_APPROVED,
  ]);

  const allowed = evaluatePolicyWaiver({
    target,
    waiver: approved.waiver,
    policyPacks: [pack],
    now: new Date("2026-06-26T00:10:00.000Z"),
  });
  const wrongScope = evaluatePolicyWaiver({
    target: { ...target, resourceId: "policy-pack:billing" },
    waiver: approved.waiver,
    policyPacks: [pack],
    now: new Date("2026-06-26T00:10:00.000Z"),
  });
  const expired = evaluatePolicyWaiver({
    target,
    waiver: approved.waiver,
    policyPacks: [pack],
    now: new Date("2026-06-26T01:00:01.000Z"),
  });

  assert.equal(allowed.effect, "allow");
  assert.equal(allowed.reason, "approved waiver permits default policy exception");
  assert.equal(allowed.evidence.waiverId, approved.waiver.id);
  assert.equal(allowed.evidence.expiresAt, "2026-06-26T01:00:00.000Z");
  assert.deepEqual(allowed.evidence.auditEventTypes, [
    POLICY_WAIVER_REQUESTED,
    POLICY_WAIVER_APPROVED,
  ]);
  assert.equal(wrongScope.effect, "deny");
  assert.match(wrongScope.reason, /scope mismatch/);
  assert.equal(expired.effect, "deny");
  assert.match(expired.reason, /expired/);
});

test("policy pack author cannot self-approve a policy-pack change", () => {
  const pack = defaultDenyPack();
  const change = proposePolicyPackChange({
    operation: "update",
    pack,
    author,
    approverRole: "Security-Admin",
  });
  const selfApproval = approvePolicyPackChange({
    change,
    approver: { ...author, roles: ["Security-Admin"] },
    now,
  });
  const approved = approvePolicyPackChange({ change, approver, now });

  assert.equal(selfApproval.ok, false);
  assert.equal(selfApproval.code, "separation-of-duties");
  assert.equal(approved.ok, true);
  assert.equal(approved.change.status, "approved");
  assert.equal(approved.change.approvedBy.id, "user:bob");
});

test("waiver cannot silently widen a mandatory deny-ceiling", () => {
  const defaultPack = defaultDenyPack();
  const mandatoryPack = compilePolicyPack({
    id: "junction-policy-governance",
    scope: "junction",
    version: "1.0.0",
    author,
    rules: [
      definePolicyRule({
        id: "mandatory-policy-update-freeze",
        mode: "mandatory",
        effect: "deny",
        target,
        reason: "junction freeze blocks policy updates",
      }),
    ],
  });
  const deniedRequest = requestPolicyWaiver({
    requester: author,
    target,
    policyPacks: [mandatoryPack],
    approverRole: "Security-Admin",
    reason: "try to bypass freeze",
    now,
    expiresAt,
  });
  const requested = requestPolicyWaiver({
    requester: author,
    target,
    policyPacks: [defaultPack],
    approverRole: "Security-Admin",
    reason: "temporary rollout unblock",
    now,
    expiresAt,
  });
  assert.equal(requested.ok, true);
  const approved = approvePolicyWaiver({ waiver: requested.waiver, approver, now });
  assert.equal(approved.ok, true);

  const forgedAgainstMandatory = evaluatePolicyWaiver({
    target,
    waiver: approved.waiver,
    policyPacks: [mandatoryPack],
    now,
  });

  assert.equal(deniedRequest.ok, false);
  assert.equal(deniedRequest.code, "mandatory-deny-ceiling");
  assert.equal(forgedAgainstMandatory.effect, "deny");
  assert.match(forgedAgainstMandatory.reason, /mandatory deny-ceiling/);
});

test("self-approved waiver is denied where separation of duties requires another approver", () => {
  const pack = defaultDenyPack();
  const requested = requestPolicyWaiver({
    requester: author,
    target,
    policyPacks: [pack],
    approverRole: "Security-Admin",
    reason: "temporary rollout unblock",
    now,
    expiresAt,
  });
  assert.equal(requested.ok, true);

  const selfApproval = approvePolicyWaiver({
    waiver: requested.waiver,
    approver: { ...author, roles: ["Security-Admin"] },
    now,
  });

  assert.equal(selfApproval.ok, false);
  assert.equal(selfApproval.code, "separation-of-duties");
});

test("waiver request for unreachable action still respects deny-by-default", () => {
  const pack = defaultDenyPack();
  const denied = requestPolicyWaiver({
    requester: { ...author, allowedActionIds: [] },
    target,
    policyPacks: [pack],
    approverRole: "Security-Admin",
    reason: "try to reach forbidden action",
    now,
    expiresAt,
  });

  assert.equal(denied.ok, false);
  assert.equal(denied.code, "deny-by-default");
  assert.match(denied.reason, /requester lacks hobo:policy-pack:update/);
});

function defaultDenyPack() {
  return compilePolicyPack({
    id: "yard-policy-governance",
    scope: "yard",
    version: "1.0.0",
    author,
    rules: [
      definePolicyRule({
        id: "require-approval-before-policy-update",
        mode: "default",
        effect: "deny",
        target,
        reason: "policy updates need explicit approval in production",
      }),
    ],
  });
}
