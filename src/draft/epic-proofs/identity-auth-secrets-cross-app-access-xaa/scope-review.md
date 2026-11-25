# Adversarial Scope Review

## Accepted Epic Inputs

The selected epic is `Identity, Auth, Secrets & Cross-App Access (XAA)` (`fd8de913-fe73-4b49-8388-28c5f19cc95c`). The accepted POCs are the project-owned Identity child tasks from HOBO-44 through HOBO-287 that define SVIDs, auth runtime, secretless config, XAA, adversarial guards, bootstrap, HA, and audit export.

The reference implementation integrates their behavior and contracts, not their production internals. It does not drain adjacent SDK, networking, provider, policy, or runtime backlog.

## Slice Decisions

| Slice | Accepted POCs | Keep | Discard | Contract strategy |
|---|---|---|---|---|
| Workload credential ladder | HOBO-44, HOBO-48, HOBO-71, HOBO-77, HOBO-84, HOBO-90, HOBO-99, HOBO-110, HOBO-247, HOBO-266, HOBO-275, HOBO-287 | Attestation-derived tenant, SVID subject, auth.json flow order, OIDC federation, scoped provider token, bounded renewal grace | Live cloud STS, production KMS, static-key happy path, caller-supplied tenant/grace | Consumer Pacts for attestation, registry, STS, JWKS, broker cache, secret provider |
| App-user auth and secretless config | HOBO-56, HOBO-63, HOBO-66, HOBO-222, HOBO-226, HOBO-229, HOBO-238 | `ctx.user`, tenant/RBAC fail-closed, session replay, secret refs, audit events | Live IdP, SCIM runtime, typed `ctx.config` codegen, MFA | Consumer Pacts for JWKS, session projection, policy, secret provider, SIEM |
| Cross-App Access delegation | HOBO-54, HOBO-230, HOBO-233, HOBO-235, HOBO-250, HOBO-255, HOBO-271 | ID-JAG draft pin, user-to-agent delegation, inferred scope ceiling, inbound resource verification, replay denial | SDK authoring/codegen, target SaaS calls, real policy pack storage | Consumer Pacts for policy gate, external app AS, JWKS, session projection |
| Identity governance and observation | HOBO-71, HOBO-242, HOBO-244, HOBO-262, HOBO-279, HOBO-282 | Stable issuer/JWKS, genesis custody events, break-glass emergency gate, X.509-SVID shape, Relay SVID attach, OCSF export | Production TLS, network tunnels, KMS/HSM adapter internals, live SIEM export | Consumer Pacts for CA, Relay authorizer, policy gate, OCSF collector |

## Explicit Non-Integration

The following are dependencies or future integrations, not accepted implementation scope here:

- SDK authoring surfaces for `auth()` and `connector()` beyond runtime contract consumption.
- Provider adapter implementation, Registry publication, and provider-side Pact verification.
- Policy engine internals, deny-ceiling algebra implementation, and UI approval flows.
- Real Relay transport, data-plane connectivity tiers, DNS, service mesh, or TCP/TLS stacks.
- Production OAuth/JWKS/KMS/HSM/SCIM/SIEM services.

## Reference Implementation Acceptance

Each accepted POC must appear in one ledger row, one BDD slice, and at least one service boundary or documented local invariant. Every boundary must have a Pact fixture or a documented mocked-provider-unavailable rationale. The simulation must run without live external services and must demonstrate at least one fail-closed path for each major slice.
