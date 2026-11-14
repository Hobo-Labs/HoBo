# Vercel credential evidence

The manually dispatched `HoBo Vercel credential evidence (read-only)` workflow
checks the explicitly named repository secrets `VERCEL_TOKEN` and
`VERCEL_ACCESS_TOKEN` on main. It reports whether each exists, then uses the
Vercel provider SDK to perform at most one bounded, read-only request per
present candidate for the enrolled `hobo-ci` project and team. It reports
only whether that exact project read was verified; values, token fingerprints
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
