---
type: Reference
title: "HOBO-622 Sandboxed Executors Proof"
description: "Source issue: HOBO-622 (S2-07)."
tags: [hobo, design]
---

# HOBO-622 Sandboxed Executors Proof

Executable draft POC backing [Plan 12](../../security-networking.md#plan-12) executor
isolation and NFR-007 undeclared-egress denial.

## Branch evidence

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/sandboxed-executors-contract
```

## Acceptance mapping

| Acceptance | Proof |
|---|---|
| Exec run streams `exec.Started` / `exec.Output` / `exec.Succeeded` to the log | `test/sandboxed-executors.test.ts` acceptance cases for iac-pulumi apply/preview and componentize build |
| Undeclared egress denied in sandbox (NFR-007) | `acceptance: undeclared egress attempt is denied in the sandbox` |
| Firecracker with container fallback | `selectSandboxBackend prefers firecracker and falls back to container` |
| Dev-mode scoped credential stub, no ambient credentials | `dev-mode credential stub is scoped and non-ambient` + revoke-after-run test |

## Adversarial coverage

- Undeclared egress to external URL → fatal `exec.Failed`, sandbox audit `denied`.
- Failure-path `exec.*` events validate against the control-plane schema.
- Container backend selected inside `executor.run` when Firecracker is unavailable.
- Declared egress to an allowed target completes; covert channel is audited, not denied.
- Credential always revoked after success and failure paths.

## Proof package

[`src/draft/technical-proofs/sandboxed-executors-contract`](../../../../src/draft/technical-proofs/sandboxed-executors-contract/README.md)
