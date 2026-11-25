# Vibe Publisher Portal Review Mockups - Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-548. It records
how publisher portal review mockup fixtures are parsed, how publisher evidence
stays customer-safe, how review and payout states remain owner handoffs, and
how accepted HOBO-577 quickstart fixtures constrain downstream publisher
surfaces while runtime work remains outside this branch.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact fixture under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

`parseVibePublisherPortalReviewMockups` checks the raw mockup fixture at the
boundary and returns `ParsedVibePublisherPortalReviewMockups`. Downstream proof
code consumes the parsed domain type rather than passing raw strings and
rechecking publisher persona, mockup state, artifact metadata, evidence state,
review outcome, payout-readiness handoff, support wording, customer-visible
limitation, proof mode, scenario, accessibility, and scope-out fields in every
view. The parsed record also pins HOBO-577 quickstart fixture ids, source issue,
proof-mode labels, and publisher-use notes so later publisher portal surfaces
cannot invent lifecycle behavior.

## Event Architecture

This package does not implement the publisher portal runtime. It names the
event model later runtime work must preserve:

- **Command** - `publisherPortalMockup.Accept` records an accepted publisher
  review mockup fixture.
- **Event** - `publisherPortalMockup.Accepted` appends the review state,
  fixture, scenario, proof-mode, quickstart fixture, accessibility, and
  limitation evidence.
- **Actor** - `PublisherPortalMockupActor` owns the parsed fixture and rejects
  onboarding-service, artifact-hosting, Registry, payout, scanner, production
  UI, support, customer-data, or proofless launch-claim creep.
- **Event store** - accepted mockup evidence is appended to the platform event
  store as design-time evidence.
- **Materialized view / projection** - `PublisherPortalMockupView` folds
  accepted events into the read model consumed by later marketplace and
  publisher portal slices.
- **Snapshot** - the parsed HOBO-548 record is replayable from its accepted
  event and carries proof-mode labels and customer-visible limitations.
- **Read store** - later M2 publisher portal work reads the snapshot, not
  issue-body text or live Registry, payout, scanner, or support state.

No publisher onboarding service, artifact hosting, Registry storage, payout
provider, tax collection, bank account handling, settlement, money movement,
security scanner, conformance runner, approval service, policy engine,
production portal UI, storefront, support queue, support automation,
customer-data access, or unsupported launch claim is implemented here.
