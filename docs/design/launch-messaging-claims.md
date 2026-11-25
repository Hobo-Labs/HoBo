---
type: Reference
title: "Launch Messaging Claims"
description: "Source issue: HOBO-406."
tags: [hobo, design]
---

# Launch Messaging Claims

Source issue: HOBO-406.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-messaging-claim-register`](../../src/draft/exp-proofs/cx/launch-messaging-claim-register/README.md).

## M0 Acceptance Record

V1 launch messaging must be evidence-led. A public-facing claim is publishable only when it has an
evidence owner, an evidence source, a risk rating, and a current capability state. This record does
not write final launch copy; it defines the claim register that future launch-site and demo work
must consume before publication.

## M1 Dogfood/Alpha Evidence Gate

Source issue: HOBO-458.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-site-demo-alpha-evidence-contract`](../../src/draft/exp-proofs/cx/launch-site-demo-alpha-evidence-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-458-launch-site-demo-alpha-evidence`](./proofs/hobo-458-launch-site-demo-alpha-evidence/README.md).

The M1 dogfood/alpha gate accepts the launch-site, messaging, and demo-asset evidence map without
building the launch site. The gate records owner-mapped evidence, blockers, accepted risks, release
cutline dependencies, follow-up rules, and parent-initiative status behavior.

### M1 Gate Rules

| Rule | Requirement |
|---|---|
| Owner-mapped evidence | Claim register, golden-path checklist, recording-manifest slot, cutline documentation domain, and known-limitations register all carry owner project and source. |
| Blockers and risks | Alpha-only recording evidence and reference-fixture demo behavior are recorded as accepted risks with mitigations. |
| Release cutline | Documentation, productization, and operations-readiness dependencies map to the v1 cutline blocker domains. |
| Follow-up creation | Execution follow-ups are allowed only when evidence is explicitly marked missing. |
| Parent initiative | The HoBo v1 Release Readiness initiative needs a status update only when the gate changes launch risk. |
| Public claims | Public claims require accepted live evidence; reference fixtures and alpha-only slots cannot be promoted to production-readiness wording. |

## Claim States

| State | Meaning | Publication rule |
|---|---|---|
| `implemented` | There is branch evidence or an accepted design/proof record for the capability shape. | Candidate wording may be drafted when the evidence source is linked. |
| `simulated-reference` | The claim is backed by reference fixtures, design records, or contract tests rather than live hosted behavior. | Must be labeled as simulated or reference evidence. |
| `beta-only` | The claim depends on dogfood, beta, or private operational evidence. | Public wording waits for accepted beta evidence or stays private-beta only. |
| `future-roadmap` | The capability is planned or designed but not launch-proven. | Keep out of public launch claims unless framed as roadmap and legally reviewed. |

## Initial Claim Register

| Claim | State | Evidence owner | Evidence source | Risk | Disposition |
|---|---|---|---|---|---|
| HoBo is an AI-native meta-cloud that maps one app description onto provider-owned infrastructure through cloud-agnostic ports. | `implemented` | V1 Release Program & Cutline | [`v1-cutline-contract`](../../src/draft/technical-proofs/v1-cutline-contract/README.md) | Medium | Candidate with M1 dogfood/alpha cutline evidence; beta/GA evidence still required before broader operational claims. |
| Launch demos can use accepted example-app proof modes to separate live behavior from reference or simulated evidence. | `simulated-reference` | Example Apps | [example-apps.md#M0 Acceptance Record](./example-apps.md#m0-acceptance-record) | Medium | Candidate with proof-mode label. |
| Dogfood and beta operations evidence can support private-beta messaging before broader GA operational claims are made. | `beta-only` | V1 Dogfood Yard & Hosted Operations | HOBO-403 | High | Follow-up before public use. |
| Customer-facing release notes will distinguish supported install paths, upgrade guidance, known limitations, and support contacts. | `future-roadmap` | V1 Release Notes & Upgrade Guide | [known-limitations-register.md](./known-limitations-register.md) | Medium | Follow-up before launch publication; scope-out claims must pass the known-limitation guard. |
| Built-in operator agents are part of the product story, but launch wording must stay tied to current Crew design and proof evidence. | `future-roadmap` | Operators/SRE | [operators-sre.md#PLAN-40](./operators-sre.md#plan-40) | High | Scope out until proof evidence exists. |

## Required Demo Assets

| Asset | Owner | Proof mode | Refresh trigger |
|---|---|---|---|
| Claim index | Launch messaging owner | Design record | Any public-facing claim changes state, owner, or evidence source. |
| Demo script | Demo maintainer | Manual review | Golden path, persona, or unsupported-state wording changes. |
| Command transcript | Example Apps | Reference fixture | Example app command path, fixture output, or CLI wording changes. |
| Screenshot set | V1 Launch Site, Messaging & Demo Assets | Live recording | UI surface, proof-mode label, or launch visual changes. |
| Recording manifest | V1 Launch Site, Messaging & Demo Assets | Live recording | Demo recording, expected output, or simulated/reference marker changes. |

## Scope Out And Follow-Up

| Item | Reason | Disposition |
|---|---|---|
| Launch site build | HOBO-406 drafts the claim register; it does not build or publish the launch site. | V1 Launch Site implementation issue. |
| Unproven production-readiness claims | Production-readiness claims need beta, RC, or GA evidence before publication. | Known limitation or go/no-go blocker. |
| Unsupported provider, runtime, billing, support, or operations breadth | Those claims require their owner evidence and must not be inferred from reference fixtures. | Owner project follow-up. |

## Authoritative Dependencies

- [vision.md#plan-17](./vision.md#plan-17) defines competitive positioning and scope honesty.
- [example-apps.md](./example-apps.md) defines proof modes launch demos can consume.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) owns CLI/demo command surfaces.
- [operators-sre.md#plan-40](./operators-sre.md#plan-40) owns Crew/operator-agent claims.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps monetization and business
  process mechanics outside the platform scope.

## Evidence Required For Publication

| Evidence | Owner | Proves |
|---|---|---|
| Claim register | Launch messaging owner | Every claim has state, owner, source, risk, and disposition. |
| Cutline evidence | V1 Release Program & Cutline | Implemented claims match the accepted v1 support boundary. |
| Proof-mode labels | Example Apps and Demo maintainer | Simulated/reference/beta/live evidence is not overclaimed. |
| Known-limitations register | V1 Release Notes & Upgrade Guide | Unsupported claims move to scope-out or follow-up before publication, and supported-v1 wording for scoped-out items is rejected. |
| Demo asset manifest | V1 Launch Site, Messaging & Demo Assets | Launch demos can be refreshed when claims or proof sources change. |

## Private Beta Evidence Gate

HOBO-465 adds the M2 private beta gate for this project. The executable proof lives in
[`src/draft/exp-proofs/cx/launch-site-private-beta-evidence-contract`](../../src/draft/exp-proofs/cx/launch-site-private-beta-evidence-contract/README.md),
with branch evidence summarized in
[`proofs/hobo-465-launch-site-private-beta`](./proofs/hobo-465-launch-site-private-beta/README.md).

Private beta launch messaging may consume the claim register and golden-path demo records only when
required evidence has owners, accepted sources, demo asset refresh triggers, blockers, accepted
risks, cross-project dependencies, and release-readiness sync. This gate does not publish final
copy, build the launch site, or promote private beta evidence to public, release-candidate, or GA
claims.

## M3 Release Candidate Evidence Gate

HOBO-472 records the M3 release-candidate evidence gate for launch site, messaging, and demo
assets. The executable proof lives in
[`src/draft/exp-proofs/cx/launch-site-release-candidate-evidence-contract`](../../src/draft/exp-proofs/cx/launch-site-release-candidate-evidence-contract/README.md),
with branch evidence summarized in
[`proofs/hobo-472-launch-site-release-candidate`](./proofs/hobo-472-launch-site-release-candidate/index.md).

The release-candidate gate may draft launch-site and demo messaging only when owner-mapped
evidence, blocker dispositions, accepted risks, release-cutline dependencies, missing-evidence
follow-ups, and parent release-readiness sync are recorded. It does not build the launch site,
publish final public copy, create final visual assets, capture live hosted demos, or promote
release-candidate evidence into GA/public launch claims.

### M3 Gate Rules

| Rule | Requirement |
|---|---|
| Owner-mapped evidence | Claim register rules, private-beta launch evidence, golden-path demo assets, release-candidate cutline, release notes, and legal/support handoff records all carry owner project and source. |
| Blockers and risks | GA launch-site handoff remains blocked on HOBO-479, and reference-fixture demo language remains an accepted risk with proof-mode labels. |
| Release cutline | Documentation, productization, operations-readiness, release-cutline, legal, and support dependencies map to v1 blocker domains. |
| Follow-up creation | Execution follow-ups are allowed only for missing evidence; this gate points GA handoff work to HOBO-479. |
| Parent initiative | The HoBo v1 Release Readiness initiative needs a status update because release-candidate launch messaging changes launch risk while GA/public claims remain blocked. |
| Public claims | Release-candidate demo assets cannot publish GA readiness or production-readiness claims without GA handoff and accepted live evidence. |

## GA Handoff Evidence Gate

HOBO-479 adds the M4 GA handoff gate for this project. The executable proof lives in
[`src/draft/exp-proofs/cx/launch-site-ga-handoff-evidence-contract`](../../src/draft/exp-proofs/cx/launch-site-ga-handoff-evidence-contract/README.md),
with branch evidence summarized in
[`proofs/hobo-479-launch-site-ga-handoff`](./proofs/hobo-479-launch-site-ga-handoff/index.md).

GA launch messaging may consume the claim register, golden-path demo record, private-beta launch-site
evidence, GA asset-manifest handoff, release cutline, release notes, support, legal/privacy, and
dogfood operations records only when each has an owning project and source. The gate records
blockers, accepted risks, cross-project dependencies, follow-up rules, and parent release-readiness
sync. This gate does not build or publish the public launch site, write final launch copy, create
final visual assets, record final demo video, provision real cloud resources, or promote
release-candidate/private-beta evidence into unconditional GA production-readiness claims.

## Follow-Up Gate

Future launch-site, demo, release-note, and public-copy work must consume this register. A claim with
no evidence source, unsupported state, or high-risk publish disposition without follow-up/scope-out
routing is not ready for launch publication.
The customer-facing scope-out register is
[`known-limitations-register.md`](./known-limitations-register.md).
