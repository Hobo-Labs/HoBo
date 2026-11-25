# SecOps Policy Audit Journey Contract POC

HOBO-213 proof for the SecOps `hobo up --camp prod` loop:
mandatory policy-pack deny-ceiling -> replayable denial -> separated-duty,
time-boxed waiver -> brokered credential audit.

## What This Proves

- A non-compliant `hobo up --camp prod` is denied by a mandatory deny-ceiling,
  prints a replayable `policy.Decided`, and provisions zero resources.
- A separated-duty waiver permits the blocked deploy only inside its TTL and
  records `policy.WaiverApproved` plus `policy.WaiverExpired`.
- The allowed deploy emits `token.Granted -> token.Used -> token.Revoked`, and
  the shared `CredentialAudit` fold reconstructs the run.
- `.allow()` can narrow requested scopes, but an attempted lower-scope widen
  past the mandatory ceiling fails closed.
- The MCP `deploy` path is gated by the same policy decision and credential
  audit as the CLI path.

## Boundary

This package composes existing draft contracts for `hobo up`, policy audit
events, deny-ceiling behavior, MCP parity, and identity audit events. It does
not implement the production policy engine, waiver model, XAA internals,
`.allow()` inference engine, OCSF export pipeline, or static-secret broker.

`policy.WaiverExpired` is asserted here because the SecOps walkthrough and
HOBO-213 require the event bracketing; this package does not widen the older
policy-audit export POC.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\secops-policy-audit-journey-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Secops Policy Audit Journey Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
