# Data Governance Policy Contract POC

Independent POC for HOBO-183. It pins how `data.Classified` facts become policy
context for residency, retention, runtime-boundary, and subprocessor checks
without implementing the classification scanner, full obligation engine,
crypto-shred erasure, OCSF export assembly, or Matching region context.

## Contract Surface

- `evaluateDataGovernancePolicy({ request, classifiedData, policy, ... })`
  consumes a policy `DecisionRequest` plus `data.Classified` facts.
- `request.context.dataClassifications` and `request.context.region` are folded
  into a replayable `classificationContext`.
- Can-deploy placement checks deny classified data outside allowed regions.
- Runtime exports either deny on non-compliant boundaries or emit a mutate
  decision that pins the action to an allowed region.
- Retention requests are evaluated as floor and ceiling constraints over
  compaction.
- Subprocessor use is denied unless the registry allows the classification and
  region.
- Every result emits a policy IR decision plus auditable `policy.Decided` and
  `dataGovernance.*` facts.

## Scope Boundaries

Included:

- PHI residency denial for non-permitted placement regions.
- Allowed Camp placement with replayable policy evidence.
- Runtime region pinning for compliant crossing-boundary exports.
- Runtime denial for non-compliant endpoints.
- Retention floor and ceiling enforcement.
- Fail-closed unregistered subprocessor checks.
- Fail-closed public-declared PII coverage findings.

Excluded:

- Classification labeling or discovery scanner implementation.
- Matching-driven region selection.
- Full durable obligation engine.
- Crypto-shred erasure and tombstone materialization.
- OCSF attestation export assembler.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\data-governance-policy-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Data Governance Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
