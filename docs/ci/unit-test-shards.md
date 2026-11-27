---
type: Maintenance guide
title: "Root unit test shards"
description: "Maintaining the Turbo inputs for root unit test shards."
tags: [ci, tests]
---

# Root unit test shards

Each root unit test must be an input of its assigned Turbo shard. The first
shard includes `test/fleet-enrollment-scorecard.eval.test.ts`, so editing that
test invalidates the cached result. Run `scripts/test/unit-test-coverage.test.ts`
to check the assignments against Turbo's dry-run graph.

The fleet enrollment workflow runs both jobs for ready pull requests and for
drafts explicitly labeled `ci:run-draft-checks`. New runs wait for earlier runs
on the same ref instead of canceling them.
