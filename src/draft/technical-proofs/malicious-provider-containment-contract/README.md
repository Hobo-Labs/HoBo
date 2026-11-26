# Malicious Provider Containment Contract

HOBO-221 proves the hostile third-party provider boundary from Plan 09, Plan 23,
ADR-0036, and ADR-0062 without implementing real Firecracker isolation,
signing infrastructure, registry yank lifecycle, or `generateProvider`.

The package models the certification/install/selection checks as named gates.
Each denied fixture emits an audit event and leaves `reachesInfraOutsideScope`
false.

## Coverage

- unsupported capability claims refuse certification;
- sandbox egress outside the scoped conformance target is denied and audited;
- unsigned or tampered packages are rejected before install;
- forged conformance attachments are rejected by in-boundary rerun;
- older signed vulnerable provider versions are blocked by anti-rollback;
- yanked provider versions are blocked from new selection;
- compromised signing keys are denied by offline revocation, not accepted by
  signature alone;
- covert-channel attempts inside the scoped target are audited and recorded as
  residual risk;
- successful conformance states honest limits instead of proving benign
  production behavior.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\malicious-provider-containment-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Malicious Provider Containment Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
