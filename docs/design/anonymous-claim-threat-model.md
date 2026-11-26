---
type: Reference
title: "Anonymous & Claimable Deployment Threat Model"
description: "Threat boundaries, attacker goals, and required controls for guest leases, claim bundles, sponsor-backed deployment, and migrate-on-claim."
tags: [hobo, design, security]
---

# Anonymous & Claimable Deployment Threat Model

Anonymous deployment inverts the usual trust assumption. In an owned
deployment the human authenticates first and HoBo acts inside authority the
human already granted. In a guest deployment HoBo creates real, sometimes
billable, infrastructure *before* anyone has proven who they are, holds bearer
authority over that infrastructure on a stranger's behalf, and then hands it
to a human who shows up later claiming to be the intended owner.

Three things follow, and they shape every control below:

1. **The claim ceremony is the authentication event.** Until it completes and
   is verified against the provider, HoBo knows nothing about who owns what.
2. **HoBo temporarily holds credentials it must not keep.** Every pre-claim
   token is authority the eventual owner did not choose to grant.
3. **A guest deployment is an attacker-reachable resource by design.** It is
   created without authentication, so the creation path itself is the abuse
   surface.

This document is scoped to the anonymous-to-owned lifecycle introduced by
[ADR-0151](adr/07-portability-extensibility.md). The launch-readiness gate
vocabulary lives in [`threat-model-security-review.md`](./threat-model-security-review.md);
credential custody rules live in
[ADR-0027](adr/02-identity-security.md) and the secretless config ladder.

## Trust boundaries

| Boundary | Trusted side | Untrusted side | What crosses |
|---|---|---|---|
| Browser ↔ Broker API | Broker/Station | example page, guest session | offer requests, accepted consent digests, claim status polls |
| Broker ↔ provider API | Broker/Yard executor | provider REST surface | idempotency keys, provisioning calls, ownership probes |
| Secret plane ↔ everything | secret store | plans, events, receipts, logs, UI | `SecretRef` locators only |
| Guest lease ↔ owner tenant | verified owner boundary | pre-claim session, pre-claim agent | verified ownership transitions |
| Agent principal ↔ infrastructure | owner authorization | pre-claim agent assertion | explicitly granted post-claim scopes |

The example page sits entirely on the untrusted side. It renders claim
actions; it never holds the authority those actions confer.

## Attacker goals and controls

### Claim URL replay

A claim URL, transfer code, or one-time action reference is bearer authority:
whoever presents it becomes the owner. An attacker who observes one — in a
log, a screenshot, an analytics payload, an exception message, a shared
terminal, or a browser history — can claim someone else's deployment.

Controls: one-time material is stored encrypted, bound to tenant, guest
session, deployment, and intended user, and released once. Comparison-only
material is stored as a SHA-256 hash. Redaction applies to claim URLs with the
same rigor as to passwords, including in receipts, spans, and fixtures. Provider
text — an error body, CLI output, an apiserver Status — is redacted by one
implementation, `@hobo/provider-redaction`: shared credential shapes, each
linear in the text so a hostile megabyte cannot stall the error path, a bounded
search window, and a profile per provider for its own claim URLs and token
formats. Event, offer, and evidence guards that refuse rather than redact use
the same JWT and private-key detectors. The
material is persisted atomically *before* the deployment is reported
successful, so a crash can never leave a live resource with an unrecoverable
claim path.

### Cross-tenant claim and confused deputy

An attacker substitutes another tenant's deployment id, guest session id, or
claim item id into an otherwise legitimate claim request, or induces the
Broker to perform a claim on their behalf against a resource they do not own.

Controls: every claim item is scoped to its bundle, lease, tenant, and
intended user, and the scope is checked on the server, never inferred from a
client-supplied identifier. Claim completion is verified through the provider
surface — the provider is asked who owns the resource. Redirect completion,
callback receipt, and email possession are not accepted as proof.

### Sponsor credential compromise

Sponsor-backed deployment (Vercel Claim Deployments, sponsored Azure/AWS/GCP
fallbacks) spends HoBo's money under HoBo's provider account. A leaked sponsor
credential is both a financial loss and a foothold in every sponsored project.

