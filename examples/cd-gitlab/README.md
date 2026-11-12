# HoBo.CD from GitLab CI

GitLab CI builds. HoBo.CD discovers and delivers (plan 0024, D3, D4, D10).

- **Two subscriptions, one Freight.** CD reads `deploy/**` and
  `hobo.bindle.ts` from Git over smart-HTTP protocol v2. It does not need a
  Git binary or the GitLab API. It reads the API image from the GitLab
  registry over the OCI distribution API. `SAME_COMMIT` assembly joins both
  at one commit, so a config-only change is new Freight that carries the same
  artifacts.
- **Trusted publishing.** `publish-freight` sends a GitLab `id_token` for
  audience `hobo.cd`. CD trusts it only when it comes from the project's
  protected `main` branch. The token schedules a poll and never creates
  Freight on its own (I15).
- **Pipeline.** `review` is a preview node: each Freight gets a Camp that
  expires after 24 h. `staging` is the qualification node. `prod` uses
  blue/green with a two-hour soak after staging qualifies, and holds during
  the quarter-end finance freeze.

| File | What |
|---|---|
| `src/hobo.delivery.ts` | Source (Git + OCI), trusted publisher, freeze window, pipeline |
| `ci/.gitlab-ci.yml` | The CI file to copy into the Bindle's repository |
| `test/delivery.test.ts` | Delivery-records conformance, wire round-trip, and the trust and lineage pins |

## Run

```sh
pnpm --filter @hobo/example-cd-gitlab test
hobo deploy pipeline apply --file examples/cd-gitlab/src/hobo.delivery.ts
hobo deploy source poll billing
```

## Runbook

- **A Git poll is refused with a source refusal.** The smart-HTTP endpoint
  refused the `credentialRef`, or the host is unreachable. The poll backs
  off (1 s up to 10 min) and keeps its cursor. Fix the credential in the
  reconciler's vault and run `hobo deploy source poll billing`.
- **No Freight appears after a push.** Check that both subscriptions saw
  the same commit. `SAME_COMMIT` waits for the image tagged
  `main-<sha12>` before it assembles anything.
- **Prod holds near quarter end.** `quarter-end` is a FREEZE for Camps
  labelled `domain=finance`. Promotions wait (`AWAITING_WINDOW`). An urgent
  change needs a governed `hobo deploy window override` (at most 4 h).
