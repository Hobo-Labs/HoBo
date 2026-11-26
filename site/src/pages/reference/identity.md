---
layout: ../../layouts/Docs.astro
title: Identity ports
description: "Workload SVIDs, token brokering, connections, continuous identity migration, dual fixtures, and credential audit refs-only posture."
---

# Identity ports

**Identity services** own workload identity, connection lifecycle, continuous identity migration, config resolution ladder integration points, and progressive Harness adapters that identity continuous reuses. App authors rarely touch them directly; CLI (`hobo identity`, `hobo doctor`) and the Yard Gateway do.

## Responsibilities

| Concern | Surface |
|---|---|
| Issue / rotate workload SVIDs | SPIFFE-style identities per Camp/service |
| Broker short-lived provider tokens | Capability-scoped grants after policy |
| Connections | Authorize, status, events — Station-bound |
| Continuous identity migration | Dual-path `PrincipalRef` continuity |
| Dual fixtures | Offline -style fixtures for dual-path tests |
| Attestation | Measurement / launch attestation documents |
| Credential audit | **Refs only** — never plaintext secrets in events |

## Continuous identity migration

When IdPs or principal shapes change:

1. Matching/policy drives **dual-path** continuity.
2. **Zero required Bindle config** for pure identity continuous.
3. Dual fixtures extend offline fixtures; live paths stay policy-gated.
4. Observe with `hobo identity status` and `hobo doctor`.
5. Do **not** invent a parallel IdP product or Bindle migration DSL.

Trails may compose `identity.continuous` as a step kind; pure identity continuous still needs no Trail authoring.

## Token events & retention

Token issuance, rotation, and access facts use `token.*` / `identity.*` families. `CredentialAudit` and `secret.Accessed` store **references and scopes**, never material. Audit streams are never-compact by policy.

## Config ladder (handoff)

Identity brokers federation; secretless config resolution ranks:

1. `bound-resource`
2. `provider-federation`
3. `camp-value`
4. `static-escape` (≤7d residual)

Full ladder: [Config & secrets](/HoBo/reference/config-secrets/).

## Gateway auth

Gateway authenticates humans (OIDC/SSO) and agents/workloads (SVIDs), then authorizes ABAC over `(principal, tenant, port, resource, action)` — again at the broker for placement actions.

## Related

[Identity guide](/HoBo/security/identity/) · [Config & secrets](/HoBo/reference/config-secrets/) · [Agent credentials](/HoBo/security/credentials/) · [Trails](/HoBo/primitives/trails/)
