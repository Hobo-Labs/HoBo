# Cross-Yard Policy Attestation Contract

Independent POC for HOBO-196. The contract models the detective assurance loop
from [PLAN-29](../../../../docs/design/contracts-policy-flags.md#plan-29),
[ADR-0043](../../../../docs/design/adr/07-portability-extensibility.md#adr-0043),
and [ADR-0074](../../../../docs/design/adr/02-identity-security.md#adr-0074):
each Yard ships signed policy decision logs plus a signed policy-engine build
attestation, then central reconciliation decides whether that Yard remains
inside the shared policy guarantee.

## Boundary

This package does not implement KMS, real remote attestation hardware, the OCSF
exporter, or rogue-Yard prevention. It proves only the branch-visible contract:
matching signed evidence is accepted, mismatched or forged evidence is detected,
missing logs raise an attestation gap, and `hobo doctor` can state whether a
Yard is inside the shared trust-root guarantee.

## Executable Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-yard-policy-attestation-contract test
```

The test suite covers:

- Signed decision logs and matching policy-engine attestation are accepted into
  the management-plane `policy.Decided` log.
- Forked policy-engine measurements raise `policy.AttestationMismatch`.
- Stale or missing decision logs raise `policy.AttestationGap`.
- Tampered attestations raise `policy.ForgedAttestation`.
- Yards outside the shared trust root are reported outside guarantee by doctor.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cross Yard Policy Attestation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
