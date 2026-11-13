---
type: Runbook
title: "HoBo.CD runbook: Policy delivery and posture"
description: "Rail bindings, shadow decisions and compliance. Assembled from the Runbook section of packages/cd/src/posture/README.md."
tags: [hobo, cd, runbook, posture]
---

# HoBo.CD runbook: Policy delivery and posture

Rail bindings, shadow decisions and compliance. This page is assembled from the **Runbook** section of `packages/cd/src/posture/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **A Rail promotion to ENFORCE is refused with `shadow-required`.** Check the
  Rail pipeline: the Freight must have `freight.Qualified` on a node whose
  `policy_mode` is `INFORM` (`cd-freight-<id>`), or an unexpired
  `freight.Approved` for the Camp. Let the INFORM node's verification pass
  (noncompliant ratio ≤ 2 %, 0 divergences over 24 h by default) or record an
  audited approval.
- **INFORM verification fails with no data.** The candidate is not evaluated:
  the posture service needs a status observation for the Camp and a
  `candidateRail` resolver (WP18 wires it from the Rail registry). Without the
  resolver candidate records are `UNKNOWN` with ratio 1 — by design.
- **Rolling back a Rail.** Roll back the promotion that bound it;
  `CampPolicy.restore` returns the previous enforced digest. If it reports
  `policy-restore-superseded`, roll back the named later promotion first.
- **A Camp is stuck `POSTURE_COMPLIANT=false` with `ownership-conflict`.** The
  Set itself declares the violating value. Change the Bindle declaration (a
  new Freight) or retire the rule from the Rail's posture packs; the gate
  refuses promotions that keep the violation until then.
- **Remediation Deltas never apply.** Look for `posture.RemediationProposed`
  with `posture-delta-refused` or `posture-enforce-unauthorized`; check the
  open Delta on the Camp's spec stream and the grant for `posture.enforce`.
  An agent-run posture service only proposes (`proposal: true`).
- **Compliance looks stale.** Evaluation runs every `compliant_interval_ms`
  (default 1 h) or `noncompliant_interval_ms` (default 5 min). Check
  `hobo.cd.posture.no_observation` (no reconcile observation) and
  `hobo.cd.posture.pack_invalid` (a pack did not parse).
- **Export evidence.** `complianceOscal(await posture.compliance(campId))`
  gives an OSCAL 1.1.2 assessment-results document.
