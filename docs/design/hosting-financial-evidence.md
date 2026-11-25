---
type: Design
title: "Hosting financial evidence ingestion"
description: "Pinned, signed, account-scoped financial readbacks for provider lifetime bounds, terminal absence, and final usage."
tags: [hobo, hosting, finops, evidence, resilience]
---

# Hosting financial evidence ingestion

`createHostingFinancialEvidenceReader` connects production hosting execution to an
independently operated billing, prepaid entitlement, or provider expiry integration.
It makes actual bounded HTTP requests and verifies Ed25519 signatures before
persisting or exposing evidence. It does not turn a provider's soft quota, cost
estimate, DELETE acknowledgement, or local cleanup timer into a financial guarantee.

The host configures each source's exact tenant, provider, billing account, currency,
issuer ID, key ID, fixed HTTPS endpoint, public key, and immutable resource bindings.
Bindings include the approved graph artifact, content digest, product, logical
resource, and physical identity when known. The response cannot supply its own
trusted key. A source key must belong to an integration authorized to assert the
specified account's enforceable lifetime and final billing facts.

## Integration protocol

The reader POSTs a read-only `hobo.hosting-financial-query/v1` query containing the
tenant, provider, billing account, operation ID and digest, and plan digest to the
configured endpoint. The integration returns a generated
`HostingFinancialEvidenceAttestation` JSON record. HTTP 404 supplies no evidence;
errors, invalid signatures, stale data, and scope mismatches retain the hold.

The signed claims contain those same identities, issuer/key/proof IDs, issue and
expiry timestamps, and the commitment's currency. Claims may carry lifecycle and
operating liability evidence. Every nested record has an explicit resource binding.
Existing core `ResourceLifecycleObservationRecord` and cloud
`HostingDestinationLiability` records are serialized as canonical protobuf JSON
strings and decoded with their owning schemas. This preserves one definition for
each record rather than creating a second financial model in the ingestion adapter.
When serializing nested records, emit implicit scalar defaults or otherwise include
explicit zero money and expiry fields; a missing final charge is not accepted as zero.

The issuer signs `hostingFinancialEvidenceSigningPayload(claims)` using Ed25519;
the outer signature is `ed25519:` followed by the unpadded base64url signature.
The signing key stays with the independent integration. The integration must obtain
resource state, liability bounds, and billing finality from its authoritative source.
A requested budget, target plan, forecast, or desired expiry is never that source.

## Facts that may advance execution

- `observeOperatingLiability` requires an exact resource/account/content binding and
  a native finite-term or irrevocable provider-funded-zero entitlement. Its maximum
  charge covers the entire liability, including residual fees. Unknown usage and
  delayed billing remain nonfinal. The execution adapter checks the observed bound
  against the approved amount and funded lifetime before the first mutation.
- `observeLifecycle` requires fresh signed provider evidence. Terminal absence needs
  an exact physical identity and an assertion that no matching mutation can apply
  later. An absent resource may omit a content digest; an ordinary 404 is insufficient.
- `billing.observe` returns only verified resource observations. Final usage requires
  an explicit safe integer amount and authoritative provenance. Bundle currency must
  match both the configured account and the plan commitment.

Billing proofs must cover every configured resource in the selected source and
destination graphs. A partial proof cannot establish account finality. Shared native
resources referenced by both graphs are counted once; conflicting amounts, physical
state, or finality refuse settlement. Distinct resources on one account remain
separate cost lines and account aggregation requires every line to be final.

The SQLite journal claims each issuer/key/proof ID immutably. Repeated reads of the
same proof for the same operation are idempotent. A changed proof under the same ID,
a changed physical resource, decreasing observation or issue time, revoked final
usage, or changed finalized entitlement is refused. Proof claims are retained after
expiry. Public evidence locators cannot contain URL credentials or query secrets.

The default proof age is 60 seconds and its configured maximum is five minutes.
The reader checks the clock again after HTTP completes. Read-only reconciliation
remains possible after a mutation deadline or native term expires: delayed final
billing must still be observable. Mutation admission separately requires an active
destination entitlement. Requests have a 15-second
maximum deadline and a 512 KiB response limit. The production host supplies core's
bounded fetch transport; insecure HTTP is available only for explicit loopback tests.

## Verification

`packages/hobo/test/hosting-financial-evidence.test.ts` runs a real local HTTP server,
Ed25519 keys, actual SQLite stores and independent connections, and the CUE binary.
It covers reopening, races, tampered or foreign-scope proofs, currency substitution,
physical identity confusion, missing and stale evidence, unsafe money, revoked
finality, credential-bearing metadata, byte bounds, and expiry during a response.
These tests validate the ingestion implementation. Installing this reader does not
prove a provider's commercial API supplies terminal per-resource billing; production
configuration must supply an independently trusted integration with that authority.
