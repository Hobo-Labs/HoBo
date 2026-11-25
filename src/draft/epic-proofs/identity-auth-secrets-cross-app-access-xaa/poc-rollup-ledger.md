# POC Rollup Ledger

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| JWT-SVID token format and trust domain | `src/draft/technical-proofs/hobo-jwt-svid-contract` | HOBO-44 | Platform engineer | Issue workload SVID with Yard SPIFFE subject | Workload credential ladder | JWKSIdentityProvider, IdentityCertificateAuthority | auth-jwks-issuer, identity-ca-mtls | verified | implemented_in_reference_impl | Structural claims become the shared SVID subject model. |
| Provider auth.json flow schema | `src/draft/technical-proofs/hobo-auth-json-contract` | HOBO-48 | Platform engineer | Select keyless flow before static secret fallback | Workload credential ladder | CapabilityManifestRegistry, ProviderSTS | capability-manifest-registry, provider-sts | verified | implemented_in_reference_impl | Signed manifest envelope is consumed by the broker fixture. |
| ID-JAG token-exchange wire contract | `src/draft/technical-proofs/id-jag-token-exchange-contract` | HOBO-54 | SecOps reviewer | Mint and redeem an audience-bound ID-JAG | Cross-App Access delegation | ExternalAppAuthorizationServer | external-app-authorization-server | verified | implemented_in_reference_impl | Wire shape is kept; real OAuth server calls remain mocked. |
| Unified PrincipalRef and RBAC subject | `src/draft/technical-proofs/hobo-principal-ref-contract` | HOBO-56 | App developer | Serialize one subject shape for policy and events | App-user auth and secretless config | EnterprisePolicyGate, SessionStoreProjection | xaa-policy-gate, session-projection-store | verified | implemented_in_reference_impl | User, agent, and service principals share one audit/policy model. |
| hobo:auth consumer contract and dev fixture | `src/draft/technical-proofs/hobo-auth-consumer-contract` | HOBO-63 | App developer | Dev principal satisfies same contract as production auth | App-user auth and secretless config | JWKSIdentityProvider | auth-jwks-issuer | verified | implemented_in_reference_impl | Dev/prod equivalence is preserved; authz remains deny-by-default. |
| Identity event family and CredentialAudit | `src/draft/technical-proofs/identity-event-contract` | HOBO-66 | SecOps reviewer | Credential chain is replayable from retained events | App-user auth and secretless config | SessionStoreProjection, OCSFCollector | session-projection-store, ocsf-siem-export | verified | implemented_in_reference_impl | Events carry references, never raw token or secret material. |
| Yard Identity issuer and JWKS | `src/draft/technical-proofs/yard-identity-issuer-contract` | HOBO-71 | Yard operator | Stable genesis issuer serves discovery and JWKS | Identity governance and observation | JWKSIdentityProvider, IdentityCertificateAuthority | auth-jwks-issuer, identity-ca-mtls | verified | implemented_in_reference_impl | KMS seam is mocked; issuer stability is retained. |
| Workload attestation intake | `src/draft/technical-proofs/workload-attestation-intake-contract` | HOBO-77 | Platform engineer | Host measurement binds run, tenant, and code version | Workload credential ladder | WorkloadAttestationVerifier | identity-attestation-verifier | verified | implemented_in_reference_impl | Caller-supplied tenant claims are discarded. |
| Token broker skeleton | `src/draft/technical-proofs/token-broker-skeleton-contract` | HOBO-84 | Platform engineer | ctx.token routes through one audited broker seam | Workload credential ladder | CapabilityManifestRegistry, ProviderSTS, BrokerCredentialCache | capability-manifest-registry, provider-sts, broker-ha-cache | verified | implemented_in_reference_impl | Broker remains the sole credential path. |
| JWT-SVID issuance | `src/draft/technical-proofs/jwt-svid-issuance-contract` | HOBO-90 | Platform engineer | Attested workload receives least-privilege SVID | Workload credential ladder | WorkloadAttestationVerifier, JWKSIdentityProvider | identity-attestation-verifier, auth-jwks-issuer | verified | implemented_in_reference_impl | Scope clamp is represented in the reference service. |
| SVID auto-rotation | `src/draft/technical-proofs/svid-auto-rotation-contract` | HOBO-99 | Platform engineer | Long-running run rotates before expiry | Workload credential ladder | JWKSIdentityProvider, BrokerCredentialCache | auth-jwks-issuer, broker-ha-cache | verified | implemented_in_reference_impl | Rotation emits `identity.Rotated` without raw token output. |
| OIDC federation to provider STS | `src/draft/technical-proofs/oidc-federation-sts-contract` | HOBO-110 | Platform engineer | Exchange SVID-bound assertion for provider token | Workload credential ladder | ProviderSTS, CapabilityManifestRegistry | provider-sts, capability-manifest-registry | verified | implemented_in_reference_impl | Provider token is narrowed and TTL-bounded. |
| Secretless config resolution ladder | `src/draft/technical-proofs/secretless-config-resolution-contract` | HOBO-222 | App developer | Resolve secret refs without plaintext persistence | App-user auth and secretless config | SecretProviderPort, ProviderSTS | secret-provider-port, provider-sts | verified | implemented_in_reference_impl | Static fallback routes to denied bounded hatch case. |
| hobo:auth federate/verify runtime | `src/draft/technical-proofs/hobo-auth-federate-verify-contract` | HOBO-226 | App developer | Verify JWT to `ctx.user` and `ctx.tenant` | App-user auth and secretless config | JWKSIdentityProvider, SessionStoreProjection | auth-jwks-issuer, session-projection-store | verified | implemented_in_reference_impl | Wrong issuer/audience/alg and missing tenancy fail closed. |
| Session revocation | `src/draft/technical-proofs/session-revocation-contract` | HOBO-229 | App developer | Revoked session denies next request | App-user auth and secretless config | SessionStoreProjection | session-projection-store | verified | implemented_in_reference_impl | Revocation remains append-only event replay. |
| Outbound XAA token exchange | `src/draft/technical-proofs/outbound-xaa-token-exchange-contract` | HOBO-230 | SecOps reviewer | Broker mints ID-JAG only for verified user delegation | Cross-App Access delegation | EnterprisePolicyGate, ExternalAppAuthorizationServer | xaa-policy-gate, external-app-authorization-server | verified | implemented_in_reference_impl | Pre-mint policy happens before target AS redemption. |
| Inbound XAA resource server | `src/draft/technical-proofs/inbound-xaa-resource-server-contract` | HOBO-233 | SecOps reviewer | HoBo app verifies inbound ID-JAG and stamps ctx.user | Cross-App Access delegation | JWKSIdentityProvider, EnterprisePolicyGate | auth-jwks-issuer, xaa-policy-gate | verified | implemented_in_reference_impl | Wrong audience/resource/replay paths are negative scenarios. |
| connector runtime broker backing | `src/draft/technical-proofs/connector-runtime-broker-contract` | HOBO-235 | App developer | connector connection token request is bounded by inferred scope | Cross-App Access delegation | EnterprisePolicyGate, ExternalAppAuthorizationServer | xaa-policy-gate, external-app-authorization-server | verified | implemented_in_reference_impl | SDK authoring remains dependency; runtime backing is modeled; latest technical-proof change reconciled without changing the simulation. |
| RBAC roles via SSO/SCIM through auth port | `src/draft/technical-proofs/auth-port-rbac-resolution-contract` | HOBO-238 | SecOps reviewer | SCIM roles resolve without agent self-widening | App-user auth and secretless config | JWKSIdentityProvider, EnterprisePolicyGate | auth-jwks-issuer, xaa-policy-gate | verified | implemented_in_reference_impl | SCIM source is mocked; subject role caps are kept. |
| X.509-SVID mTLS certificate issuance | `src/draft/technical-proofs/x509-svid-mtls-contract` | HOBO-242 | Yard operator | Service-to-service mTLS authenticates by SVID | Identity governance and observation | IdentityCertificateAuthority | identity-ca-mtls | verified | implemented_in_reference_impl | Certificate-shaped records prove the contract, not a TLS stack. |
| HoBo Relay SVID-auth reverse tunnel | `src/draft/technical-proofs/hobo-relay-contract` | HOBO-244 | Yard operator | Relay attach accepts only SVID-authorized target scope | Identity governance and observation | RelaySvidAuthorizer, IdentityCertificateAuthority | relay-svid-authorizer, identity-ca-mtls | verified | implemented_in_reference_impl | Transport stays mocked; identity attach decision is integrated. |
| Cross-tenant SVID issuance guard | `src/draft/exp-proofs/dx/svid-cross-tenant-guard-contract` | HOBO-247 | Security reviewer | Forked workload cannot mint another tenant's token | Workload credential ladder | WorkloadAttestationVerifier, JWKSIdentityProvider | identity-attestation-verifier, auth-jwks-issuer | verified | implemented_in_reference_impl | Attestation binding outranks caller claims. |
| XAA confused-deputy guard | `src/draft/technical-proofs/xaa-confused-deputy-guard-contract` | HOBO-250 | SecOps reviewer | Agent cannot mint for another user or target | Cross-App Access delegation | EnterprisePolicyGate, ExternalAppAuthorizationServer | xaa-policy-gate, external-app-authorization-server | verified | implemented_in_reference_impl | Verified delegation is derived, not caller supplied. |
| Token replay resistance | `src/draft/technical-proofs/token-replay-resistance-contract` | HOBO-255 | Security reviewer | Replayed SVID, ID-JAG, and access tokens fail closed | Cross-App Access delegation | ExternalAppAuthorizationServer, SessionStoreProjection, ProviderSTS | external-app-authorization-server, session-projection-store, provider-sts | verified | implemented_in_reference_impl | Nonce, audience, expiry, and rotation rollover are asserted. |
| Secret-zero genesis bootstrap | `src/draft/technical-proofs/secret-zero-genesis-bootstrap-contract` | HOBO-262 | Yard operator | Durable identity root never leaves target custody | Identity governance and observation | JWKSIdentityProvider, IdentityCertificateAuthority | auth-jwks-issuer, identity-ca-mtls | verified | implemented_in_reference_impl | KMS custody is represented as event evidence only. |
| SVID partition grace spike | `src/draft/technical-proofs/svid-partition-grace-spike` | HOBO-266 | Yard operator | Renewal grace is bounded and signed | Workload credential ladder | BrokerCredentialCache | broker-ha-cache | verified | implemented_in_reference_impl | Grace cannot widen scope or extend past notAfter. |
| ID-JAG threat model spike | `src/draft/technical-proofs/id-jag-threat-model-spike` | HOBO-271 | SecOps reviewer | Draft version and threat vectors stay explicit | Cross-App Access delegation | ExternalAppAuthorizationServer, EnterprisePolicyGate | external-app-authorization-server, xaa-policy-gate | verified | implemented_in_reference_impl | Used as adversarial test taxonomy. |
| Static-key escape hatch hardening | `src/draft/technical-proofs/static-key-escape-hatch-contract` | HOBO-275 | SecOps reviewer | Expired static key fallback fails closed | Workload credential ladder | SecretProviderPort, OCSFCollector | secret-provider-port, ocsf-siem-export | verified | implemented_in_reference_impl | Fallback is modeled as denied once TTL/rotation expire. |
| Genesis Org-Admin and break-glass | `src/draft/technical-proofs/genesis-breakglass-contract` | HOBO-279 | Yard operator | Offline recovery requires emergency context and audit | Identity governance and observation | EnterprisePolicyGate, OCSFCollector | xaa-policy-gate, ocsf-siem-export | verified | implemented_in_reference_impl | No normal token can self-grant break-glass. |
| Identity OCSF audit export | `src/draft/technical-proofs/identity-ocsf-export-contract` | HOBO-282 | SecOps reviewer | Identity/token/session facts export as linked OCSF records | Identity governance and observation | OCSFCollector | ocsf-siem-export | verified | implemented_in_reference_impl | Export is one-way and redacted. |
| Token broker HA credential cache | `src/draft/technical-proofs/token-broker-ha-cache-contract` | HOBO-287 | Yard operator | Broker failover renews same-or-narrower credentials inside grace | Workload credential ladder | BrokerCredentialCache, ProviderSTS | broker-ha-cache, provider-sts | verified | implemented_in_reference_impl | Cache never bypasses revocation or scope widening checks. |

