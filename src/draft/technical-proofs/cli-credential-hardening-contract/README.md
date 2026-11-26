# CLI Credential Hardening Contract POC

HOBO-184 proof for CLI/MCP credential abuse resistance around the keyless SVID and brokered-token
path.

## What This Proves

- `hobo login` stores an SVID only through an OS secret-store reference, never a plaintext credential
  file or shell-history-visible argv value.
- Verbose output, crash dumps, structured `--json`, and child-process env capture are scrubbed of
  SVIDs, brokered provider tokens, authorization values, and credential-shaped fields.
- A revoked SVID stops a mutating command before side effects and records an auditable denial.
- Static cloud keys are rejected rather than accepted as a fallback, and `hobo doctor` reports the
  insecure state.
- CI dry-run uses OIDC and brokered short-lived tokens while persisting zero long-lived secrets.

## Adversarial Coverage

- A malicious JSON consumer cannot coax raw token material into structured output.
- Stale plaintext credentials from an older CLI state are denied rather than trusted.
- Concurrent commands share the same secret-store reference without duplicating raw credentials or
  leaking values.
- An attacker-controlled `HOBO_ISSUER_URL` cannot redirect auth to a rogue issuer.

## Boundary

This is a local contract POC. It does not implement the Identity issuer, token broker, MCP prompt
injection defense, provider-side IAM, or production OS-keychain integrations. Those remain owned by
their dedicated slices; this package proves the CLI credential-handling boundary that consumes them.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\cli-credential-hardening-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cli Credential Hardening Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
