# Project MVP registry

Project MVP rollups live under `src/draft/projects/<slug>`.

| Slug | Linear | Status | Notes |
|---|---|---|---|
| `s0-03-hobo-core` | HOBO-580 | promoted | Production `@hobo/core` in `packages/core/`; draft POC retained for traceability |
| `s1-23-hobo-build` | HOBO-613 | draft POC | `hobo build` orchestration; promotes to `packages/cli` when S0-07/S1-20 merge |
| `s1-24-conformance-sdk` | HOBO-614 | draft POC | SDK idiom-layer parity gate; promotion target `packages/conformance/src/sdk/` |
| `s2-08-provider-cloudflare` | HOBO-623 | draft POC | Cloudflare provider + Capability Manifest; promotes HOBO-165 contract proof |
| `s3-02-hobo-identity` | HOBO-628 | draft | SVID issuance, attestation, rotation, OIDC provider POC; promotes to `packages/identity/` after S3-01 |
| `s6-06-finops-plane` | HOBO-661 | draft POC | Plan estimates, budget gates, showback; promotes finops epic proofs |
| `otel-office` | — | draft POC | OTel observability as a pixel office; bindles as NPCs driven by spans/metrics/logs; Phase 2 slice 1 — interpolated renderer, click-to-inspect panel, junction trace packets |

Each project entry must list:

- Project slug and owning design plan or Linear issue.
- Epic proofs integrated.
- Technical and experience proof changes propagated downward.
- ADRs created for integration-driven changes.
- Project-level validation commands and evidence paths.
