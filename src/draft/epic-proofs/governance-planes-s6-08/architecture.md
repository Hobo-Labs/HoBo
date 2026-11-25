# Governance Planes S6-08 Reference Architecture

Epic rollup for HOBO-663. Composes existing draft contracts into one Stage-6
governance evidence harness.

## Service boundaries

```text
GovernancePlanesReferenceArchitecture
├── ConsentNotifyGate          → policy.Decided + notification.*
├── DataGovernanceEvaluator    → can-deploy residency (HOBO-183 contract)
├── CryptoShredErasure         → erasure.* without log rewrite (HOBO-295)
├── GuardrailOutputGate        → guardrail.Blocked (HOBO-187 contract)
└── CertifiedRegistryInstall   → match.Decided + listing.Certified index (HOBO-362)
```

## Composed packages

| Package | Role |
|---|---|
| `data-governance-policy-contract` | Classification → residency obligation at plan time |
| `crypto-shred-erasure-contract` | Forward-only log erasure |
| `guardrail-policy-gate-contract` | Enforced AI output guardrails |
| `capability-indexed-discovery-contract` | Certified-only Registry discovery |

## PACT inventory

See [`architecture/pacts/governance_planes_s6_08.pact.json`](./architecture/pacts/governance_planes_s6_08.pact.json).
