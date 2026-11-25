# HOBO-377 Listing Lifecycle Yank Proof

This proof package links HOBO-377 to [ADR-0062](../../adr/07-portability-extensibility.md#adr-0062)
section 6, [ADR-0075](../../adr/07-portability-extensibility.md#adr-0075) section 6, and
[ADR-0074](../../adr/02-identity-security.md#adr-0074). The executable POC lives at
[listing-lifecycle-yank-contract](../../../../src/draft/technical-proofs/listing-lifecycle-yank-contract).

Acceptance coverage:

- Yanking a certified version emits `listing.Yanked`.
- `canDeploy()` hard-fails a new deploy or redeploy that selects the yanked listing and returns
  remediation to choose a non-yanked version or Matching equivalent.
- `doctor()` flags running Sets that pin the yanked listing, and `resolvePinnedListing()` keeps the
  pinned artifact resolvable as flagged.
- Critical yanks raise `policy.ObligationCreated`; low-severity yanks with an explicit override do
  not auto-page.
- Running deployments are not mutated in place by the yank path.

Adversarial coverage:

- Unauthorized identities cannot yank listings.
- Yanked listings are excluded from new-selection discovery while pinned Sets still resolve them as
  flagged.
- Certifying a fixed replacement listing does not un-yank the compromised listing.

Scope intentionally stops before continuous Capability Spec re-verification, registry-compromise
assertions, SRE migration execution, and curated catalog approval/revoke.
