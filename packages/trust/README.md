# @hobo/trust

Whether a provider adapter may be selected, decided from signed evidence and
never from optimism.

Selection asks "does this product implement the profile". This package asks the
other question: "did anyone actually test it, recently, and will the account
still be the operator's after the claim?" The answer is a pure function of
signed evidence, an operator requirement, and an explicit instant — and it is
fail-closed. Absent, unparseable, unsigned, digest-mismatched, expired, stale,
or `unknown`-checked evidence all produce the same verdict: not selectable.
"We did not test it" is never "it works".

## What is in here

- `evidence.ts` — `TrustEvidence`: what was exercised against a provider
  adapter, when, by whom, with which checks, and citing the https sources a
  human read and dated.
- `requirement.ts` — `TrustRequirement`: what an operator demands. Defaults deny
  sponsor spend and bridge realization, because the cost of a permissive default
  is paid by whoever inherits the deployment.
- `evaluate.ts` — `evaluateTrust`, the gate, returning a `TrustVerdict` with
  sorted reasons and a deterministic digest.
- `gates.ts` — `evaluateTrustBundle` for a whole solution's products at one
  instant, `evaluateEvidenceFreshness` for the freshness question on its own,
  and `trustPolicyFromRequirement`, the single place the trust and selection
  layers are reconciled so they cannot drift apart.
- `override.ts` — the audited escape hatch.
- `verifier.ts` — the signature-verification port. This package implements no
  cryptography; the default verifier answers `unknown` for everything, so
  "forgot to wire a trust root" is indistinguishable from "nobody vouched".
- `canonical.ts` — canonical JSON and `sha256Of`, the bytes every digest here
  is taken over.

## Parse, don't validate

Every entry point is a parse boundary that returns a derived domain type.
`parseTrustEvidence` returns a branded `TrustEvidence`; `parseTrustRequirement`
returns a branded `TrustRequirement` with every optional dial resolved to its
fail-closed default. A malformed record never becomes "evidence with some
missing fields" — it is not evidence at all, and `tryParseTrustEvidence`
returns `undefined` so that `evaluateTrust` treats it exactly like an absent
record.

Because the parsed types are what `evaluateTrust` accepts, the gate contains no
defensive re-checking: a requirement with a negative claim ceiling, or evidence
citing an http source, is not a case the gate handles — it is a value that
cannot reach it.

## The override is not a bypass

An operator can accept a provider the evidence does not vouch for, but only by
naming themselves, at least a sentence of justification, the exact reason codes
waived, and an expiry no longer than 90 days. The result never sets
`selectable`: automatic selection keeps ignoring the adapter, and only a caller
that explicitly consults `manuallyAuthorized` can act on it. Applying an
override to a verdict that already passed is rejected, because a decorative
override is exactly the audit-trail pollution this path exists to avoid.

## Event architecture

This package is pure and emits no events. `evaluateTrust`,
`evaluateTrustBundle`, and `applyOperatorOverride` read no clock, no network,
and no filesystem: `nowMs` and the verifier are arguments. It owns no aggregate
and mutates nothing.

What it produces are decision inputs for the surrounding event-driven control
plane, and the digests that make those decisions auditable later. A
`TrustBundleVerdict` gates the compile **command** in `@hobo/recipes`: an
unselectable product means no `DeploymentOffer` is ever built, so no acceptance
is recorded and no provisioning command is issued. Once an offer is accepted,
the trust evidence refs and the bundle digest travel in `BrokerRequest.guest`
and are pinned into the signed `ResolutionReceipt`
([ADR-0151](../../docs/design/adr/07-portability-extensibility.md#adr-0151)).
Downstream, the claim coordinator **actor** in `@hobo/claims` emits the
`claim.*` **events** (`ClaimItemStarted`, `OwnershipVerified`,
`GuestLeaseExpired`, …) that the host appends to the durable **event store**;
the claim-bundle **projection** folds that stream into the **materialized view**
of unclaimed work and its deadlines, and periodic **snapshots** back the
**read store** the CLI and site query for current status.

Evidence expiry is what makes this a live obligation rather than a one-time
gate: the same evidence, evaluated at a later instant, flips to unselectable
without anything being written. A verdict recorded in an event can be
re-derived years later from the same evidence, requirement, and instant,
because nothing here is ambient.

## Contracts

- `data-models/trust.proto` / `.cue` — the evidence, requirement, verdict,
  bundle verdict, and override records plus their invariants: digest formats,
  evidence that must expire after it was tested and must cite at least one
  dated https source, a bounded claim-action count, a verdict that cannot be
  selectable while it carries a reason or an unverified signature, a freshness
  record whose `fresh` flag is a projection of its state, and an override that
  must enumerate what it waives inside a bounded window.
- `contracts/pacts/trust-gate.pact.json` — the recipe-compiler to trust-gate
  boundary, including the refusals that matter: absent evidence, a missing
  trust root, expiry, an `unknown` check, one bad product sinking a bundle, and
  an override that misses a recorded code authorizing nothing.
  `test/contract.test.ts` verifies this package as the provider by running the
  real gate against every recorded interaction.
