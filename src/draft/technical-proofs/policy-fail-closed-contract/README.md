# Policy Fail-Closed Contract

Independent POC for HOBO-215.

This package proves the Plan 29 / ADR-0015 / ADR-0023 / ADR-0074 requirement
that policy-plane degradation never becomes an allow:

- an unreachable policy evaluator returns a deny decision with fail-closed
  evidence;
- invalid rulesets fail closed instead of compiling to an empty allow set;
- throwing rules deny and are not skipped as pass;
- missing or errored Gatekeeper inputs block `hobo verify`;
- guardrail and contract step errors block rather than warn;
- evaluator-path chaos faults never emit `allow`;
- stale cached allows past the revocation bound deny rather than serving a
  degraded allow.

Scope intentionally stops before implementing the policy engine, Gatekeeper,
chaos tier, or full decision-cache hardening. This package faults those seams
and records the contract behavior they must preserve.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\policy-fail-closed-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Policy Fail Closed Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
