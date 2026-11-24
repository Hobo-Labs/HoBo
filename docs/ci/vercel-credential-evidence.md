---
type: Evidence
title: "Vercel credential evidence"
description: "Read-only verification of configured Vercel credential access to the enrolled project."
tags: [hobo, ci, vercel, evidence]
---

# Vercel credential evidence

The manually dispatched `HoBo Vercel credential evidence (read-only)` workflow
checks the explicitly named repository secrets `VERCEL_TOKEN` and
`VERCEL_ACCESS_TOKEN` on main. It reports whether each exists, then uses the
Vercel provider SDK to perform at most one bounded, read-only request per
present candidate for the `hobo-ci` project, by name: the project and team
ids are private store coordinates and are not in the repository. It reports
only whether a read of a project named `hobo-ci` in a Vercel team was verified; values, token fingerprints
and provider response bodies never appear in its result. It makes no changes
and does not contact the relay.

Run this workflow on main with:

```sh
gh workflow run vercel-credential-evidence.yml --ref main
```

An authorized project read does not establish deployment or account mutation
permission, quota, budget, custody enrollment or runtime health. Both
`can-deploy` results remain unevaluated until the enrolled supervisor checks
the complete target set.