Controls: sponsor credentials are short-lived and scoped through the token
broker; no ambient credentials. Sponsor exposure is capped per deployment and
recorded in the signed receipt (`sponsorCostCapMinorUnits`), and the parser
refuses a sponsor-backed resolution that names no cap — an unbounded sponsored
deployment cannot be represented. After transfer, sponsor membership and
authority are removed and verified.

### Malicious source archive

Anonymous callers upload source or build output. An archive is an attacker's
direct input to HoBo's build and storage.

Controls: reject path traversal and symlink escape on extraction, bound
decompression ratio and total size, bound file count and individual file size,
and bound dependency resolution and build execution. Netlify's anonymous mode
is prebuilt-static only, which removes build execution from that path
entirely; that restriction is advertised in the product descriptor rather than
enforced only at the call site.

### Provider callback forgery

An attacker forges a provider callback claiming a claim completed, a resource
was created, or a transfer succeeded.

Controls: callbacks are treated as hints that trigger an authenticated
outbound observation, never as authoritative state transitions. State advances
only on a verified read from the provider API using HoBo's own credential.

### Partial claim

A multi-provider bundle is claimed halfway: the Cloudflare account claim
succeeds and the Neon database claim expires. The deployment now spans one
owned boundary and one that is about to be destroyed.

Controls: bundles declare their atomicity honestly — `provider-bundled` is
used only where the provider contract actually bundles, never to describe two
independent ceremonies. Compensation is explicit (`rollback-when-supported`,
`continue-and-repair`, `migrate`), never silent. A resource already verified
as owner-controlled is never deleted by compensation. Unresolvable partial
claims produce durable remediation evidence rather than a swallowed error.

### Stale trust evidence

An adapter that passed conformance six months ago is selected today against a
provider API that has since changed, and the deployment fails after real
resources exist — or worse, succeeds while silently violating a guarantee the
offer promised.

Controls: trust evidence carries `testedAt`/`expiresAt` and is a hard gate,
not a ranking input. Expired evidence removes a candidate from automatic
selection; the example page fails closed rather than guessing. Experimental
providers are reachable only through explicit policy, and their status is
shown in the offer.

### Migration rollback

Migrate-on-claim moves live data. A failure mid-cutover can lose writes, or
leave both backends writable and divergent.

Controls: writes are quiesced before export; the target is verified before
cutover; the Connector rebind is atomic; the rollback window is read-only on
the old backend; the old backend and its credentials are destroyed only after
verification. For self-hosted Convex the destination admin key is generated
independently — the pre-claim key is never copied forward, because HoBo knew
it and an irrevocable secret HoBo knew is not an ownership boundary.

### Orphaned and abused resources

Guest deployments that nobody claims still cost money, still hold DNS names,
and still run code. Unbounded anonymous creation is free compute for an
attacker.

Controls: every guest deployment carries quotas, concurrency limits, cost
caps, TTL, payload bounds, and poll rate limits (`admitAnonymousDeployment`),
plus a data-driven kill switch. Cleanup runs on durable timers, not
process-local timeouts, so a restart cannot strand a resource. Logical
Connectors survive physical endpoint expiry so a reused provider hostname
cannot become a takeover of a still-referenced binding.

## Explicitly out of scope

HoBo does not implement, and must not be extended to implement, provider
account farming, identity rotation to reset a free tier, or any evasion of
provider limits. Rotation is across providers, never across accounts within a
provider ([ADR-0129](adr/07-portability-extensibility.md#adr-0129)).

## Review checklist

A change to the anonymous lifecycle is reviewed against:

- Does any new field carry bearer material into a receipt, event, log, or the
  browser?
- Does any new state transition accept a client assertion as proof of
  ownership?
- Does any new provider path create a chargeable resource without an
  idempotency key and a pre-persisted external reference?
- Does any new candidate reach automatic selection without fresh trust and
  conformance evidence?
- Does any new cleanup path risk deleting a verified owner-controlled
  resource?
