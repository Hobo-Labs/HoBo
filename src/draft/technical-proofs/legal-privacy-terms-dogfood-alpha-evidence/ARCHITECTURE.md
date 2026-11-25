# Legal Privacy Terms Dogfood Alpha Evidence Architecture

## Schema And Constraints

The package defines the M1 dogfood/alpha evidence record in
[`proto/legal_privacy_terms_dogfood_alpha_evidence.proto`](./proto/legal_privacy_terms_dogfood_alpha_evidence.proto)
and binds it with CUE constraints in
[`cue/legal_privacy_terms_dogfood_alpha_evidence.cue`](./cue/legal_privacy_terms_dogfood_alpha_evidence.cue).
The PACT contract in
[`contracts/pacts/legal-privacy-terms-dogfood-alpha-evidence.pact.json`](./contracts/pacts/legal-privacy-terms-dogfood-alpha-evidence.pact.json)
pins the release-governance boundary.

## Parse, Don't Validate

The boundary parser accepts raw M1 evidence input once and derives a
`LegalPrivacyTermsDogfoodAlphaRecord` parsed domain type. Downstream gate evaluation receives that
derived type, not broad DTO values. CUE constraints and the TypeScript constructor rules reject
missing follow-up work, unexpected follow-up work, final legal drafting scope creep, and unsupported
public launch claims before the record becomes the read model.

## Event Architecture

- **Command**: `legalPrivacyTermsDogfoodAlpha.AcceptEvidence` records dogfood/alpha evidence for
  the legal/privacy/terms gate.
- **Event**: `legalPrivacyTermsDogfoodAlpha.EvidenceAccepted` or
  `legalPrivacyTermsDogfoodAlpha.EvidenceRejected` is appended after parsing.
- **Actor**: the release-governance evidence actor owns the single-writer decision for HOBO-457.
- **Event store**: accepted and rejected gate events append to the release-readiness event store.
- **Materialized view / projection**: `LegalPrivacyTermsDogfoodAlphaGateView` folds events into the
  current milestone state, blockers, missing evidence, invalid follow-ups, and cutline dependency
  coverage.
- **Snapshot**: the accepted M1 record is the projection snapshot used by release reviewers.
- **Read store**: release cutline, support, legal, privacy, and launch-communications readers query
  the read store instead of inspecting raw event payloads.

No production legal workflow, support desk, billing, or customer-facing legal text is implemented
here.
