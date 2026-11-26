---
layout: ../../layouts/Docs.astro
title: Identity & auth
description: "Secretless-first identity: workload SVIDs, brokered tokens, agent principals, continuous identity migration, and residual secrets."
---

# Identity & auth

HoBo is **secretless-first**. Long-lived static cloud keys are the residual path, not the default.

## Principals

| Principal | Notes |
|---|---|
| Humans | Org RBAC roles; OIDC/SSO |
| Workloads | SVID/OIDC per Camp/service |
| Agents (users) | First-class principals with scoped, short-lived credentials |
| Crew operators | Built-in Yard agents under the same model |

## Brokered credentials

1. Task declares needed capabilities.
2. Policy decides allow / deny / mutate / require-approval.
3. Identity brokers a **short-lived, scoped** token to the provider.
4. `CredentialAudit` records access **by reference**, never plaintext secrets in the log.

Confused-deputy and runaway spend are mitigated by scoped SVIDs, policy gates, spend caps, and full replay.

## Continuous identity migration

When identity providers or principal shapes change:

- Dual-path continuity is Matching/policy-driven.
- **Zero required Bindle config** for pure identity continuous.
- Dual fixtures extend offline fixtures.
- Observe with `hobo identity status` / `hobo doctor`.
- Do not invent a parallel IdP DSL or Bindle-only migration product.

Trails may *compose* `identity.continuous`; pure identity continuous needs no Trail authoring.

## Secrets residual path

`secret(name)` / `hobo:secrets` remain for legacy-compatible and residual classical credentials. Prefer `fromBinding`, bound resources, and federation. Config resolution ranks secretless sources first — [Config & secrets](/HoBo/reference/config-secrets/).

## Multi-tenant context

`HOBO_TENANT` / `HOBO_PROJECT` / `HOBO_BRANCH` / `HOBO_ENV` carry soft multi-tenancy. Hard isolation is phased; PolicyEngine is the baseline enforcer. Extreme isolation uses separate Yards/Stations.

## Agents

Agents authenticate like any principal, get tool scopes via MCP, and never receive ambient admin. Details: [Agents](/HoBo/agents/) · [Credentials](/HoBo/security/credentials/) · [Audit](/HoBo/observability/agent-audit/).

## Related

[Security](/HoBo/security/) · [Identity reference](/HoBo/reference/identity/) · [Connections via Station](/HoBo/primitives/stations/)
