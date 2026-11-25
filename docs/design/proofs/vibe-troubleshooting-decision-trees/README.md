---
type: Reference
title: "Vibe Troubleshooting Decision Trees Proof"
description: "Source issue: HOBO-553."
tags: [hobo, design]
---

# Vibe Troubleshooting Decision Trees Proof

HOBO-553 creates fixture-backed troubleshooting decision trees for install,
auth/SVID, plan, deploy, policy, stale evidence, unsupported request, and support
handoff paths.

The executable proof lives in
`src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees`.

## Acceptance Evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Decision trees cover symptom, diagnostic command or evidence, owner, safe next action, customer-safe wording, and escalation route. | `VIBE_TROUBLESHOOTING_DECISION_TREES.cases` carries those fields and parser tests require every entry to populate them. |
| Fixtures include install failure, missing auth/SVID, blocked plan, deploy failure, policy denial, stale evidence, and unsupported request. | `REQUIRED_DECISION_TREE_CASES` pins those cases plus happy and support handoff paths. |
| Target package and proof path are stable. | Package path is `src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees`; this proof note is `docs/design/proofs/vibe-troubleshooting-decision-trees/README.md`. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | Tests assert each path state exists, `REQUIRED_PROOF_MODES` lists live, simulated, reference fixture, and scope-out labels, and each case carries accessibility notes. |
| Scope stays out of diagnostic automation, support queues, live repair, customer data, and launch claims without evidence. | `classifyTroubleshootingScope` and tests fail closed for those scope-out proposals. |

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-troubleshooting-decision-trees test
```
