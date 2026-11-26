---
type: CI Performance Finding
title: "Finding 20: a workspace-wide change linted every package and failed on old findings"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 20: a workspace-wide change linted every package and failed on old findings

PR #1667 changed root `package.json`, so affected-lanes selected all 795 packages; turbo ran every package's `lint` (`biome check .`) with `--continue=never` and failed on `@hobo/pack-postgres-oci` (7 errors in files the PR never touched).
Main had 53 such errors across 9 packages because Main full gate never runs package lint.
This cleanup fixes them; a follow-up commit in the same PR makes PRs and main lint only changed files.
The rift debris test was host-tier-dependent and is now pinned to overlayfs, with a copy-tier sibling proving cloned files are parked.
