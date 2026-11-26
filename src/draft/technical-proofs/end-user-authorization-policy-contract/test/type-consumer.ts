import {
  allow,
  authorizeUserRecord,
  createUserAuthorizationRuleset,
  lowerAllowToUserClaimRule,
} from "@hobo/draft-end-user-authorization-policy-contract";

const ownerRead = lowerAllowToUserClaimRule(allow({
  id: "allow-record-owner-read",
  action: "record:read",
  resourceKind: "record",
  ownerField: "ownerUserId",
  tenantField: "tenantId",
  requiredScope: "record:read",
}));

const result = authorizeUserRecord({
  ctx: {
    user: {
      id: "user:alice",
      verified: true,
      tenantId: "tenant-a",
      scopes: ["record:read"],
    },
  },
  action: "record:read",
  resource: {
    kind: "record",
    id: "record:alpha",
  },
  record: {
    ownerUserId: "user:alice",
    tenantId: "tenant-a",
  },
  ruleset: createUserAuthorizationRuleset({
    rules: [ownerRead],
  }),
});

const effect: "allow" | "allow-degraded" | "deny" | "warn" | "mutate" | "require-approval" =
  result.decision.effect;

void effect;
