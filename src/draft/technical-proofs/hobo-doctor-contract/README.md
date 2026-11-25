# HOBO-147 Doctor Contract

Independent POC for `hobo doctor`. It pins the diagnostics contract without
building the production CLI, provider IAM checks, Gatekeeper `verify`, or
automatic repair.

## What It Proves

- Missing Node.js, `jco`, container runtime, or developer SVID reports a hard
  failure with a remediation command.
- Missing SVID points at `hobo login` without printing credential material.
- `.raw()` usage is flagged with stable file and line metadata.
- Healthy projects produce all-pass human output and a stable `--json` envelope.
- Degraded remote checks warn when partial service health should not fail the
  run.
- `--offline` skips Camp read API and Streamer reachability checks instead of
  failing them.
- Thrown check errors are reported as `check errored` without crashing or
  leaking stack traces.
- Credential tokens, bearer values, and key-value secrets are redacted.
- The doctor implementation can run through the HOBO-115 command registry.

## Scope Boundary

This package uses injectable seams for toolchain probes, credential storage,
and Camp connectivity. It does not invoke the real OS keychain, OIDC login,
Yard read API, Streamer endpoint, container runtime, or provider IAM APIs. It
also does not implement composite Gatekeeper `verify` or automated fixes.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-doctor-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Doctor Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
