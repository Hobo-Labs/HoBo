# HoBo PrincipalRef Contract POC

Independent proof for HOBO-56: a unified `PrincipalRef` shape for users, agents, and services.

## Contract Surface

- `createPrincipalRef(input)` builds a normalized principal contract object.
- `serializeAsPolicySubject(principal)` and `serializeAsEventActor(principal)` share one serializer so policy decisions and event actors cannot drift.
- Built-in RBAC roles are fixed in `BUILT_IN_ROLES`: org admin, security/policy admin, platform engineer, deployer, operator supervisor, and auditor.
- `delegatedBy` carries an on-behalf-of user-to-agent chain. A service principal cannot be the delegating principal.
- `tenant.platform` models the HoBo platform tenant. `tenant.app` models `ctx.tenant`.
- Missing `tenant.app` serializes as `{ kind: "unresolved", failClosed: true }`, never as all tenants.
- Cross-tenant admin scope is explicit via `ctxTenants`, separate from unresolved `ctxTenant`.

## Guardrails Proved

- Self-asserted roles are ignored; only role bindings populate serialized roles.
- Unresolved app tenant fails closed.
- `delegatedBy` cannot point at a service principal.
- Policy subject and event actor serialization are identical for the same principal.

## Out Of Scope

- Role enforcement and deny-ceiling algebra.
- SSO/SCIM binding runtime.
- The `hobo:*` admin action taxonomy.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Principal Ref Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
