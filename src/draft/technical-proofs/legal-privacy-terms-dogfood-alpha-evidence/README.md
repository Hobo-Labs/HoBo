# Legal Privacy Terms Dogfood Alpha Evidence

HOBO-457 proof for the V1 Legal, Privacy & Terms Readiness M1 dogfood/alpha gate.

## What This Proves

- Required dogfood/alpha evidence is listed for terms, privacy notice, data retention, telemetry,
  subprocessors/provider claims, security claims, support obligations, and customer
  communications.
- Every evidence item maps to an owning project and a release cutline reference.
- Missing evidence must create follow-up work and prevents milestone completion.
- Accepted evidence cannot create extra follow-up execution issues.
- The parent HoBo v1 Release Readiness status is updated when the gate changes launch risk.
- Scope guards reject final legal drafting and unsupported paid, public, beta, or GA claims.

## Boundary

This package records M1 dogfood/alpha evidence acceptance only. It does not draft terms, privacy
policy, DPA language, legal policy text, billing terms, customer SLAs, compliance claims, or a legal
workflow product.

## Verification

```powershell
pnpm.cmd --dir src\draft\technical-proofs\legal-privacy-terms-dogfood-alpha-evidence test
```

## Architecture Evidence

- `proto/` defines the data contract for the dogfood/alpha evidence record and gate result.
- `cue/` constrains required domains, statuses, follow-up behavior, and scope boundaries.
- `contracts/pacts/` records the release-governance consumer/provider boundary.
- `ARCHITECTURE.md` records parse-don't-validate derived types and event architecture.
