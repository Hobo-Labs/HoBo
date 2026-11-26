# HOBO-196 Cross-Yard Policy Attestation Proof

This proof backs [PLAN-29](../../contracts-policy-flags.md#plan-29),
[ADR-0043](../../adr/07-portability-extensibility.md#adr-0043), and
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

The branch adds
[`src/draft/technical-proofs/cross-yard-policy-attestation-contract`](../../../../src/draft/technical-proofs/cross-yard-policy-attestation-contract/README.md),
an independent POC for detective cross-Yard policy assurance. It models signed
per-Yard decision logs, signed policy-engine build measurements, central
reconciliation, and the doctor-facing guarantee projection without implementing
KMS, attestation primitives, OCSF export, or rogue-Yard prevention.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Yard ships signed decision logs + policy-engine build attestation | `acceptance: Yard ships signed decision logs and matching policy-engine build attestation` |
| Central reconciliation flags unexpected engine build | `acceptance: central reconciliation flags a Yard with a forked policy engine` |
| Dropped enforcement/log shipping is detected | `adversarial: Yard that stops shipping decision logs raises an attestation gap` |
| `hobo doctor` reports outside trust-root guarantee | `acceptance: hobo doctor reports a Yard outside the shared trust root as outside guarantee` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Rogue Yard forks policy-engine to fail open | `acceptance: central reconciliation flags a Yard with a forked policy engine` |
| Yard stops shipping decision logs | `adversarial: Yard that stops shipping decision logs raises an attestation gap` |
| Attacker forges matching attestation | `adversarial: attacker cannot forge matching attestation without the measured engine payload` |
| Yard outside trust root counted as enforcing | `acceptance: hobo doctor reports a Yard outside the shared trust root as outside guarantee` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-yard-policy-attestation-contract test
npm.cmd test
```
