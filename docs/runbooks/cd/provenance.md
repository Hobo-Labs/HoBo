---
type: Runbook
title: "HoBo.CD runbook: Provenance"
description: "in-toto/SLSA and Sigstore verification. Assembled from the Runbook section of packages/cd/src/provenance/README.md."
tags: [hobo, cd, runbook, provenance]
---

# HoBo.CD runbook: Provenance

in-toto/SLSA and Sigstore verification. This page is assembled from the **Runbook** section of `packages/cd/src/provenance/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Code | Action |
|---|---|---|
| Every Sigstore bundle refused after a Sigstore key rotation | `provenance-signature-invalid` | The configured `trustedRoot` predates the new keys. Refresh it (fetch the current `trusted_root.json` through TUF on an operator machine) and redeploy the policy; `"public-good-seed"` only advances with the `sigstore` dependency. |
| A release suddenly refused as untrusted signer | `provenance-signer-untrusted` | The workflow path or ref changed (for example a tag moved to a branch build). Confirm the change is legitimate, then update the subscription's signer pin. Never widen a pin to a pattern. |
| `provenance-issuer-untrusted` | — | The certificate came from an OIDC issuer not in `sigstore.issuers` (another CI). Add the issuer only if that CI is yours. |
| `provenance-statement-invalid` | — | The statement is not in-toto v1 + SLSA provenance v1 with sha256 subjects. npm-style sha512-only provenance cannot back Freight; attest the artifact files with `actions/attest-build-provenance` (sha256). |
| `provenance-subject-mismatch` | — | The attestation covers different artifacts than the Freight. Re-attest exactly the published artifacts. |
| `provenance-verifier-unconfigured` | — | Add the `sigstore` or `hoboJwt` section to the trust policy. |
| Service fails to start with `provenance-trust-policy-invalid` | — | The policy JSON is malformed; the error names the field. |
