---
type: CI Runbook
title: "PR supersession review"
description: "How the supersession job identifies candidates without closing active stack layers."
tags: [hobo, ci, pull-requests, merge-queue, stacks]
---

# PR supersession review

A commit can be an ancestor of another branch even when a later merge dropped its changes. Review
stacked pull requests bottom-up; do not close a lower layer based on ancestry alone.

| Piece | Where |
| --- | --- |
| Script (Node builtins and Git only) | [`scripts/ci/pr-supersession.mts`](../../scripts/ci/pr-supersession.mts) |
| Tests | `scripts/test/pr-supersession.test.ts` |
| Workflow (every push to `main`, hourly, and on dispatch) | [`.github/workflows/pr-supersession.yml`](../../.github/workflows/pr-supersession.yml) |

Automatic runs only report candidates. The script also defaults to a dry run when invoked directly.
After reviewing the changes and all feedback, an operator can dispatch the workflow with `dry-run`
set to `false`. Only same-repository PRs against `main` are considered. A candidate must either be
an exact-head duplicate of an older open PR or have its head in `main`, and its changed paths and
modes must still match the carrier. An empty or uncertain comparison is not proof. Distinct stack
layers remain open. The source and carrier snapshots are rechecked immediately before closing.
Branches are never deleted.

Closes are paced three seconds apart. A `403` or `429` stops the run, as does the 15-minute
closing budget. The next automatic run reports the remaining candidates without changing them.
