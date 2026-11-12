# HoBo.CD from GitHub Actions

GitHub Actions builds the image. HoBo.CD delivers it. This example shows the
workflow holding no HoBo credential at any point (plan 0024, D3):

- **Trusted publishing.** The release job proves its identity with a GitHub
  OIDC token (`id-token: write`). CD trusts the token only when its claims
  exactly match the `TrustedPublisherRecord` in `src/hobo.delivery.ts`:
  issuer, audience, `repository`, `workflow_ref` and `environment`.
- **Provenance.** The SLSA generator signs an in-toto statement through
  Sigstore. The source requires that provenance and pins both the builder id
  and the signer identity (the release workflow).
- **Pull first.** CD polls GHCR on its own. The push from the workflow only
  nudges a poll. Freight is created only from a verified read: the digest at
  its coordinate plus verified provenance (I15).
- **Pipeline.** `dev` → `staging` (canary at 5/25/50/100) → `prod` (lineage
  from staging, a one-hour soak, an approval, a canary and a weekend freeze).
  Verification is a Mann–Whitney comparison of canary against baseline at
  MEDIUM sensitivity and fails when there is no data (D9).

| File | What |
|---|---|
| `src/hobo.delivery.ts` | Source, trusted publisher, change window and pipeline records |
| `ci/release.yml` | The workflow to copy into the Bindle's `.github/workflows/` |
| `test/delivery.test.ts` | Delivery-records conformance, wire round-trip, and the trust pins |

## Run

```sh
pnpm --filter @hobo/example-cd-github-actions test
hobo deploy pipeline apply --file examples/cd-github-actions/src/hobo.delivery.ts
hobo deploy source poll shop-ghcr
hobo deploy status --pipeline shop
```

## Runbook

- **The push is refused with a publisher refusal.** The token's claims did
  not match the record. Compare `repository`, `workflow_ref` and
  `environment` with the job. Claims are exact-match, and wildcards are
  refused.
- **The image is skipped with a provenance reason.** The bundle is missing,
  or its signer or builder is not the one pinned. Re-run the `provenance`
  job, or update the pins in a reviewed change.
- **Prod is refused with `lineage-unsatisfied`.** That Freight has not been
  qualified in staging, or its soak has not elapsed. For a true hotfix, use
  `hobo deploy freight approve` (a governed approval that expires within
  72 h).
- **A rollout holds over the weekend.** `weekend-freeze` is closed. The
  rollout resumes at the next stage boundary once the window opens. Rollback
  stays allowed throughout.
