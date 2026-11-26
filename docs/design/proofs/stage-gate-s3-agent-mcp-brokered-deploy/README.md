---
type: Reference
title: "HOBO-636 Stage Gate S3 Agent MCP Brokered Deploy Proof"
description: "Source issue: HOBO-636."
tags: [hobo, design, security, stage-gate]
---

# HOBO-636 Stage Gate S3 Proof

Executable evidence lives at
[`src/draft/epic-proofs/stage-gate-s3-agent-mcp-brokered-deploy`](../../../../src/draft/epic-proofs/stage-gate-s3-agent-mcp-brokered-deploy/README.md).

## Acceptance Evidence

- J2 MCP journey: `list_templates → new → plan → request_token → deploy → inspect_run/tail_logs` against `examples/hello-bindle` on S2 sandbox (mocked).
- Brokered short-lived tokens only; static secrets rejected and absent from successful trace.
- `token.Granted` and `token.Used` events with replayable event-store digest.
- NFR-017 machine-readable `explainFailure` drives verify → redeploy self-correction.
- High-risk prod deploy blocks on `require-approval` until human approves.
- `request_token` outside `.allow()` ceiling refused (`MCP_SCOPE_DENIED`).

## Verification

```bash
pnpm --prefix src/draft/epic-proofs/stage-gate-s3-agent-mcp-brokered-deploy test
```

## Scope Boundary

Production `packages/mcp/`, live S2 cloud, and credentialed CI lane attachment to S3-01 remain out of scope for this draft POC.

Architecture guard evidence (parse-don't-validate, event store, CredentialAudit projection) is documented in the package [`architecture.md`](../../../../src/draft/epic-proofs/stage-gate-s3-agent-mcp-brokered-deploy/architecture.md).
