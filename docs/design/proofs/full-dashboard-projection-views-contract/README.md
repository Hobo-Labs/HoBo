---
type: Design Proof Evidence
title: "HOBO-662 Full Dashboard Projection Views Proof"
description: "S6-07 proof record for Plan 07 dashboard views rendered from projections with WCAG and pseudo-loc gates."
tags: [hobo, proof, dashboard, accessibility, i18n, s6]
timestamp: 2026-07-02T00:00:00Z
---

# HOBO-662 Full Dashboard Projection Views Proof

Branch evidence for S6-07 full dashboard views over `examples/multi-cloud-shop` projections.

## Evidence

- Design source: [`developer-experience.md#plan-07`](../../developer-experience.md#plan-07).
- Accessibility requirement: [`requirements.md` NFR-016](../../../archive/requirements/requirements.md).
- Epic fixture refs: [`cli-mcp-developer-experience`](../../../../src/draft/epic-proofs/cli-mcp-developer-experience/README.md), [`reliability-observability-cost-finops`](../../../../src/draft/epic-proofs/reliability-observability-cost-finops/README.md).
- Executable proof: [`full-dashboard-projection-views-contract`](../../../../src/draft/exp-proofs/ux/full-dashboard-projection-views-contract/README.md).
- Architecture evidence: [`ADR.md`](../../../../src/draft/exp-proofs/ux/full-dashboard-projection-views-contract/ADR.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Every Plan 07 view renders from projections only for `examples/multi-cloud-shop`. | Parser requires all eleven views with `projectionOnly: true` and matching fixture id. |
| Deployments timeline includes replay/time-travel scrubber. | `deployments-timeline` view exposes `scrubberAtSeq` and timeline payload. |
| Topology graph annotates bind edges with connectivity tier and cost. | `topology-graph` edges require `connectivityTier` and `estimatedCostUsd`. |
| Run inspector exposes replay-diff. | `run-inspector` carries `replayDiffStatus` and replay diff payload. |
| Registry browser shows Forge provenance. | `registry-browser` providers include `forgeCertification` and `provenanceDigest`. |
| WCAG 2.1 AA automated audit passes. | `auditWcag21Aa` returns `passed: true` with zero violations. |
| Pseudo-localization test passes (200% length, RTL). | `auditPseudoLocalization` validates `dir: rtl` and 2x expansion. |

## Adversarial Evidence

Classifier rejects production `apps/dashboard` runtime, live Gateway streams, and provider API work.

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/full-dashboard-projection-views-contract test
```

## Maintenance

`pnpm-lock.yaml` registers `src/draft/exp-proofs/ux/full-dashboard-projection-views-contract`
as a workspace importer so frozen-lockfile CI includes the proof package after merge.
