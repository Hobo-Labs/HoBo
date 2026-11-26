# `@hobo/cd/pipelines`: pipeline graph with lineage

A pipeline is a DAG of nodes for one Bindle (or one Rail). Each node targets
a Camp list or a fleet Placement. Freight reaches a node only through
lineage: a source the node reads, upstream qualification plus soak, or an
unexpired approval for one Camp (D4, I16). Fleet nodes fan out and qualify
downstream on quorum (D21). Rail pipelines shadow a Rail in INFORM nodes
before ENFORCE nodes enforce it (D24, I23). This folder is half of work
package WP5.

| Export | What it does |
|---|---|
| `createPipelineController` | Implements the frozen `PipelineController` port: `apply`, `get`, `list`, `available` and `tick`. |
| `validatePipeline`, `normalizePipeline` | The parse boundary for `PipelineRecord`: every problem, each with a remediation. |
| `freightAvailability`, `quorumThreshold` | Pure availability and quorum. |
| `pipelineKey`, `fanoutWithDefaults` | The idempotency key `pipeline:<p>:<node>:<freight>`, and the fan-out record with `CD_DEFAULTS` filled in. |
| `PIPELINE_REASON`, `PIPELINE_METRIC`, `ORIGIN_SOURCES`, `PROJECT_LABEL`, `VIA_APPROVAL` | Wire contract. |

The deps are `CdFactories["createPipelineController"]` plus three optional
ones:

- `windows` (`ChangeWindows`): read at request time, so a freeze that begins
  during a tick blocks the requests after it. Without it, the promotion gate
  is the only window check (it always runs one, D10).
- `telemetry` (`TelemetrySink`).
- `placementContext`: the Station and data subject (classifications,
  residency) of a placed node's Placement. WP18 composes it. Without it,
  placed nodes never start a fan-out (fail closed).

## Design

**Parse, don't validate.** Nothing reaches the journal unparsed.
`validatePipeline` + `normalizePipeline` turn a `PipelineRecord` into its
parsed form (schema stamped, subject normalized, definer recorded) or a typed
refusal; availability works on derived types (`NodeAvailability`,
`PlacedView`). `data-models/pipelines.cue` carries the single-record
constraints, and `test/pipelines/cue.test.ts` checks that the two agree.

**Event architecture.** Each command (`apply`, the requests `tick` makes)
appends one event to the event store; the per-pipeline stream
`cd-pipeline-<name>` is the actor's state. Queries read a projection (a
materialized view used as the read store) rebuilt from the journal on start.
No snapshot is needed: a pipeline stream holds its definitions and one
availability fact per node and Freight.

### `apply`

`apply` validates the whole graph and reports every problem:

- Graph shape:
  - the pipeline has nodes, and node names are unique slugs;
  - every node has a source;
  - upstream nodes and Freight sources exist;
  - the graph is acyclic.
- Freight sources:
  - named sources are `source.Defined` facts in the journal;
  - pushed Freight has no source name, so it enters through the origin
    pseudo-sources `origin:manifest|attestation|cdevent|hobo-ci|local-build`.
- Camps and Placements:
  - every node has exactly one of `camp_ids` or `placement` (D21);
  - placed nodes name an existing Placement, and their mandatory groups are
    groups of that Placement;
  - fan-out, failover and departure appear only on placed nodes;
  - listed Camps exist in the topology, are `MANAGED`, and belong to one
    node of the pipeline;
  - when a Camp carries `hobo.cd/project`, it must match the Bindle's
    project (the id segment before `/`).
- Strategies:
  - `ALL` over a placed upstream node is refused (C18);
  - `MATCH_UPSTREAM` needs exactly one upstream node and no sources;
  - preview nodes are listed leaves.
- Rails:
  - `policy_mode` appears only in RAIL pipelines, and every RAIL node has
    one;
  - an ENFORCE node takes Freight only from upstream nodes and has an
    INFORM node upstream (`shadow-required`);
  - OBSERVE_ONLY Camps may appear only in INFORM nodes.
- Other checks: stage percents rise strictly to 100, hooks are complete, and
  each Bindle has one pipeline.

When the graph is valid, `apply` is governed (`pipeline.apply`;
proposal-only principals are refused). It then appends `pipeline.Applied`
to `cd-pipeline-<name>` with stream-head CAS and the idempotency key
`applied:<digest>`. Re-applying an identical pipeline is a no-op.

### Availability (`available`)

Availability is computed per Freight, newest first.

- **Eligible Freight.** It must be usable (not yanked or retired, I13), of
  the pipeline's Bindle, and of the pipeline's subject.
- **Sources.** A root node sees Freight from its sources at `recorded_at`.
- **Upstream nodes.** These follow the node's strategy. UNSPECIFIED means
  QUORUM when any upstream node is placed, otherwise ONE_OF (R10).
  - `ONE_OF`: any upstream node admits the Freight. A list node admits it
    with one qualified Camp.
  - `ALL`: every upstream node admits it, and every Camp of each list node
    is qualified.
  - `QUORUM`: every upstream node admits it. A placed node admits it with a
    quorum of its latest decision plus every Camp of each mandatory group. A
    list node admits it with a quorum of its Camps.