## Cascade absorptions

Changes to referenced experience proofs that this rollup has taken in.

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/exp-proofs/dx/svid-cross-tenant-guard-contract` | `data-models/proof.cue` | none |
| `src/draft/technical-proofs/hobo-auth-json-contract` | latest validated leaf hardening | Signed manifest and broker fixture behavior unchanged. |
| `src/draft/technical-proofs/hobo-jwt-svid-contract` | latest validated leaf hardening | Workload SVID trust and claim behavior unchanged. |
| `src/draft/technical-proofs/hobo-principal-ref-contract` | latest validated leaf hardening | Principal serialization and policy subject behavior unchanged. |

All of these are the same edit, applied across 58 draft proofs at once. Each
ships a `data-models/proof.proto` declaring `message ProofIdentity { string
slug = 1; string layer = 2; }` beside a `proof.cue` that defined a bare
anonymous `slug`/`layer` record — a record with no name to tie it to the
message it is supposed to constrain, which is what `architecture:guard`
reports as `missing-cue-constraints`. The record is now the named definition
`#ProofIdentity`, embedded at top level so the file still reads as the same
concrete data.

One constraint changed with it: `slug: string` became `slug: string & !=""`.
The old form restated proto3's declared type and refused nothing, so a proof
identifying itself with the empty string validated. Measured with cue v0.14.0,
old against new: `slug: ""` goes 0 → 1 and nothing else moves — a well-formed
record stays 0, `slug: 7` stays 1, `layer: "ux"` stays 1.

