---
layout: ../../layouts/Docs.astro
title: Config & secrets
description: "Secretless-first resolution ladder, config schema, fromBinding, residual secrets, local overrides, and never-plaintext audit."
---

# Config & secrets

HoBo is **secretless-first**. Long-lived static secrets are a **residual** legacy-compatible path, not the default architecture.

## Authoring (`hobo/bindles`)

| Surface | Role |
|---|---|
| `config({ ... })` | Schema of env + secret fields |
| `env.string()` / dual `env({...})` | Non-secret configuration |
| `secret.string().source(...)` | Residual secret fields with explicit source |
| `secretRef` / `fromBinding` | References, not values |
| `secret(name)` resource | Catalog secret resource (residual) |

Code generation materializes a typed config view for your handlers. Gatekeeper can require a **secretless-config** check so residual secrets stay intentional and time-boxed.

## Resolution ladder

Config resolution ranks sources in this order:

1. **bound-resource** — capability from bound infrastructure
2. **provider-federation** — OIDC/workload identity exchange
3. **camp-value** — Camp-provided non-secret or brokered material
4. **static-escape** — time-boxed residual (≤7d class constraints)

Camp adapters (Vault JWT/OIDC, AWS Secrets Manager, Azure Key Vault, …) fetch through **brokered** paths — workloads do not hold master keys.

## Events

| Event | Payload rule |
|---|---|
| `config.Resolved` | Refs and ranks only |
| `secret.Accessed` | Refs only — **never** material |

Credential audit streams are never-compact.

## Local overrides

Local non-sensitive overrides can be encrypted at rest for developer machines. Agents and `hobo dev` see a **schema-only view** plus contract-asserted fixtures — **no plaintext** in agent context, events, or IaC.

## Conformance

Conformance fails closed on plaintext leakage patterns in the residual path.

## WIT

Experimental `hobo:secrets` WIT capability for component hosts that need a residual secrets store bridge.

## Related

[Identity](/HoBo/reference/identity/) · [Identity guide](/HoBo/security/identity/) · [Resources](/HoBo/primitives/resources/) · [Agent credentials](/HoBo/security/credentials/)
