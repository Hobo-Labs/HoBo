# HOBO-183 Data Governance Policy Proof

This proof backs [PLAN-29](../../contracts-policy-flags.md#plan-29),
[PLAN-46](../../governance-planes.md#plan-46), and
[ADR-0060](../../adr/02-identity-security.md#adr-0060).

The branch adds
[`src/draft/technical-proofs/data-governance-policy-contract`](../../../../src/draft/technical-proofs/data-governance-policy-contract/README.md),
an independent POC for consuming `data.Classified` facts into policy context and
enforcing residency, retention, runtime-boundary, and subprocessor obligations at
can-deploy and runtime. It emits policy IR decisions and auditable
`policy.Decided`/`dataGovernance.*` facts without implementing classification
discovery, Matching, erasure, OCSF export assembly, or the full obligation
engine.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| PHI in non-permitted region rejected at can-deploy | `can-deploy rejects phi placement outside a permitted residency region` |
| Permitted Camp passes with auditable evidence | `permitted Camp placement passes and records replayable policy evidence` |
| Runtime export crossing boundary denied or region-pinned | `runtime export crossing a boundary is region-pinned when a compliant channel exists` |
| Retention window has floor and ceiling | `retention policy is enforced as a floor and a ceiling over compaction` |
| Unregistered subprocessor fails the gate | `unregistered subprocessors fail the gate instead of being allowed with a log` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Public-declared PII must not bypass residency | `public-declared PII coverage finding fails residency closed` |
| Non-compliant runtime endpoint must fail, not warn | `runtime action to a non-compliant endpoint fails obligation instead of warning` |
| Unregistered subprocessor denied, not allowed-with-log | `unregistered subprocessors fail the gate instead of being allowed with a log` |
| Retention cannot delete early or retain too long | `retention policy is enforced as a floor and a ceiling over compaction` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\data-governance-policy-contract test
npm.cmd test
```
