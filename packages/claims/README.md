# @hobo/claims

The durable lifecycle for work that exists before anyone owns it.

An anonymous deployment is not a permanent resource plus a claim URL. It is a
**guest lease** with an expiry the provider decides, and a **claim bundle** that
may span several providers with independent deadlines. This package owns that
lifecycle. Provider packages implement strategy operations; they never carry
their own reducer.

## What is in here

- `types.ts` — `GuestLease`, `ClaimBundle`, `ClaimItem`, continuity grades, and
  the stable `ClaimError` codes.
- `events.ts` — the command and event families, plus `assertNoSecrets`, the
  guard that refuses to append an event carrying a claim URL, token, connection
  string, or key.
- `reducer.ts` — the pure reduction from state plus command to state plus
  events.
- `one-time-action.ts` — encrypted, session-bound, single-use storage for
  sensitive human actions such as a claim URL.

## Three independent state machines

A transition in one proves nothing about the others, and the reducer enforces
that separation:

```
Human HoBo session:  anonymous guest -> authenticated owner
Agent principal:     unregistered -> pre-claim -> human-bound | revoked
Infrastructure:      temporary/sponsored resource -> owner-controlled | expired
```

A human can own the infrastructure while the pre-claim agent is revoked. An
`auth.md` agent claim never completes an infrastructure claim.

## Invariants the reducer holds

- A provider redirect or a `success: true` response is not ownership. An item
  completes only after provider observation **and** independent verification.
- A bundle completes only when every required item completes and every mandatory
  rotation and bootstrap revocation has finished.
- The earliest deadline is derived from item deadlines, recomputed
  deterministically, never stored as an independent fact.
- Partial claims are explicit and repairable; they are never flattened into
  success or failure.
- A stale fence cannot complete a claim or migration after the lease moved.
- Migration cutover happens only after destination verification; source cleanup
  only after cutover and the configured rollback window.

## Parse, don't validate

Commands cross one parse boundary and become derived domain types before the
reducer sees them: instants, fencing tokens, subject refs, and one-time action
references are parsed values, not raw strings, so an unbounded or unscoped input
is unrepresentable inside the state machine. The protobuf records in
`data-models/` are the wire form of the durable aggregate.

## Event architecture

`reduce` is the pure core of the claim coordinator **actor**. It accepts
**commands** (`BeginClaimItem`, `VerifyOwnership`, `RotateCapabilityBinding`,
`ExpireGuestLease`, …) and returns **events** (`ClaimItemStarted`,
`OwnershipVerified`, `CapabilityBindingRotated`, `GuestLeaseExpired`, …) that the
host appends to the durable **event store**. **Projections** fold that stream
into the **materialized views** the CLI and site read; periodic **snapshots**
back the **read store** that answers current status. Provider effects happen
outside the event-store transaction, keyed by idempotency and adopted on an
ambiguous timeout, so a retry never creates a second provider resource.

## Admission controls

`admitAnonymousDeployment` is the pure gate in front of everything above.
Anonymous provisioning spends an operator's money and free tier, so a request is
checked against per-session and per-risk-bucket quotas, concurrency ceilings,
sponsor resource counts and budget, TTL and rollback-window bounds, payload and
file-count limits, and a poll interval before an offer is ever compiled. Every
violated ceiling is reported, not just the first. Provider and recipe kill
switches are policy data rather than code, so stopping a misbehaving provider
does not require a deploy.

## One-time actions

A claim URL is bearer authority. `createOneTimeActionStore` encrypts it at rest,
binds it to tenant, project, session, and audience, redeems it once, and expires
or revokes it independently. The value never enters an event payload, a log, a
trace, or a public read model; only the reference does.

## Contracts

- `data-models/claims.proto` / `.cue` — records plus the invariants that keep a
  claim honest (a multi-provider bundle cannot call itself atomic; a completed
  item must carry evidence).
- `contracts/pacts/claim-coordinator-strategy.pact.json` — the coordinator to
  provider-strategy boundary, including observation that deliberately does not
  complete an item.

Run `pnpm --filter @hobo/claims test` for reducer, admission, one-time action,
and provider-strategy contract coverage.

The foundation layer also refreshes the root lockfile; `pnpm run install:check`
verifies that current trunk plus these workspaces installs frozen.
