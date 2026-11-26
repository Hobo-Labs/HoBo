# Identity/XAA Epic Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\identity-auth-secrets-cross-app-access-xaa run simulate
```

What this proves:

- An attested workload receives a scoped JWT-SVID and provider token while forged tenant claims fail closed.
- `hobo:auth` verifies `ctx.user`, enforces session revocation/RBAC, and resolves secretless config without plaintext leakage.
- Cross-App Access mints and verifies ID-JAG credentials only for the delegated user, inferred scope, and intended audience.
- Genesis, break-glass, mTLS SVID, Relay attach, broker renewal grace, and OCSF export stay bounded and audited.

Mocked boundaries:

- WorkloadAttestationVerifier: host measurement fixture.
- CapabilityManifestRegistry: signed `auth.json` fixture.
- ProviderSTS: provider token fixture.
- JWKSIdentityProvider: OIDC/JWKS fixture.
- SessionStoreProjection: append-only session event replay fixture.
- SecretProviderPort: secret reference fixture with redacted value.
- EnterprisePolicyGate: pre-mint and recovery decision fixture.
- ExternalAppAuthorizationServer: ID-JAG redemption fixture.
- IdentityCertificateAuthority: certificate-shaped X.509-SVID fixture.
- RelaySvidAuthorizer: SVID attach decision fixture.
- BrokerCredentialCache: signed renewal-grace fixture.
- OCSFCollector: redacted SIEM export fixture.

Contracts:

- `contracts/pacts/identity-attestation-verifier.pact.json`
- `contracts/pacts/capability-manifest-registry.pact.json`
- `contracts/pacts/provider-sts.pact.json`
- `contracts/pacts/auth-jwks-issuer.pact.json`
- `contracts/pacts/session-projection-store.pact.json`
- `contracts/pacts/secret-provider-port.pact.json`
- `contracts/pacts/xaa-policy-gate.pact.json`
- `contracts/pacts/external-app-authorization-server.pact.json`
- `contracts/pacts/identity-ca-mtls.pact.json`
- `contracts/pacts/relay-svid-authorizer.pact.json`
- `contracts/pacts/broker-ha-cache.pact.json`
- `contracts/pacts/ocsf-siem-export.pact.json`
