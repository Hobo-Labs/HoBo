---
type: Reference
title: "HOBO-503 Marketplace Publisher Trust Evidence Proof"
description: "Source issue: HOBO-503."
tags: [hobo, design]
---

# HOBO-503 Marketplace Publisher Trust Evidence Proof

HOBO-503 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/marketplace-publisher-trust-evidence-contract`](../../../../src/draft/exp-proofs/cx/marketplace-publisher-trust-evidence-contract/README.md)
and the durable scope record at
[marketplace-publisher-trust-evidence.md](../../marketplace-publisher-trust-evidence.md).

## Acceptance Evidence

- Trust tiers define generated sandbox, verified publisher, hosted curated, and enterprise-private
  catalog listings.
- Review evidence maps publisher identity, artifact provenance, conformance, security review,
  deprecation/yank behavior, and customer warnings.
- Handoffs link artifact provenance, Registry distribution, org catalogs, and support.
- Unsupported marketplace claims are documented as blockers or launch limitations.
- Scope-out keeps marketplace review UI, publisher portal UI, and monetization out of this issue.

## Negative Coverage

- Validation rejects marketplace UI or paid-tier scope creep.
- Validation rejects missing security review evidence.
- Validation rejects installable claims without hosted or enterprise curation.
- Validation rejects customer-warning gaps.
- Validation rejects ratings or provenance as substitutes for security review evidence.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\marketplace-publisher-trust-evidence-contract test
```
