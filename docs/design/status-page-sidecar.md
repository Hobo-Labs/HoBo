---
type: Reference
title: "Status-page sidecar"
description: "The default availability surface every deployment gets: three availability slices, the event-driven replay-safe architecture behind them, and the ADR-0145 trait classification that makes it default-on with an opt-out."
tags: [hobo, design, status-page, availability, sidecar]
---

# Status-page sidecar — default availability surface for every deployment

> Implementation record for the ADR-0077 / [Plan 49 §C](./developer-experience.md#plan-49)
> status-page surface. Production code lives in
> [`packages/status-page`](../../packages/status-page/README.md); a Station
> sidecar host is the composing host's job. The M0 scope contract is
> [`public-status-page-incident-communication.md`](./public-status-page-incident-communication.md)
> (HOBO-497); this build keeps its exclusions (no hosted publisher, no
> subscriber management, no SLA promises).

## Why a default status page

HoBo requires OTel-native observability for every deployment (ADR-0046,
ADR-0083). A status page is the cheapest trust dividend of that requirement:
if the signals are already flowing, every scope can have a
githubstatus.com-style page **out of the box** with no extra authoring.

Inspiration and interop: githubstatus.com and status.claude.com are Atlassian
Statuspage instances; instead of adopting a heavyweight OSS status-page stack
(cState/Hugo, Upptime/GitHub Actions, Gatus), `@hobo/status-page` renders its
own static HoBo Rubberhose page **and emits Statuspage-v2-compatible JSON**
(`/api/v2/summary.json`, `/api/v2/status.json`) so the existing ecosystem of
status widgets and clients can consume HoBo pages unchanged.

## Three availability slices (one page each)

| Scope | Components | Source |
| --- | --- | --- |
| **Station** | Control-plane capability surfaces on one Station (dashboard, Evidence, otlp, evals, rollout, experiment, kms, history sidecars) | Live loopback probes of the sidecar fleet, folded as synthetic `slo.Measured` signals |
| **Primitives** | The closed Bindle-primitive vocabulary (`web`, `api`, `kv`, …) from `@hobo/capability-profiles` (no fourth duplicated list) | `slo.Measured` / `incident.*` events keyed to the primitives scope |
| **Project / Bindle** | User-centric: one page per Bindle (an app in the app portfolio) plus one page per Project rolling up its Bindles and their configured service dependencies (`b.external`, `b.container`) | Event projection keyed `project:<id>` / explicit `scopeKey` |

## Architecture (event-driven, replay-safe)

- **Projection**: `createStatusPageProjection()` is a pure `defineProjection`
  fold over `slo.Measured`, `incident.Opened/Updated/Resolved`,
  `maintenance.Scheduled/Updated`, `statuspage.Published/Unpublished/
  IncidentPosted` — the [Plan 49 event budget](./developer-experience.md#plan-49);
  grouping and availability add no event families
  ([`event-families.md`](./event-families.md) already registers `statuspage.*`).
  No clocks, no randomness, no IO in the fold (ADR-0086).
- **Freshness fail-safe**: wall-clock enters once, at evaluation
  (`toStatusPageModel(row, { evaluatedAt })`). A component without a signal
  inside the freshness budget renders **delayed/unknown — never stale
  operational** (ADR-0077 §4).
- **Publish gate**: public pages require a declared-public component
  allowlist; a redaction denylist scans the *rendered output* (incident free
  text included); the served bytes are content-hashed onto the
  `statuspage.Published` audit event; the public banner is recomputed from
  public components only so internal health never leaks.
- **AvailabilityView (ADR-0078) stays internal-only** — deliberately not
  rendered on any page this package produces.

## Default-on with opt-out (ADR-0145 trait classification)

The Bindle trait is **platform-applied with opt-out** — the same class as
Session Replay (ADR-0137), so no new attachment mechanism is introduced:

- **Read-side default**: `deriveBindleStatusPlan(bindle)` yields a page plan
  for every Bindle with no annotation required, keeping canonical manifests
  and deployment-plan hashes untouched.
- **Configuration**: `.with(statusPage({ project, label }))` groups the page
  under a project (the ADR-0077 grouping dimension — `project` is a legal
  platform-annotation key; `projectId` remains banned);
  `.with(statusPage({ enabled: false }))` excludes a resource's component.
  `status-page` is an allowlisted platform option next to `session-replay`,
  and repeated `.with()` replaces rather than stacks.
- **Station default**: the status sidecar is a `kind: "sidecar"` Station
  capability with `provenance: "default"` (present unless observed absent).
  A host that serves it treats it as best-effort — a broken status listener
  never takes the occupancy down.

## Edge cases handled (tested in `packages/status-page/test/`)

Out-of-order incident events (resolved-before-opened tombstones, duplicate
opens, lifecycle regressions), late SLO samples, malformed payloads,
attainment clamping, 90-day bounded history, empty scopes rendering honest
unknown pages, incidents on unregistered components, allowlist-filtered
public banners, and slug traversal in the static site writer.

## Verification

`packages/status-page` ships proto + CUE wire forms
(`data-models/status_page.*`), a consumer pact
(`contracts/pacts/status-page-projection.pact.json`), a DESIGN.md bound to
HoBo Rubberhose (ADR-0149) with a design-lint test over rendered output, and
92 unit tests.
