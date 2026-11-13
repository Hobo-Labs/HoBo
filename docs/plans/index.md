# HoBo plans

Directory listing for the records kept here: review findings, maintenance notes, and the delivery state and dispatch log the `sdlc` tooling writes. Plans themselves are working documents and are not kept in the repository (see [`AGENTS.md`](../../AGENTS.md), "Plans are not committed").

## Documents

| File | Type | Purpose |
|---|---|---|
| [`0000-requirements-suite-review.md`](./0000-requirements-suite-review.md) | Review Findings | Historical `/improve` audit of the requirements suite at b3cf64d, reconciled with PR #1 review. |
| [`0002-public-launch-gap-analysis.md`](./0002-public-launch-gap-analysis.md) | Review Findings | Public-launch gap audit at c14955f3 against HoBo's own launch criteria (readiness dashboard, go/no-go, blocker taxonomy), with a prioritized critical path. |
| [`0004-main-gate-repair.md`](./0004-main-gate-repair.md) | Maintenance Note | Repair record for the red main gate: pnpm-lock.yaml drift, the 99-file Biome format backfill, the account-level Actions outage, and the undeclared-workspace-dependency fixes that restored the package build/test lanes. |
| [`0009-legal-compliance-audit.md`](./0009-legal-compliance-audit.md) | Review Findings | Legal/compliance audit at a9555d7c: third-party provider terms (GitHub/Blacksmith/Depot) against the `maximize-credits` objective, outbound/inbound licensing hygiene, trademark use, site terms/privacy, with a prioritized remediation order. |
| [`0011-ship-readiness-gap-review.md`](./0011-ship-readiness-gap-review.md) | Review Findings | Deep ship-readiness gap review at 9d0233d2: three ship targets (OSS public / local-first npm / hosted beta-GA), stage maturity, CI runner outage, HONEST SCOPE inventory; supersedes 0002 on engineering scale. |
| [`0013-post-merge-ship-gap-review.md`](./0013-post-merge-ship-gap-review.md) | Review Findings | Post-merge gap review at main `61cfcdb9` after squash of #952–#956: agent remediations on main, residual H-* still open, Targets A/B/C re-score. |
| [`0014-repo-projects-audit.md`](./0014-repo-projects-audit.md) | Review Findings | In-repo projects audit (packages/examples/draft only): maturity tiers, families, ranked gaps; stations/yards README hygiene wave. |

## Conventions

- No plan is committed. A plan lives in the root `plans/` folder, which git ignores, or outside the repository; `pnpm run plans:guard` refuses one that is staged or tracked.
- A record kept here (review findings, a maintenance note, delivery state) takes the next free zero-padded `NNNN-slug.md` and carries OKF frontmatter with a non-empty `type:` that is not a plan type.
- This `index.md` stays a bare directory listing with no frontmatter (run `pnpm run docs:okf`).
