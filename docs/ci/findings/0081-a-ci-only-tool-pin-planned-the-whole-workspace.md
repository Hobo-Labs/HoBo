---
type: CI Performance Finding
title: "Finding 81: a CI-only tool pin planned the whole workspace"
description: "Adding syft to mise.toml made the test planner schedule every workspace; only tools a package task runs now widen."
tags: [hobo, ci, performance, planner, mise]
---

# Finding 81: a CI-only tool pin planned the whole workspace

## Symptom

A branch that added one line to `mise.toml` (`syft = "1.56.0"`, an SBOM tool
for the release pipeline) planned its workspace tests as:

```
dependent-tests: whole workspace (workspace-wide input changed: mise.toml)
```

That is all 795 workspaces across eight shards, for a pin no package build or
test executes. The same edit sat on two open branches at once.

## Cause

`scripts/ci/affected-lanes.mts` lists `mise.toml` as a global input: a change
to it runs every package lane, and the merge-group and main gates read
`mise.lock` the same way. That is right for `node`, `pnpm`, `turbo` and `cue`,
which package tasks run. It is wrong for `gitleaks`, `shellcheck` and `syft`,
which only the runner image, the secret scan, the shell lint and release
tooling use.

## Fix

The planner compares `mise.toml` and `mise.lock` at the diff base and at the
head with the pins and lock blocks of CI-only tools removed. Equal remainders
mean the file is not a package-lane input for this diff. The list of CI-only
tools is explicit, so a new tool widens until someone adds it after checking
that no package task runs it. An unreadable base, an edit outside `[tools]`,
and any other tool still run the whole workspace.

Tests that read `mise.toml` still run: the file stays in the changed set, and
the test planner follows it into any package whose test closure names it (the
runner image contract in `@hobo/ci-gh-actions`). The runner image job has its
own path filter and rebuilds as before.

## Result

The same diff replayed through the planner:

| | Before | After |
|---|---|---|
| Workspace tests | whole workspace, 795 units | 4 whole suites, 5 subsets |
| Main gate scope | `repo-wide` | `affected` |

## Verification

`scripts/test/affected-lanes.test.ts` (`toolchain pins`) covers CI-only pins in
both files, each runtime tool, an unlisted tool, a non-`[tools]` edit and a
missing base.
