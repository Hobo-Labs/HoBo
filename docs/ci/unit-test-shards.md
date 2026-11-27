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
The fleet store job has a 40-minute limit to leave more time for database tests
after a slow dependency install.

The AWS budget emulator tests exercise priced and unpriced admission when a
provider operation has an uncertain outcome.

The release integration gate is skipped when a draft's shards are intentionally
skipped. Ready pull requests and merge groups still require successful shards.
