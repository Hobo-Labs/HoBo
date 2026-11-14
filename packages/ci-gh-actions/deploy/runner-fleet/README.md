# HoBo's runner fleet, delivered by HoBo CD

HoBo's self-hosted GitHub Actions runner hosts (the box worker, mesh nodes and
local runners serving `hobo`, `hobo-trunk` and `hobo-local-host`) are Camps
that `@hobo/cd` manages, the same way any Bindle's Camps are
([continuous delivery](../../../../docs/design/continuous-delivery.md),
[`hobo deploy`](../../../hobo/CD.md)). Job routing does not change: which label
a job asks for and which host takes it are still decided by the route job and
the relay ([runner queue](../../../ci/RUNNER-QUEUE.md)). CD decides which
runner image and controller version each host runs, and moves the fleet to a
new one a host at a time.

| File | What it is |
|---|---|
| [`hosts.json`](hosts.json) | The declared runner hosts: mesh node id, kind (`box-worker`, `mesh-node`, `local-runner`), the runner labels it serves, and its ring (`pilot` or `fleet`). |
| [`hobo.delivery.ts`](hobo.delivery.ts) | The delivery module `hobo deploy pipeline apply --file` applies; built from `hosts.json` by `runnerFleetDelivery` in [`src/runner-fleet-delivery.ts`](../../src/runner-fleet-delivery.ts). |
| [`hobo-cd-agent.service`](hobo-cd-agent.service), [`agent.env.example`](agent.env.example), [`agent.runner-host.json.example`](agent.runner-host.json.example), [`agent.local-runner.json.example`](agent.local-runner.json.example) | The CD agent each runner host runs beside its controller, and what it is told about its host (`HOBO_CD_RUNNER_HOST`). |

## What the delivery module declares

