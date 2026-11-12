---
type: Reference
title: "Release Channels Scope And Acceptance"
description: "Source issue: HOBO-431."
tags: [hobo, design]
---

# Release Channels Scope And Acceptance

Source issue: HOBO-431.

Executable proof lives in
[`src/draft/exp-proofs/dx/release-channels-scope`](../../src/draft/exp-proofs/dx/release-channels-scope/README.md).
Branch evidence is summarized in
[`proofs/hobo-431-release-channels`](./proofs/hobo-431-release-channels/README.md).

## M0 Acceptance Record

Release Channels defines the launch-critical product control-plane record for channel classes,
channel states, transition ownership, required publication evidence, support handoff, and follow-up
proof gates. It gives downstream design/build work a stable boundary for dogfood, private beta,
public beta, release-candidate, GA, and patch channels.

It does not build deployment promotion automation, artifact publication, compatibility runners,
launch messaging, support ticketing, status-page publication, security attestation, or legal/privacy
signoff workflows.

## User And Business Goal

HoBo needs accepted M0 scope for release channels before downstream work can depend on beta, RC, GA,
or patch readiness. The accepted record must tell release owners, platform operators, application
developers, and support operators which channels exist, which states are valid, who owns transitions,
what evidence M1 must prove, and which adjacent initiatives own publication or runtime behavior.

## Primary Personas

| Persona | Need |
|---|---|
| Release owner | See channel taxonomy, go/no-go evidence, and decision records before declaring beta, RC, GA, or patch readiness. |
| Platform operator | Know which artifacts, compatibility records, rollback expectations, and support handoffs are required before publication. |
| Application developer | Understand channel labels and limitations so preview, beta, GA, and patch claims do not overstate supported behavior. |
| Support operator | Inspect customer-safe support routes, known limitations, and rollback or pause evidence for each channel state. |

## Scope In

- Release channel classes for dogfood, private-beta, public-beta, release-candidate, GA, and patch.
- Channel states: proposed, evidence-collecting, go/no-go-review, approved, published, paused,
  superseded, and retired.
- Transition ownership for propose, approve, publish, pause, supersede, retire, and emergency patch
  decisions.
- Required evidence: cutline, artifact provenance, compatibility matrix, known limitations, support
  route, rollback policy, customer communication, and decision record.
- Service, UX, security, and support boundaries for downstream M1 design and contract proof.
- M1 evidence requirements and the follow-up issue gate.

## Scope Out And Non-Goals

- Do not build live deployment promotion automation, rollout execution, traffic shifting, or deploy
  runtime implementation.
- Do not build artifact signing services, package publication runtime, registry storage, or release
  artifact stores.
- Do not generate compatibility matrix results, browser-grid execution, device-lab work, or platform
  certification runtime.
- Do not publish marketing pages, customer email campaigns, or demo assets.
- Do not build support ticket routing, SLA automation, live escalation workflows, or status-page
  publication.
- Do not implement security attestation engines, policy approval runtime, vulnerability workflows, or
  legal/privacy signoff.
- Do not create downstream M1-M4 implementation issues before this M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Release Channels owns taxonomy, states, transitions, evidence fields, and follow-up gate; execution stays later. |
| UX | Release notes and launch messaging consume labels and limitations later; this record does not publish pages or campaigns. |
| Security | Provenance, compatibility, vulnerability, and legal/privacy signoffs remain with owning initiatives. |
| Support | Support can rely on channel state, limitation, rollback, and escalation evidence; ticketing and SLA automation stay separate. |

## Channel Classes

| Channel | Meaning |
|---|---|
| Dogfood | Internal hosted or self-hosted use proving operational readiness before customer claims. |
| Private beta | Invite-only customer or partner use with explicit limitations and support route. |
| Public beta | Publicly accessible beta posture with visible limitation, rollback, and feedback evidence. |
| Release candidate | Near-final release posture waiting on cutline, compatibility, support, and known-limitation evidence. |
| GA | General availability posture requiring durable support, compatibility, provenance, and decision evidence. |
| Patch | Narrow corrective release channel linked to an approved parent channel and rollback posture. |

## Channel States

