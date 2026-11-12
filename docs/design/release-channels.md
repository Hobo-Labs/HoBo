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

## HoBo.CD: Freight is not a release channel

HoBo.CD ([ADR-0180](./adr/01-architecture-core.md#adr-0180) D2; [continuous-delivery.md](./continuous-delivery.md)) names its promotion unit **Freight** precisely to
avoid this document's vocabulary:

- A **release channel** (`stable`, `beta`, a pinned line) is a moving name
  that users or Camps subscribe to; it points at different versions over time.
- **Freight** is one immutable, content-addressed version of one Bindle (or
  one Rail). It never changes and is never rebuilt; a delivery pipeline decides
  which Camps it may reach.

The two compose without overlap: a channel can be implemented as a pipeline
node whose qualified Freight is "what the channel points at", but Freight
itself carries no channel, and promoting Freight never moves a channel unless
the channel is defined that way.

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
release-candidate and GA classes above onto two `@hobo/cd` Camps and records
every artifact as Freight with provenance
([plan 0024](../plans/0024-hobo-cd-swarm-instruction.md),
[`hobo deploy`](../../packages/hobo/CD.md)).

| Channel | Camp | What publishes on it | Gated step |
|---|---|---|---|
| Release candidate | `hobo-release/candidate` | npm tarballs (`alpha`/`next` dist-tag), GHCR images by digest | `npm publish`; attestation and the tag job after the GHCR push |
| Stable | `hobo-release/stable` | the signed git tag, the GitHub Release, the Pages bundle | `push-release-git-tag`, `create-github-release`, the gh-pages push |

Each family (`npm`, `oci`, `pages`) is the Bindle `hobo-release-<family>`; its
pipeline chains `candidate` -> `stable`. The steps are the `hobo deploy`
subcommands, run through the `hobo` package's own CD host:

1. `freight record`: the manifest names each artifact by sha256 digest, the
   release commit, the run id and the workflow as builder. Tarballs and the
   Pages tree index go into the HoBo artifact store first; GHCR images are
   verified at the registry. A refusal stops the job.
2. `pipeline apply` of `hobo-release-<family>`.
3. `promote <freight> --camp hobo-release/candidate`, then in the tag jobs (or
   the Pages job) `promote <freight> --camp hobo-release/stable`. The journal
   (`HOBO_RELEASE_CD_HOME`) travels between jobs as the
   `hobo-release-freight-<family>` artifact, so stable sees the candidate
   promotion of the same Freight.

The verdict is `qualified` (promoted), `gap` (refused only with a typed code
for missing topology or realizer: `pipeline-unknown-camp`,
`promotion-resolve-failed`, `planning-camp-unknown`,
`compose-realizer-missing`) or `blocked` (anything else). The existing publish
step runs on `qualified` or `gap`; `gap` prints a warning naming the codes.
Until the pipeline applies, stable additionally requires a journaled,
non-blocked candidate promotion of the same Freight
(`release-lineage-missing` otherwise). Which targets have no realizer is
listed in the [live provider matrix](./live-provider-matrix.md#hobos-own-release-targets-release-freight-through-hobocd).

Known limits: the GHCR push happens before the candidate verdict (registry
verification needs the pushed digest), so a blocked verdict stops
attestation, the tag and the GitHub Release but leaves the version tag in
GHCR. The `hobo` binary's shell parser does not yet pass `--file`/`--camp` to
`hobo deploy`, so the release scripts call the verb's host
(`openDefaultCdHost`, `runCdDeploySubcommand`) directly.

## Follow-Up Gate

M1/M2/M3/M4 Release Channels design, service, release-note, artifact, compatibility, beta, support,
status-page, security, or publication work must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation issues.