No disposition, evidence path, Linear link, or acceptance claim in the table
above moves. No proof in this epic identifies itself with an empty slug, so
nothing that validated before stops validating.

## Adversarial Scope Review

| Review area | Decision |
|---|---|
| Requirement proven | The POCs jointly prove HoBo's credential plane: attested workload identity, end-user auth, secretless config, XAA delegation, bounded availability, recovery, and audit export. |
| Persona/user goal | Platform engineers get keyless deployment credentials, app developers get contract-equivalent auth/config, SecOps gets XAA governance, and Yard operators get bounded recovery and observability. |
| BDD mapping | Accepted POCs map to the four BDD slices in `README.md`; no accepted POC stands alone without a slice. |
| Boundary map | Every external or internal dependency is a named mocked provider with a Pact decision in `contracts/pact-inventory.md`. |
| Useful implementation kept | Deterministic fail-closed ordering, reference-only token refs, attestation-derived tenants, signed renewal grace, inferred XAA scope ceiling, and redacted audit export. |
| Accidental or unsafe details discarded | Live OAuth, KMS/HSM, JWKS, SCIM, TLS, Relay, SIEM, secret-store, provider, and policy-engine calls are excluded. |
| Invalidated assumptions | Linear child POCs are already completed individually, but the epic still needed one synthesized reference path showing how they compose. |
| Edge and abuse cases | Forged workload tenant, wrong issuer, revoked session, confused deputy, token replay, stale static key, relay cross-tenant attach, and plaintext leakage all stay explicit. |
| Conflicts with docs/ADRs | No conflicts found; the rollup follows Plan 06 and ADR identity/security guidance, while keeping Plan 12 Relay/network transport out of production scope. |
| Superseded/deferred/split | SDK authoring, provider adapter implementation, real policy engine, real Relay transport, service mesh, and provider-side Pact verification are deferred outside this PR. |
| Feature drift risk | Blindly copying POC internals would make the reference look production-ready; the rollup keeps behavior and contracts only. |
| Simulation risk | The harness must report mocked providers and empty live network calls so it cannot be mistaken for a deployed identity service. |
| Contract brittleness risk | Pact fixtures focus on boundary request/response compatibility and avoid asserting entire business workflows. |
| Active epic conflict | The reference path is unique to Identity/XAA and does not modify other epic reference directories. |

| `src/draft/technical-proofs/outbound-xaa-token-exchange-contract` | latest validated leaf hardening | Outbound XAA exchange and trust evidence unchanged. |

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/secretless-config-resolution-contract` | final validated leaf hardening | Secretless resolution evidence unchanged. |
| `src/draft/technical-proofs/static-key-escape-hatch-contract` | final validated leaf hardening | Static escape-hatch boundary evidence unchanged. |
| `src/draft/technical-proofs/svid-auto-rotation-contract` | final validated leaf hardening | SVID rotation evidence unchanged. |
| `src/draft/technical-proofs/svid-partition-grace-spike` | final validated leaf hardening | Partition-grace evidence unchanged. |
| `src/draft/technical-proofs/token-broker-ha-cache-contract` | final validated leaf hardening | Broker cache evidence unchanged. |
| `src/draft/technical-proofs/token-broker-skeleton-contract` | final validated leaf hardening | Broker skeleton evidence unchanged. |
| `src/draft/technical-proofs/token-replay-resistance-contract` | final validated leaf hardening | Replay-resistance evidence unchanged. |
| `src/draft/technical-proofs/workload-attestation-intake-contract` | final validated leaf hardening | Workload-attestation evidence unchanged. |