| State | Meaning | M1 proof expectation |
|---|---|---|
| Proposed | A channel intent exists but required evidence is not collected or accepted. | Schema fixture records channel class, owner, target audience, and missing evidence. |
| Evidence-collecting | Owners are collecting release evidence without claiming publish readiness. | Contract test keeps customer-visible claims blocked while evidence is missing. |
| Go-no-go-review | Decision owners review evidence, blockers, accepted risks, and support posture. | Decision fixture records reviewer role, blockers, risks, expiry, and revisit date. |
| Approved | Decision record permits publication when downstream publishing work exists. | Transition matrix names approval owner and evidence snapshot. |
| Published | Channel is customer-visible and carries linked evidence plus support route. | Support handoff fixture exposes limitation and rollback data. |
| Paused | Channel remains documented but new adoption is stopped pending evidence or rollback decisions. | Pause fixture records cause, owner, and customer communication input. |
| Superseded | Newer channel or patch replaces prior one while preserving audit and support history. | Audit fixture links predecessor, successor, and migration or patch note. |
| Retired | Channel is no longer active and has end-of-support or migration evidence. | Retirement fixture records unsupported request routing. |

## Authoritative Dependencies

- [Release Notes & Upgrade Guide](./release-notes-upgrade-guide.md) supplies customer-visible
  release note, limitation, upgrade, and rollback guidance expectations.
- [Release Artifact Provenance & Retention](./release-artifact-provenance-retention.md) supplies
  artifact identity, provenance, retention, invalidation, and support/debug access evidence.
- [Compatibility Matrix](./compatibility-matrix.md) supplies supported browser, device, platform,
  CLI/bootstrap, and known unsupported-state evidence.
- [Beta Pilot & Feedback Loop](./beta-pilot-feedback.md) supplies beta cohort, feedback, and
  release-candidate exit evidence.
- [Launch Messaging Claims](./launch-messaging-claims.md) supplies public claim evidence boundaries.
- [Support SLA Channels](./support-sla-channels.md) supplies support route and unsupported request
  handling language.
- [Public Status Page & Incident Communication](./public-status-page-incident-communication.md)
  supplies maintenance, incident, and customer communication posture.
