---
type: Runbook
title: "HoBo.CD runbook: Freight ingest"
description: "OIDC trusted publishing and attestation pushes. Assembled from the Runbook section of packages/cd/src/ingest/README.md."
tags: [hobo, cd, runbook, ingest]
---

# HoBo.CD runbook: Freight ingest

OIDC trusted publishing and attestation pushes. This page is assembled from the **Runbook** section of `packages/cd/src/ingest/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Meaning | Action |
|---|---|---|
| `publisher-issuer-unconfigured` | No publisher trusts the token's `iss`. | Trust a publisher for that issuer, or check that the CI is minting tokens for the right issuer (for example, GitHub Enterprise Server issuers differ). |
| `publisher-audience-mismatch` | The token was minted for another audience. | Request the token with the publisher's `audience` (GitHub: `core.getIDToken(aud)`; GitLab: `id_tokens.<name>.aud`). |
| `publisher-claims-mismatch` | A required claim is missing or differs. The message names the claim. | Publish from the configured repository, workflow and environment. If the pipeline moved, trust an updated record. |
| `publisher-token-expired` | The token is outside `nbf`/`exp` plus skew. | Mint the token immediately before the push. Check clock sync on the CD service. |
| `publisher-token-invalid` | The token is malformed, not RS256, has no `nbf`, or the signature failed. | Send the CI token unchanged. A signature failure that persists after a JWKS refetch means the token was not minted by that issuer. |
| `publisher-discovery-failed` | Discovery or the JWKS is unreachable or inconsistent. | Check egress to the issuer. Fail-closed by design: no cached fallback is used past its `max-age`. |
| `publisher-bindle-scope` | The publisher is not trusted for this Bindle. | Add the Bindle to its record (a governed `publisher.trust`). |
| `attestation-declaration-missing` | No `hobo.cd/declaration-hash` external parameter. | Add it to the build's external parameters, or push a manifest instead. |
| `provenance-unverified` | The verifier refused, or its result left a subject uncovered or unverified. | Re-sign the exact statement with a trusted builder and signer. Check the source subscriptions' trusted builder and signer pins. |
| `unverified-trigger` on a CDEvent | The carried attestation did not verify. The polls in the message were still scheduled. | Nothing is lost: the poll reads the source. Fix the attestation if push creation is wanted. |
| `ingest-journal-conflict` on `trust` | Another trust change for that publisher landed first. | Re-read the publisher (`readTrustedPublishers`) and retry if the change is still wanted. |
| `cdevent-unsupported` | Not an artifact event. | Send other CDEvents to the outbound boundary, not to Freight ingest. |
