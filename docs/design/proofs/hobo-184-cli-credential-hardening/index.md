# HOBO-184 CLI Credential Hardening Proof

HOBO-184 is proven by the focused POC at
[`src/draft/technical-proofs/cli-credential-hardening-contract`](../../../../src/draft/technical-proofs/cli-credential-hardening-contract/README.md).

## Acceptance Evidence

- The SVID-storage test proves `hobo login` keeps the credential behind an OS secret-store reference
  and does not expose it through plaintext files or shell-history-visible argv.
- The redaction test proves verbose logs, crash dumps, child-process env output, and structured JSON
  redact brokered provider tokens, JWT-SVIDs, and credential-shaped fields.
- The revocation test proves a revoked SVID denies a mutating command before side effects and emits
  `token.Revoked` plus `token.Denied`.
- The static-key test proves static cloud keys are rejected and surfaced through `hobo doctor`.
- The CI dry-run test proves OIDC/brokered-token use leaves zero persisted secrets and records
  `token.Granted`, `token.Used`, and `token.Revoked`.

## Adversarial Evidence

- Structured JSON output is recursively scrubbed so malicious consumers cannot request raw tokens.
- Stale plaintext credential files fail closed.
- Concurrent command execution is serialized through one secret-store reference and does not
  duplicate or leak raw credentials.
- Rogue `HOBO_*` issuer redirection fails closed against the configured trust root.

## Scope Boundary

The POC consumes Identity, token-broker, MCP auth, and provider IAM as seams. It does not build those
internals, and it does not address MCP prompt-injection hardening, which remains a separate issue.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\cli-credential-hardening-contract test
```
