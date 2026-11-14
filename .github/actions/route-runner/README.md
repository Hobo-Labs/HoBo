# Route runners

The first job of every routed workflow. It picks the runner label the run's
jobs ask for: the hobo fleet, an enrolled local box, or GitHub-hosted. The
action never fails. When the script cannot run, GitHub-hosted is chosen,
because this step is running there.

## What decides

1. **The routing slip** ([ADR-0181](../../../docs/design/adr/routing-slips.md)). The
   box relay writes it to `refs/hobo/routing-slip`. The script reads it with
   the job's own token and `contents: read`: `GET /git/ref`, then
   `GET /git/commits`, three seconds in all. A slip that has not expired,
   names this repository and names only labels in
   `runnerRouting.labels` decides the run's class (`pr`, `fork` or `trunk`).
2. **The queue rule**, when there is no usable slip. It reads GitHub's queue
   as before slips, and a `hobo-ci-route-fallback` warning says why.

The box's issuer computes each class's reason from `fleetVerdict` on its
local fleet view (ADR-0183):

| Verdict | Slip reason | Route |
|---|---|---|
| `OPEN` | `fleet-open` | the fleet |
| `BUSY` | `fleet-busy` | the fleet. A box that is only busy is never refused (R4) |
| `NO_MEMBER` | `no-node` | refused: the local box when enrolled, else GitHub-hosted |
| `NO_CAPACITY` | `no-capacity` | refused, the same way |

There is no verdict fetch from the route job, and no repository variable,
input or environment variable carries routing. The slip carries no slot
count, so shard planning reads none from it.

## Nothing installed

The script runs from a sparse checkout with Node only. It imports
`scripts/ci/runner-routing.mts` and nothing else, and no package source, so a
rename inside a package cannot stop it. Every routed workflow checks out:

```text
.github/actions/route-runner
scripts/ci/route-runner.mts
scripts/ci/runner-routing.mts
.hobo/ci.json
```

`scripts/test/route-runner.test.ts` checks each routed workflow against the
files the script loads, and runs the script from a copy of only those files.
