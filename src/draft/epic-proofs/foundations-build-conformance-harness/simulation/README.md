# Foundations Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\foundations-build-conformance-harness run simulate
```

What this proves:

- Workspace skeleton, core, WIT, componentize, artifact trust, CI, and hardening slices compose without live services.
- Boundary failures are fail-closed for adapter imports, provider-specific core leakage, missing OIDC, and unsigned artifacts.

Mocked boundaries:

- GitHubActions: deterministic fixture contract from the CI fabric POC.
- OIDCTokenIssuer: in-memory token grant from the CI fabric POC.
- SandboxCloud: simulated `hello-bindle` deployment and teardown.
- ArtifactTrustBoundary: fixture Ed25519 key and trust policy; no production registry or Sigstore call.

Contracts:

- `contracts/pacts/workspace-skeleton-boundary.pact.json`
- `contracts/pacts/core-contract-boundary.pact.json`
- `contracts/pacts/wit-toolchain-boundary.pact.json`
- `contracts/pacts/componentize-build-boundary.pact.json`
- `contracts/pacts/ci-fabric-boundary.pact.json`
- `contracts/pacts/artifact-trust-boundary.pact.json`
- `contracts/pacts/hardening-traceability-boundary.pact.json`