- **Quorum threshold.** It is
  `max(1, min_qualified, ceil(min_qualified_percent × decision))`. The
  default is 95%.
- **Qualifications.** Only `freight.Qualified` for this pipeline and that
  upstream node counts.
- **Soak.** Each qualified Camp completes at
  `max(qualified_at, env.Promoted + required_soak_ms)`. Soak is measured
  from the upstream promotion time.
- **Approvals.** An unexpired approval makes the Freight available to that
  Camp of the node only (`via: ["approval"]`). It expires at `expires_at`.
- **Recorded facts.** `tick` records `pipeline.FreightAvailable` once per
  node and Freight.

### `tick`

`tick` walks nodes in topological order and is safe to repeat.

- `NEWEST` and `MATCH_UPSTREAM`:
  - **List node:** one request for all Camps, with key
    `pipeline:<p>:<node>:<freight>`. Approval-only Freight gets one request
    per approved Camp, with key `…:approval:<camp>`. Each target's windows
    are evaluated at `ctx.now()` just before the request.
  - **Placed node:** `PlacementEngine.decide`, then `FanoutController.start`
    with the node's fan-out, `CD_DEFAULTS` filled in, and the same key. No
    new decision is made while a fan-out of that Freight exists.
- `MATCH_NODE` handles late entrants. These are Camps of the latest decision
  (or the list) that are not qualified, not owned by a running fan-out, have
  no in-flight promotion, and have never been sent the stable Freight.
  - Each entrant gets one request for the node's current qualified Freight,
    with key `…:match:<camp>`.
  - The stable Freight is never one that is still rolling out.
  - Nothing is requested while a fan-out of the node is halted.
- `DISABLED` (and UNSPECIFIED) nodes and preview nodes are left to explicit
  commands.
- Keys already in the journal (`env.PromoteRequested`) are not requested
  again, even after a restart.

### State

All state comes from one catch-up projection over these events:
`pipeline.Applied`, `pipeline.FreightAvailable`, `source.Defined`,
`env.PromoteRequested` and `env.Promoted`. The projection is rebuilt from
the journal on start, so replay equals live (I8). Promotion bodies, which
WP6 owns, are decoded as `PromotionRecord`. Their idempotency key is read
structurally.

## Metrics

All metrics are counters on `TelemetrySink` and carry `tenant`, `pipeline`
and (where relevant) `node` attributes:

- `hobo.cd.pipeline.applied`
- `hobo.cd.pipeline.refused` (`code`)
- `hobo.cd.pipeline.freight_available` (`via`)
- `hobo.cd.pipeline.promotion_requested`
- `hobo.cd.pipeline.promotion_refused` (`code`)
- `hobo.cd.pipeline.fanout_started`
- `hobo.cd.pipeline.tick_blocked` (`reason`: `window-closed`,
  `placement-context-missing`, `fanout-halted`, or a placement or fan-out
  refusal code)
- `hobo.cd.pipeline.unreadable`

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| Freight never reaches a downstream node | Lineage is unmet: upstream qualification is missing, soak has not elapsed, or quorum has not been reached. | Run `available` for the node and the upstream node. Check `freight.Qualified` for the upstream Camps and the `env.Promoted` time against `required_soak_ms`. For a fleet, compare qualified Camps with the quorum threshold and check that the mandatory groups passed. |
| Hotfix Freight reached only one Camp | Approvals bypass lineage for their own Camp until expiry, by design. | Approve each Camp that needs the hotfix, or qualify it upstream. |
| `tick_blocked` `window-closed` | A node window closed between the start of the tick and the request. | The request is retried on the first tick after the window opens. Grant an override to proceed now. |
| `tick_blocked` `placement-context-missing` | The controller was composed without `placementContext`. | Compose it (WP18). Placed nodes do not auto-promote without it. |
| `tick_blocked` `fanout-halted` | A fan-out of the node is halted, so `MATCH_NODE` stops. | Resume or roll back the fan-out (governed), then late entrants catch up. |
| A deferred Camp never catches up | The node is not `MATCH_NODE`, or the Camp has a failed or rolled-back promotion of the stable Freight. | Set `auto_promotion: MATCH_NODE`, or promote the Camp explicitly after fixing it. |
| `pipeline-bindle-has-pipeline` | The Bindle is already delivered by another pipeline. | Edit that pipeline. A Bindle has one pipeline. |
| `shadow-required` | An ENFORCE node would enforce a Rail without an INFORM shadow upstream. | Add an INFORM node upstream and source the ENFORCE node from it. |
| `pipeline-unknown-source` for pushed Freight | Pushed manifests have no source name. | Use `origin:manifest` (or another origin pseudo-source) in `from_sources`. |
| `hobo.cd.pipeline.unreadable` | A `pipeline.Applied` body cannot be decoded, so the pipeline is treated as absent and does not auto-promote. | Re-apply the pipeline, or restore `cd-pipeline-<name>` from backup. |
| `pipeline-journal-conflict` | Both CAS attempts lost to concurrent writers, or the store is unavailable. | Retry. `apply` is idempotent. |
