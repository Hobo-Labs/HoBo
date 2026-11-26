# Identity, Auth, Secrets & Cross-App Access (XAA)

This epic reference implementation rolls the Identity/Auth/XAA child POCs into one deterministic reference architecture slice. It is not production code: providers, IdPs, STS services, policy gates, SIEM export, and service mesh edges are mocked so the architecture can run locally without credentials or live network calls.

Reference service: `services/identity-reference-architecture.ts`

Simulation command:

```bash
npm.cmd --prefix src\draft\epic-proofs\identity-auth-secrets-cross-app-access-xaa run simulate
```

Test command:

```bash
npm.cmd --prefix src\draft\epic-proofs\identity-auth-secrets-cross-app-access-xaa test
```

## Persona And BDD

```gherkin
Feature: Issue and broker keyless workload credentials

  Persona: Platform engineer deploying an attested workload

  Scenario: Exchange an attested workload SVID for a provider token
    Given a host-signed workload attestation, a signed provider auth.json, and least-privilege scope
    When Identity issues a JWT-SVID and the broker exchanges it through OIDC federation
    Then the provider token is short-lived, narrowed to the requested action, audited, and renewable only inside signed grace
```

```gherkin
Feature: Verify end-user auth and resolve secretless configuration

  Persona: App developer using hobo:auth and ctx.config

  Scenario: Verify ctx.user and read a secret reference without storing plaintext
    Given a hobo:auth consumer contract, trusted JWKS, session events, and Camp config references
    When a request verifies a token and resolves config through the secretless ladder
    Then ctx.user, ctx.tenant, roles, and secret references are enforced without plaintext persistence
```

```gherkin
Feature: Delegate Cross-App Access through governed ID-JAG exchange

  Persona: SecOps reviewer governing an agent acting for a user

  Scenario: Mint outbound and verify inbound XAA credentials
    Given a verified delegated user, inferred connector scope, a target auth.json, and deny-by-default policy
    When the XAA broker mints an audience-bound ID-JAG and the target redeems it
    Then only the delegated user-to-agent-to-app chain is authorized, replay-resistant, and audit-exportable
```

```gherkin
Feature: Recover and observe identity control planes

  Persona: Yard operator maintaining identity availability

  Scenario: Keep identity available without widening trust
    Given a genesis issuer, offline break-glass key, broker HA cache, mTLS SVID certificates, and OCSF exporter
    When the issuer rotates, the broker fails over, or policy recovery is required
    Then continuity is bounded by signed leases, every override is audited, and SIEM receives redacted OCSF evidence
```

## Vertical Slices

| Slice | Implemented behavior | Main POCs |
|---|---|---|
| Workload credential ladder | Attestation intake, JWT-SVID issue/rotation, auth.json flow selection, OIDC federation, broker HA renewal grace, static-key last-resort denial | HOBO-44, HOBO-48, HOBO-71, HOBO-77, HOBO-84, HOBO-90, HOBO-99, HOBO-110, HOBO-247, HOBO-266, HOBO-275, HOBO-287 |
| App-user auth and secretless config | hobo:auth consumer contract, JWKS verification, PrincipalRef/RBAC, session revocation, secretless config resolution, identity event projection | HOBO-56, HOBO-63, HOBO-66, HOBO-222, HOBO-226, HOBO-229, HOBO-238 |
| Cross-App Access delegation | ID-JAG wire contract, outbound broker, inbound resource server, runtime connector token bridge, scope inference, confused-deputy and replay guards | HOBO-54, HOBO-230, HOBO-233, HOBO-235, HOBO-250, HOBO-255, HOBO-271 |
| Identity governance and observation | Secret-zero genesis, Yard issuer/JWKS, genesis admin and break-glass, X.509 SVID mTLS, Relay SVID attach, OCSF export | HOBO-71, HOBO-242, HOBO-244, HOBO-262, HOBO-279, HOBO-282 |

## What Is Real

- The reference service executes deterministic versions of the accepted Identity/XAA scenarios.
- Every modeled boundary has a Pact decision and mocked provider fixture.
- The tests assert positive paths and fail-closed adversarial cases: forged workload, wrong issuer, revoked session, confused-deputy delegation, replay, expired static key, and plaintext leakage.
- Auth JSON, JWT-SVID, and PrincipalRef changes are absorbed without changing credential ordering, trust, or audit behavior.

Outbound XAA token-exchange changes are absorbed without changing credential ordering, trust, or audit behavior.

## What Is Mocked

- Host attestation verifier, provider manifest registry, provider STS, JWKS issuer, session projection, secret provider, policy gate, external app authorization server, SVID CA, Relay authorizer, broker HA cache, and OCSF collector.
- Provider-side Pact verification is documented as unavailable because the real providers are not in this reference package.

No live external service, network call, credential, customer data, or production token is required.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Identity Auth Secrets Cross App Access Xaa.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The secretless-config, static-key, SVID, token-broker, token-replay, and workload-attestation technical proof refreshes are absorbed without changing identity or secretless resolution behavior.
