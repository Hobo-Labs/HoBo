# HOBO-115 CLI Shell Proof

HOBO-115 is proven by the focused POC at
[`src/draft/technical-proofs/hobo-cli-shell-contract`](../../../../src/draft/technical-proofs/hobo-cli-shell-contract/README.md).

## Acceptance Evidence

- Golden help test pins the canonical verb list and global flags from
  [`cli-spec.md`](../../cli-spec.md).
- JSON envelope test proves `hobo plan --json` returns structured stub output with no human text
  interleaved on stdout.
- Context injection test proves command context is built once and delivered to the registry
  dispatch path.
- Negative tests cover typo suggestions, unknown flags, no-Bindle project detection, and
  `--to` plus `--rollback` parse-time rejection.

## Scope Boundary

This branch intentionally stops at the shell contract. Real command behavior, auth identity
resolution, MCP transport, runtime clients, and provider-backed planning remain owned by later
CLI/MCP/runtime slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-cli-shell-contract test
```
