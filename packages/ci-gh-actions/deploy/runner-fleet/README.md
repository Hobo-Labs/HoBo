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
| [`hobo-cd-agent.service`](hobo-cd-agent.service), [`agent.env.example`](agent.env.example) | The CD agent each runner host runs beside its controller. |

## What the delivery module declares

- **Camps.** One per host, `hobo-ci-runners/<host id>`, labelled
  `hobo.ci/runner-fleet=true`, `hobo.ci/runner-ring=<ring>`,
  `hobo.ci/runner-host=<kind>` and `hobo.ci/serves-<label>=true|false`
  (`runnerFleetTopology`). The host id is the host's mesh node id
  (`HOBO_CI_MESH_NODE_ID`), lowercase.
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
- **Placement** `hobo-ci-runner-fleet`: every eligible host, in a `pilot` group
  (at most one host) and then a `fleet` group.
- **Pipeline** `hobo-ci-runner-fleet`, node `fleet`: new Freight from the source
  promotes automatically (`AUTO_PROMOTION_NEWEST`) through a
  `PROGRESSIVE_PER_GROUP` fan-out. The pilot group is mandatory and runs first;
  one host moves at a time; a host succeeds after 10 minutes qualified; one
  failed host halts the run and rolls back the failed host; a host has 3 hours
  (above the box worker's 2-hour drain) before it counts as failed; the node
  qualifies at 50% of hosts; a host leaving the placement keeps its controller
  running (`DEPARTURE_ACTION_ORPHAN`).

## Fleet health feeds Camp inventory

`runnerFleetCampObservations(hosts, nodes, now)` maps each host's signed mesh
advertisement to `CampInventory.observe` input from the health source:

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

1. On the Station, apply the module and mint a token scoped to the Camp set:
   `hobo deploy pipeline apply --file packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts`, then
   `hobo deploy agent token --camp-set hobo-ci-runner-fleet --camp hobo-ci-runners/<id>`.
2. On the host, make a key pair, keep the private JWK as
   `~/.config/hobo-cd-agent/agent.jwk.json` (mode 0600), and enroll the public
   half: `hobo deploy agent enroll --token <token> --jwk-file public.jwk.json`.
3. On the Station, an operator approves the key and accepts the agent for the
   host's Camp: `hobo deploy agent approve-key <id>`, then
   `hobo deploy agent accept <id> --camp hobo-ci-runners/<id>`.
4. On the host, save the SVID as `agent.svid`, fill `agent.env` from
   [`agent.env.example`](agent.env.example), and enable
   [`hobo-cd-agent.service`](hobo-cd-agent.service). It connects outbound to
   `/v1/cd/` and pulls; the Station never dials it. `hobo deploy agent revoke
   <id> --reason <text>` takes a host out.

## What does not work yet

These are refused, not faked:

- **No runner-host realizer.** `hobo deploy agent run` on a runner host refuses
  with `compose-realizer-missing`: `@hobo/cd` has no realizer that applies a
  runner image Set to a box worker, mesh node or local runner (pull the image,
  drain, restart the controller). Until one exists the fleet records Freight
  and fans out to nobody; hosts are upgraded the way
  [the runner queue guide](../../../ci/RUNNER-QUEUE.md) describes.
- **No topology input on the `hobo` binary.** Camps are declared by Yards passed
  to the CD host or by `HOBO_CD_KUBE_FLEET`; the binary takes neither for these
  hosts, so `hobo deploy camp list --campset hobo-ci-runner-fleet` is empty and
  `agent token` refuses with `token-scope-invalid`. `runnerFleetTopology` is
  the declaration to load once it does.
- **The `hobo` binary rejects CD flags.** Its option parser (`@hobo/cli`)
  refuses `--file`, `--camp-set`, `--feed` and the other `hobo deploy` flags
  with `Unknown option`, so the commands above run through the deploy command
  module (`createDeployCommand`) until it passes them through.
- **No ingestion of mesh conditions.** Nothing yet calls `CampInventory.observe`
  with `runnerFleetCampObservations`; there is no `hobo deploy camp observe`.
- **Placement fails closed** with `rail-providers-unknown` until the Station's
  Rail lists approved providers.
- **Existing versions have no release tag.** Only a version published after
  this change gets one; the fleet's first Freight is the next image version.