- [ADR-0063](./adr/07-portability-extensibility.md#adr-0063),
  [ADR-0064](./adr/07-portability-extensibility.md#adr-0064),
  [ADR-0095](./adr/07-portability-extensibility.md#adr-0095), and
  [ADR-0075](./adr/07-portability-extensibility.md#adr-0075) pin scope, distributed-artifact version,
  and interface-stability boundaries.

## Owning Initiative Dependencies

| Owner | Consumes from Release Channels | Boundary |
|---|---|---|
| Release Channels | Accepted taxonomy, states, transition owners, evidence fields, and M1 proof gate. | This issue defines scope; it does not publish release channels. |
| V1 Release Program & Cutline | Cutline, blocker, risk-acceptance, and go/no-go ownership. | Cutline decisions remain outside this M0 record. |
| Release Artifact Provenance & Retention | Artifact identity, provenance, retention, invalidation, and support/debug inputs. | Artifact stores and publication remain outside this M0 record. |
| Compatibility Matrix | Browser, device, platform, CLI, bootstrap, and unsupported-state evidence. | Matrix generation remains outside this M0 record. |
| Release Notes & Upgrade Guide | Channel state and evidence for release notes, limitations, upgrade, and rollback guidance. | Publication remains outside this M0 record. |
| Beta Pilot & Feedback Loop | Beta cohort, feedback, and release-candidate exit evidence. | Feedback intake remains outside this M0 record. |
| Launch Support Desk & Escalation | Channel state, known limitations, pause/rollback evidence, and customer-safe support handoff. | Ticketing and SLA automation remain outside this M0 record. |
| Public Status Page & Incident Communication | Published, paused, superseded, and retired state inputs. | Status-page and communication workflow implementation remain outside this M0 record. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Channel taxonomy record | Release Channels | Design record | Dogfood, private beta, public beta, RC, GA, and patch definitions are stable. |
| Transition-owner matrix | Release Channels | Reference fixture | Propose, approve, publish, pause, supersede, retire, and patch transitions route to named owners. |
| Evidence checklist fixture | Release Channels | Contract test | Cutline, artifact, compatibility, limitation, support, rollback, communication, and decision evidence is required. |
| Go/no-go decision template | V1 Release Program & Cutline | Audit fixture | Decisions carry evidence links, blockers, accepted risks, owner role, expiry, and revisit date. |
| Publication support handoff | Launch Support Desk & Escalation | Support handoff | Support can inspect customer-safe channel state, limitation, pause/rollback, and escalation data. |
| Scope boundary register | Release Channels | Audit fixture | Deployment, artifact, compatibility, messaging, support, security, and M1-M4 follow-up work route out. |

## HoBo Releases Through HoBo CD

HoBo's own release train (`.github/workflows/release-hobo.yml`) maps the
release-candidate and GA classes above onto `@hobo/cd` Camps, records every
artifact as Freight with provenance, and lets the Camps' realizers publish
([plan 0024](../plans/0024-hobo-cd-swarm-instruction.md),
[`hobo deploy`](../../packages/hobo/CD.md)).

The topology is delivery-as-code:
[`release/hobo-release.delivery.ts`](../../release/hobo-release.delivery.ts)
declares the Yard `hobo-release` with a candidate and a stable Camp per
artifact family and one pipeline per family (`hobo-release-<family>`,
`candidate` -> `stable`, all at once, one HTTP probe per node). Any CD command
reads it with `--yard release/hobo-release.delivery.ts`; `hobo deploy pipeline
apply --file release/hobo-release.delivery.ts` applies the pipelines.

| Family | Camps | Provider (realizer) | Target and credential | What the realizer does |
|---|---|---|---|---|
| `oci` | `hobo-release/oci-candidate`, `oci-stable` | `@hobo/provider-oci-registry` | `ghcr.io`, the workflow `GITHUB_TOKEN` (`env://GITHUB_TOKEN`) | candidate: asserts the release tag on the recorded digest (tag PUT by digest) and observes digest and tag; stable: re-observes |
| `pages` | `hobo-release/pages-candidate`, `pages-stable` | `@hobo/provider-github` | this repository's `gh-pages` branch, `GITHUB_TOKEN` (`contents: write`) | candidate: uploads missing blobs, creates the tree (id computed before upload) and one commit `deploy: <sha>` on the observed head, moved by compare-and-swap; stable: re-observes the tree and its Pages build |
| `npm` | `hobo-release/npm-candidate`, `npm-stable` | `@hobo/provider-npm` | `registry.npmjs.org`, OIDC trusted publishing, provenance required | refuses (typed impedance, below); `npm publish --provenance` stays the npm publisher |

The steps are the `hobo deploy` subcommands, run through the `hobo` package's
own CD composition (`openCdRuntime` with the release topology, as `--yard`
loads it):

1. `freight record`: the manifest names each artifact by sha256 digest, the
   release commit, the run id and the workflow as builder, and a declaration
   (a Bindle with one resource on the family's product) under its canonical
   hash. Tarballs and the Pages tree go into the HoBo artifact store first;
   GHCR images are verified at the registry by the digest main's push logic
   reads back from GHCR (`pushedDigestRef`, or the published tag reused). A
   refusal stops the job.
2. `pipeline apply --file release/hobo-release.delivery.ts`.
3. `promote <freight> --camp hobo-release/<family>-candidate --pipeline
   hobo-release-<family> --node candidate`, then in the tag jobs (or the Pages
   job) the same into `<family>-stable` with `--source-camp`. Each promotion
   is driven the way `hobo serve cd` ticks it (promotions, one conductor pass
   of the Camp, rollouts, verification) until it is PROMOTED or the realizer
   reports BLOCKED. The journal (`HOBO_RELEASE_CD_HOME`) travels between jobs
   as the `hobo-release-freight-<family>` artifact, so `@hobo/cd` enforces the
   candidate -> stable lineage itself.

The verdict is `qualified` (PROMOTED: the realizer converged by its own
observation and the node's probe passed), `impedance` (the realizer refused
with a typed `RESOLVER_PRODUCT_UNSUPPORTED`; only the npm family may keep its
existing publish step on it, and its stable Camp is reported, not promoted) or
`blocked` (anything else, including not finishing). There is no fallback that
publishes on a missing topology or realizer: those refusals block.

Known limits: `docker push` still uploads the image (it is how the build
produces the digest), so the realizer's write is the tag by digest; a
blocked verdict stops attestation, the tag and the GitHub Release but leaves
what `docker push` wrote. npm cannot be realized as declared:
`@hobo/provider-npm` refuses OIDC trusted publishing of scoped names (the
registry routes the token exchange only for the `%2f`-escaped name, which the
transport guard refuses) and the Freight carries no Sigstore bundle (npm's
CLI makes it during `npm publish --provenance`). The Pages realizer commits on
the observed head instead of a force-pushed orphan commit, so `gh-pages`
keeps history.

## Follow-Up Gate

M1/M2/M3/M4 Release Channels design, service, release-note, artifact, compatibility, beta, support,
status-page, security, or publication work must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation issues.
