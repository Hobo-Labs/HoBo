import {
  POLICY_AUTHORING_SCHEMA_VERSION,
  approvePolicyWaiver,
  compilePolicyPack,
  definePolicyRule,
  evaluatePolicyWaiver,
  proposePolicyPackChange,
  requestPolicyWaiver,
  type PolicyPackChange,
  type PolicyPrincipal,
  type PolicyRuleDraft,
  type PolicyTarget,
  type WaiverApprovalResult,
} from "@hobo/draft-policy-authoring-waiver-contract";

const author: PolicyPrincipal = {
  kind: "user",
  id: "user:alice",
  roles: ["Platform-Engineer"],
  allowedActionIds: ["hobo:policy-pack:update"],
};

const approver: PolicyPrincipal = {
  kind: "user",
  id: "user:bob",
  roles: ["Security-Admin"],
  allowedActionIds: ["hobo:policy-pack:approve"],
};

const target: PolicyTarget = {
  resource: "policy-pack",
  resourceId: "policy-pack:checkout",
  verb: "update",
  phase: "author",
};

const rule: PolicyRuleDraft = definePolicyRule({
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

const change: PolicyPackChange = proposePolicyPackChange({
  operation: "update",
  pack,
  author,
  approverRole: "Security-Admin",
});

const waiver = requestPolicyWaiver({
  requester: author,
  target,
  policyPacks: [pack],
  approverRole: "Security-Admin",
  reason: "temporary rollout unblock",
  now: new Date("2026-06-26T00:00:00.000Z"),
  expiresAt: new Date("2026-06-26T01:00:00.000Z"),
});

if (!waiver.ok) {
  throw new Error(waiver.reason);
}

const approved: WaiverApprovalResult = approvePolicyWaiver({
  waiver: waiver.waiver,
  approver,
  now: new Date("2026-06-26T00:05:00.000Z"),
});

if (!approved.ok) {
  throw new Error(approved.reason);
}

const decision = evaluatePolicyWaiver({
  target,
  waiver: approved.waiver,
  policyPacks: [pack],
  now: new Date("2026-06-26T00:10:00.000Z"),
});

POLICY_AUTHORING_SCHEMA_VERSION satisfies "hobo.policy-authoring/v1";
change.controlPlaneActions satisfies Array<"hobo:policy-pack:create" | "hobo:policy-pack:update" | "hobo:policy-pack:approve">;
decision.effect satisfies "allow" | "deny";