- **Camps.** One per host, `hobo-ci-runners/<host id>`, labelled
  `hobo.ci/runner-fleet=true`, `hobo.ci/runner-ring=<ring>`,
  `hobo.ci/runner-host=<kind>` and `hobo.ci/serves-<label>=true|false`
  (`runnerFleetTopology`, exported as the module's `camps`). The host id is the
  host's mesh node id (`HOBO_CI_MESH_NODE_ID`), lowercase.
- **Camp set** `hobo-ci-runner-fleet`, by the `hobo.ci/runner-fleet` label, for
  the `hobo-ci-runner-fleet` Bindle (`HOBO_CI_COMPONENTS.runnerFleet` in
  `@hobo/cd/compose`). Adding a host is a topology change, not a pipeline change.
- **Freight source** `hobo-ci-runner-image`: an `OCI_REPOSITORY` subscription on
  `ghcr.io/hobo-labs/hobo/hobo-ci-worker`, `LEXICAL` selection of tags matching
  `^release-[0-9]{14}-v[0-9a-f]{12}$`, read with `env://HOBO_CI_GHCR_READ_TOKEN`
  on the Station. [`push-ci-runner-image-ghcr.mts`](../../../../scripts/ci/push-ci-runner-image-ghcr.mts)
  pushes one such tag (`release-<UTC yyyymmddHHMMSS>-<content key>`) the first
  time it publishes a version, so publish order is lexical order and one
  version is one Freight. The content key alone (`v<12 hex>`) has no order.
  With `releaseIndexBase` (from `HOBO_CI_RUNNER_RELEASE_INDEX`), the same
  source also reads the controller releases' indexes
  (`index.hobo-ci-worker-release.json`, `index.hobo-ci-local-runner-release.json`,
  HTTP_INDEX, `FUNCTION_BUNDLE`) and assembles them `SAME_VERSION` with the
  image, so one Freight carries a version's image and its releases.
- **Station Rail** `hobo-ci-runner-fleet` (`runnerFleetRail`, exported as the
  module's `rails`): it binds the `hobo-ci-runner-fleet` Camp set and approves
  exactly the provider the fleet's Camps declare, `self-hosted`. Placement
  reads it as the Station's Rail (empty `stationId`: the composed Station)
  while the Station's journal has no Rail of its own active; a Rail the
  journal activated wins, and its providers then come from that Rail. Without
  a Rail placement fails closed (`rail-providers-unknown`).
- **Placement** `hobo-ci-runner-fleet`: every eligible host, in a `pilot` group
  (at most one host) and then a `fleet` group.
- **Pipeline** `hobo-ci-runner-fleet`, node `fleet`: new Freight from the source
  promotes automatically (`AUTO_PROMOTION_NEWEST`) through a
  `PROGRESSIVE_PER_GROUP` fan-out. The pilot group is mandatory and runs first;
  one host moves at a time; a host succeeds after 10 minutes qualified; one
  failed host halts the run and rolls back the failed host; a host has 3 hours
  (above the box worker's 2-hour drain) before it counts as failed; the node
  qualifies at 50% of hosts; a host leaving the placement keeps its controller
  running (`DEPARTURE_ACTION_ORPHAN`). Each host's rollout is
  `ROLLOUT_STRATEGY_ALL_AT_ONCE`: no traffic is routed to a runner host, so a
  canary would be refused `progressive-unsupported`; the fan-out is the
  progressive part. A host qualifies on the verify suite
  `hobo-ci.runner-host/serving` (`RUNNER_HOST_VERIFY_SUITE`), which the
  Station answers from the host's own agent: its report of the Set CONVERGED
  and the host READY passes, a refusal (a failed verify it restored) or an
  unready host fails, and until the agent reports on the Set the suite is
  retried up to the 3-hour deadline.

## How promotion resolves a runner host's Set

The fleet's Bindle declares one resource, the runner controller
(`runnerFleetDeclaration`: `runner-controller`, `{ type: "data.v1", port:
"hobo:hobo-ci.runner-host/v1" }`), and the Station's CD runtime offers each
runner host Camp's provider (`self-hosted`) exactly that product
(`runnerHostPlannerProviders` in [`hobo`'s `cd-runtime.ts`](../../../hobo/src/cd-runtime.ts),
as publication Camps are offered their resolver product). The fleet's
Freight is discovered by its source with no declaration member, so its
`declaration_hash` is the source definition's digest; the runtime pairs the
Bindle's declaration with such a Freight only while the applied source still
has that digest (`sourceDeclaredBindle`), and refuses
`planning-declaration-missing` otherwise (a hand-ingested Freight, a
redefined source). Matching then places the row on the Camp's own provider,
and the runtime binds its realization parameters to the Freight's own
artifacts (`runnerHostRealizationParameters`: the image by manifest digest,
each paired release by its bytes' digest) and recomputes the Delta over the
bound Set (`withRunnerHostRealization`). A Freight with no digest-pinned
image is refused `runner-host-image-unresolved`, and a runner-host row for a
Camp outside the fleet `runner-host-camp-unbound`. The declaration names no
version: one declaration plans every version.

## Fleet health feeds Camp inventory

Every observation a runner host's agent reports carries the host's health as
claims (`runnerHostCampReport`): `hobo.ci/mesh-advert` (`fresh`, `expired` or
`missing`: the host's own signed advertisement), `hobo.ci/mesh-advert-valid-until`,
`hobo.ci/runner-host-ready` (the controller observed serving and the advert
fresh and healthy) and, while the advert is fresh, `label:hobo.ci/serves-<label>`.
The Station's delivery feed, once it has accepted the report (SVID, DPoP,
lease, fence), passes it to `CampInventory.observe` as health-source
conditions read at the Station's clock (`runnerHostHealthConditions`, the table
below) plus the claims (`withRunnerHostHealthIngest` in
[`hobo`'s `cd-agent-runner-host.ts`](../../../hobo/src/cd-agent-runner-host.ts)).
A host that is not ready carries the `NO_PLACE` taint
`hobo.ci/runner-host-unready` until a ready report clears it, so placement
skips it and a fan-out defers it. A host that has never reported is not
contacted at all and carries the Station's own `hobo.cd/unreachable` taint.

`runnerFleetCampObservations(hosts, nodes, now)` maps the mesh board's view of
each host to the same table, for a reader of the board:

| Mesh advertisement | REACHABLE | LEASED | READY |
|---|---|---|---|
| fresh, healthy | TRUE `mesh-advert-fresh` | TRUE `mesh-lease-valid-until:<time>` | TRUE `runner-host-healthy` |
| fresh, draining or host critical | TRUE | TRUE | FALSE `runner-host-draining-or-pressured` |
| expired | FALSE `mesh-advert-expired` | FALSE `mesh-lease-expired` | FALSE |
| none | UNKNOWN `mesh-advert-missing` | UNKNOWN | UNKNOWN |

The labels a host advertises are claims (`label:hobo.ci/serves-<label>`): a host
that stopped serving a declared label reads as `CLAIMS_CONSISTENT=false` and is
not placed. Claims narrow, never grant.

## Enroll a runner host (double opt-in)

1. On the Station, apply the module and mint a token scoped to the Camp set.
   The module's `camps` export is the fleet's topology: `pipeline apply` reads
   it, and every later command is given it with `--yard` or
   `HOBO_CD_TOPOLOGY=packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts`
   ([`hobo deploy`](../../../hobo/CD.md#topology-from-the-repository)):
   `hobo deploy pipeline apply --file packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts`, then
   `hobo deploy agent token --camp-set hobo-ci-runner-fleet --camp hobo-ci-runners/<id> --yard packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts`.
2. On the host, make a key pair, keep the private JWK as
   `~/.config/hobo-cd-agent/agent.jwk.json` (mode 0600), and enroll the public
   half: `hobo deploy agent enroll --token <token> --jwk-file public.jwk.json`.
3. On the Station, an operator approves the key and accepts the agent for the
   host's Camp: `hobo deploy agent approve-key <id>`, then
   `hobo deploy agent accept <id> --camp hobo-ci-runners/<id>`.
4. On the host, save the SVID as `agent.svid` (an empty file is fine: the
   agent activates one by proving key possession once accepted), fill
   `agent.env` from [`agent.env.example`](agent.env.example) and
   `agent.runner-host.json` from
   [`agent.runner-host.json.example`](agent.runner-host.json.example), and enable
   [`hobo-cd-agent.service`](hobo-cd-agent.service). It connects outbound to
   `/v1/cd/` and pulls; the Station never dials it. `hobo deploy agent revoke
   <id> --reason <text>` takes a host out.

## Run the agent on a runner host

`hobo deploy agent run` registers the runner-host realizer when
`HOBO_CD_RUNNER_HOST` names the host's agent config
([`agent.runner-host.json.example`](agent.runner-host.json.example): `hostId`,
`hostKind`, the registry read credential's locator `credentialRef`, optionally
`docker.binary`, `worker.database` and `drainDeadlineMs`). Its job ports are
read from the box worker's data directory, the directory of `worker.database`
(default `HOBO_CI_WORKER_DB`, else the worker's own default path), which the
controller container must mount from the host: the journal read-only for
leases, `mesh-advert.json` (the worker's own advert, rewritten every mesh
beat) and the `admission-paused` marker the agent places to drain the host
(package README, "Job ports from the worker's data directory"). A local
runner names its state directory instead (`worker: {directory}`): its
controller writes the advert, the GitHub presence of its registered runner
(`runner-presence.json`) and honours the marker there. A host whose
controller runs as a process (today's box worker and local runner) sets
`controller: {mode: "process", releases: "<directory or https:// base URL>"}`
and runs under `scripts/controller-supervisor.mts`; the agent stages the
release by digest and asks the supervisor to swap it through
`controller-desired.json` (package README, "A controller that runs as a
process"). A process host runs the release its Freight pairs with the image
(`workerRelease` or `localRunnerRelease` on the runner-host row, the
release's own bytes' digest), never the image's manifest digest. A Set for
the host's Camp then
converges by pulling the image its runner-host row pins by digest, draining,
swapping the controller and verifying by observation; a failed verify restores
the previous digest and reports `BLOCKED` with `runner-host-verify-failed`
(package README, "Runner-host realizer"). The agent serves only its own Camp
(`runner-host-camp-unbound` otherwise). `--feed` takes the Station's
`https://…/v1/cd/` URL.

## What does not work yet

These are refused, not faked:

- **No release index is published yet.** `release:build` bundles the box
  worker and the local runner into single-file releases and writes the
  indexes; nothing publishes them where `controller.releases` and the
  delivery module's `releaseIndexBase` (`HOBO_CI_RUNNER_RELEASE_INDEX` when
  this module is applied) point, so until it does a process host is adopted
  by hand once (`HOBO_CI_CONTROLLER_RELEASE`) and upgraded as
  [the runner queue guide](../../../ci/RUNNER-QUEUE.md) describes. Without
  `releaseIndexBase` the Freight carries only the image, and a process host
  refuses `runner-host-release-unresolved` rather than run an image digest
  it cannot verify a release against.
- **A host is placed only after it reports.** A Camp is reachable once its
  agent has reported a reconcile observation, which needs a Set; a fresh host
  is `hobo.cd/unreachable` until then, so its first Set (the controller it
  runs today) is adopted outside the fan-out. The end-to-end proof writes
  that first Set through the desired-state ledger; there is no `hobo deploy`
  command for it yet.
- **A failed pilot's Set stays desired until newer Freight.** When the agent
  restores the previous digest after a failed verify, it reports
  `runner-host-verify-failed` and does not swap to that Set again; the
  rollout waits for convergence until the 3-hour deadline, then the fan-out
  halts. The rollout's rollback Delta and the promotion's compensation then
  overlap (`delta-overlap`, `restore-refused`, in `@hobo/cd`), so the Camp's
  desired Set stays the failed one while the host serves the restored
  controller; promoting newer Freight replaces it.
- **Existing versions have no release tag.** Only a version published after
  this change gets one; the fleet's first Freight is the next image version.

The offline end-to-end proof (enrollment, placement, the pilot-first fan-out
deferring an unready host; a fan-out whose pilot promotion writes the box's
Set, the agent converging it, the pilot qualifying and the fleet group
starting; a failed verify restored and halting the fan-out, with each
agent's own job ports reading a fake worker's data directory; and the built
binary's `agent run` starting its loop on a box worker) is
[`packages/hobo/test/cd-runner-fleet-delivery.test.ts`](../../../hobo/test/cd-runner-fleet-delivery.test.ts);
the planning steps alone are
[`packages/hobo/test/cd-runtime-runner-host.test.ts`](../../../hobo/test/cd-runtime-runner-host.test.ts).
