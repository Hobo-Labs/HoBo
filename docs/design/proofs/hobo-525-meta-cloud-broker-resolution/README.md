---
type: Reference
title: "HOBO-525 Meta-cloud Broker Resolution Proof"
description: "Source issue: HOBO-525."
tags: [hobo, design]
---

# HOBO-525 Meta-cloud Broker Resolution Proof

HOBO-525 is proven by the focused M2 contract at
[`src/draft/technical-proofs/meta-cloud-broker-resolution-contract`](../../../../src/draft/technical-proofs/meta-cloud-broker-resolution-contract/README.md)
and the durable boundary record at [meta-cloud-broker.md](../../meta-cloud-broker.md).

## Acceptance Evidence

- Same Contract Manifest plus same Broker Environment snapshot yields identical receipt output when
  mapping/catalog input order changes.
- Broker Environment snapshot identity, environment digest, and catalog snapshot digest are explicit
  replay inputs and change the receipt identity when they change.
- Structured rejections cover ambiguous, incompatible, and unavailable mappings.

## Negative Coverage

- Catalog-order nondeterminism is rejected as `mapping.ambiguous`.
- Provider defaults are refused unless an approved broker mapping selects them.
- Yard-local fallback matching is never invoked for missing broker mappings.

## Verification

```powershell
pnpm.cmd --prefix src\draft\technical-proofs\meta-cloud-broker-resolution-contract test
```
