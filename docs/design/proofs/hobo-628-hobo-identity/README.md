---
type: Reference
title: "HOBO-628 S3-02 @hobo/identity Draft POC Proof"
description: "Source issue: HOBO-628."
tags: [hobo, design]
---

# HOBO-628 S3-02 @hobo/identity Draft POC Proof

Branch evidence for attested-workload JWT-SVID issuance, rotation, and OIDC provider surfaces.

## Branch Evidence

- Issue: HOBO-628
- Design refs: [Plan 06 — Agent identity](../../ai-native-agent-auth.md#plan-06), [ADR-0023](../../adr/02-identity-security.md#adr-0023)
- Draft package: [`src/draft/projects/s3-02-hobo-identity`](../../../../src/draft/projects/s3-02-hobo-identity/README.md)
- Promoted epic proof (by reference): [`identity-auth-secrets-cross-app-access-xaa`](../../../../src/draft/epic-proofs/identity-auth-secrets-cross-app-access-xaa/README.md)
- Focused gate: `pnpm --prefix src/draft/projects/s3-02-hobo-identity test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Workload attestation yields rotating JWT-SVID | `acceptance.test.ts` — attested issue + grace-window rotation with `identity.Issued` / `identity.Rotated` |
| Human/agent principals authenticate at Gateway with SVID | Gateway auth simulation verifies JWT via published JWKS |
| Identity conformance + PACT boundary | `contracts/identity-boundary.pact.json` + pact test in acceptance suite |
| Protobuf + CUE identity records | `data-models/identity.proto`, `data-models/identity.cue` |

## Adversarial Coverage

- Unattested / forged attestation denied without `identity.Issued`
- Tenant binding from measured launch when caller claims differ
- Scope widening during rotation denied
- Expired attestation measurements fail closed

## Maintenance

Docs-only proof record added alongside `src/draft/projects/s3-02-hobo-identity/` implementation for HOBO-628 draft POC scope.
