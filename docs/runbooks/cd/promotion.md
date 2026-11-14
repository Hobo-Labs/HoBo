---
type: Runbook
title: "HoBo.CD runbook: Promotion"
description: "Promotion saga, previews, Trails sequencing and rollback. Assembled from the Runbook section of packages/cd/src/promotion/README.md."
tags: [hobo, cd, runbook, promotion]
---

# HoBo.CD runbook: Promotion

Promotion saga, previews, Trails sequencing and rollback. This page is assembled from the **Runbook** section of `packages/cd/src/promotion/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom (reason code) | Meaning | Action |
|---|---|---|
| `lineage-unsatisfied` | The Freight is not available to the node (not qualified upstream or not soaked). | Promote it through the upstream node, wait for `required_soak_ms`, or record an expiring `freight.Approved` hotfix for the Camp (`FreightLedger.approve`, governed `freight.approve`). |
| `shadow-required` | A Rail is promoted to ENFORCE without a qualified INFORM node upstream. | Bind it in INFORM first and let posture verification qualify it. |
| `promotion-superseded` | Newer Freight was queued for the Camp before this one applied. | Nothing; the newest proceeds. |
| State `AWAITING_WINDOW` (`window-closed`) | A freeze is active; nothing applies (I17). | Wait for the window, or record a governed `window.Overridden`. |
| State `AWAITING_APPROVAL` | A proposal, a `require-approval` gate effect, or `approval_required`. | Approve through `PromotionService.approve` (the `deploy` verb surfaces it; a human or granted principal), answer the A2H handoff, or the webhook approver's callback. Unanswered requests expire after 24 h. |
| `promotion-gate-denied` | The gate denied; the following reasons name the gate (`policy`, `contracts`, `residency`, `trust`, `posture`). | Fix each named cause; for `unknown-running-versions` rebuild the Camp's running-contract snapshot. |
| `ownership-conflict` | A posture rule contradicts a Set-owned value and the Delta keeps it. | Change the declaration of the named resource, or retire the rule. |
| `fanout-budget-exceeded` | The fan-out's Camp count or summed cost quotes exceed the Rail/entitlement/Station budget. | Narrow the placement or raise the budget; nothing started. |
| `promotion-verification-failed` | Verification ended FAIL or INCONCLUSIVE; the Camp was rolled back. | Inspect the verification checks named in the promotion's reasons; promote fixed Freight. |
| `rollback-past-contract` | Trails already contracted the old data shape. | Run the compensating Trails `expand` named in the remediation, then roll back. |
| `rollback-no-predecessor` | The Camp has no earlier Set. | Exposure was zeroed; promote known-good Freight or tear down with `hobo down`. |
| `promotion-trails-unavailable` | The Freight names a migration but no Trails sequencer is composed. | Compose `createTrailsMigrations` (WP18 does this in `hobo serve cd`). |
| `promotion-delta-refused` / `delta-overlap` | Another Delta is open for the Camp. | Find it with `DesiredStateReader`; a promotion that died mid-flight is resumed by `tick`; reject an abandoned Delta. |
| `hobo.cd.promotion.step_error` rising | A port is throwing (transient). | Check the named dependency (orchestrator, verification, approval endpoint); promotions resume on recovery. |
| `approval-signature-invalid` (401 on the callback) | The callback token was not signed with the configured secret. | Check the approver uses the token it received; rotate the secret ref if leaked (old tokens then fail closed). |
| `preview-teardown-refused` | The gate refused a preview's teardown. | Fix the gate causes; `expirePreviews` retries each sweep. |
