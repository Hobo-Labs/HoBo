# V1 E2E Persona Matrix Contract

HOBO-500 defines the launch e2e persona matrix and pass/fail thresholds for v1 beta and GA
readiness.

## What This Proves

- The matrix covers app developer, platform engineer, admin, support/operator, security reviewer,
  and customer/buyer journeys.
- Every journey names environment, fixture data, mocked/live boundary, expected evidence, and
  pass/fail threshold.
- Flake handling routes repeated failures to quarantine, blocker candidates, or explicit follow-up
  decisions instead of silently passing.
- Manual evidence fallback requires reason, evidence link, and approver, and cannot override
  launch blockers.
- The scope boundary rejects a generic gate or full e2e harness implementation in this issue.

## Boundary

This package validates the M0 matrix record. It does not implement a browser test runner, full e2e
harness, live provider execution, device lab, or release decision.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\v1-e2e-persona-matrix-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for V1 E2e Persona Matrix Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
