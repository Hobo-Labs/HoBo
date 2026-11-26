---
type: Proof Record
title: "HOBO-282 Identity OCSF Export Proof"
description: "HOBO-282 implements a replayable, one-way OCSF projection proof in"
tags: [hobo, design]
---

# HOBO-282 Identity OCSF Export Proof

HOBO-282 implements a replayable, one-way OCSF projection proof in
`src/draft/technical-proofs/identity-ocsf-export-contract`.

The proof package covers the issue acceptance criteria:

- Identity, token, session, secret/config, and auth `policy.Decided` samples map
  to OCSF `Authentication`, `Authorization`, or `Account Change` records with
  stable HoBo extension fields.
- XAA token grants, uses, and secret accesses export with a linked
  `credential_chain` carrying user, agent, target, grant, use, and secret refs.
- Plaintext PII is rejected by the source contract. Protected subjects export
  only ciphertext refs plus hashed crypto-shred key refs.
- Unknown identity audit event types are reported by
  `validateIdentityOcsfMappingCoverage` as explicit mapping gaps.
- Batch exports preserve monotonic ordering or label the batch as unordered with
  a reason.

The proof is intentionally scoped to projection. It does not add CloudEvents
export for non-security facts, build CredentialAudit storage, implement
crypto-shred keys, or define SIEM retention.
