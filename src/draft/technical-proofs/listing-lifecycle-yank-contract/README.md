# Listing Lifecycle Yank Contract POC

This POC pins HOBO-377's registry security-response path for a certified listing version moving to
`Yanked`. It owns the lifecycle command and its immediate propagation contract; it deliberately does
not implement continuous re-verification, registry compromise assertions, SRE migration execution, or
curated catalog approval/revoke.

It defines:

- `createListingLifecycle()` for an in-memory lifecycle over certified listings, running Sets, yank
  commands, events, and remediation obligations.
- Authorized `listing.Yanked` emission by the publisher trust domain or a Yard security-policy admin.
- `canDeploy({ selection })` hard-fail behavior for any new deploy/redeploy selecting a yanked
  listing, including remediation text.
- `doctor()` findings for running Sets that pin yanked listings, while `resolvePinnedListing()`
  still resolves the exact pinned artifact as flagged instead of breaking it.
- Critical-severity `policy.ObligationCreated` remediation obligations and a policy override surface
  for lower-severity yanks that should not auto-page.

## Verification

Run the focused contract suite:

```powershell
npm.cmd --prefix src\draft\technical-proofs\listing-lifecycle-yank-contract test
```

The root `npm.cmd test` discovers this package's Node test suite with the rest of the draft POCs.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Listing Lifecycle Yank Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
