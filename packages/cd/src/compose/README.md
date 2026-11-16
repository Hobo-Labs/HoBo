# `@hobo/cd/compose` — the CD composition root (WP18)

One composition of `@hobo/cd` that every surface uses: `hobo up`/`down`,
`hobo deploy *`, `hobo serve cd`, broker `deliver`, MCP and agents (ADR-0182: C2). It binds the frozen factories (`CdFactories` in `../ports.ts`) in
dependency order and returns the `ContinuousDelivery` facade. It makes no
delivery decision: every decision stays in the module that owns it.

| File | What |
|---|---|
| `wire.ts` | `wireContinuousDelivery(input)`: pure wiring over injected factories and host adapters (incl. the placed-Camps reader and the fan-out aggregate gate on the promotion service, `FanoutCostAuthority`); `conductorFor`, `defaultRetention`. |
| `compose.ts` | `composeContinuousDelivery(input)`: `wire` over `defaultCdFactories`, any factory overridable. |
| `defaults.ts` | `defaultCdFactories` and `defaultCdAdapters(host)` (WP6 gate/planning/A2H approvals, WP10 Harness ramp + Station cutover, WP7 drift). Binds at merge. |
| `late.ts` | Late-bound references closing the pipelines ⇄ promotions and fan-out → promotions cycles. |
| `rails.ts` | Journal readers: the Station Rail catalog, the frozen `RailEventReader` (HOBO_RAIL), and `RailDeliveryReader` (enforced binding first, else the Station's active Rail). |
| `config.ts` | `parseCdComposeConfig`: store selection (SQLite default, Postgres when configured, memory only with `--simulate`) and artifact-store selection. |
| `fail-closed.ts` | Adapters for unconfigured ports: runbooks/suites refuse, traffic offers nothing, NOTIFY is dropped and counted, fan-out pricing quotes nothing (the aggregate refuses). |
| `simulate.ts` | The labelled `--simulate` realizer: every observation carries reason `simulated`. |
| `ci-bridge.ts` | `hoboCiSource` (HOBO_CI subscription, C15) and `hoboCiDogfoodSources` (HoBo's own CI relay and runner fleet). |
| `errors.ts` | `COMPOSE_FAILURES`: every code with its remediation; `ComposeError`. |

## Wiring order

sink → authorizer → artifacts → artifact verifier → freight → publishers →
provenance → drivers → sources → ingest → desired → windows → Camp policy →
Rail reader → inventory → placement → posture → shadow → health sources →
verification → notify → approvals → traffic → rollouts → pipelines (late
promotions, late fan-out) → fan-out (late promotions) → placed-Camps reader +
fan-out aggregate gate → promotions → failover → enrollment → feed → telemetry
→ drift. Adapter builders receive a `CdComposeScope`; reading a module that is
built later throws `compose-scope-unbuilt` at compose time, never at delivery
time.

## Fan-out drives convergence (D20, D21)

A fan-out only schedules ordinary per-Camp promotions, so the composition
gives the promotion service the two things a fan-out's promotion needs:

- **Placed Camps** — `placedCampsFrom({ fanout, placement })`: lineage reads a
  placed node's governed Camps from the recorded `placement.Decided` (the
  fan-out's own decision, else the node's latest completed one). Without it
  every placed node refuses `promotion-placement-unresolved`.
- **Fan-out aggregate** — `createFanoutAggregateGate`: before any Camp of the
  fan-out starts, the decision's Camp count is checked against the Rail's
  `max_fanout_camps` (and an optional Station entitlement), and the summed
  cost quotes against the Station budget (`fanout-budget-exceeded`). The
  quotes and the budget come from the host's `fanoutCost` adapter
  (`FanoutCostAuthority`: `quote`, `budget`, optional `entitlement`); with
  none composed, `unconfiguredFanoutCost` quotes nothing and every fan-out
  promotion is refused `fanout-aggregate-quote-missing`. Cost is never
  assumed zero.

Gate, lineage, windows, rollout and verification stay the promotion's own.
`test/compose/fanout-convergence.test.ts` proves it over the real modules: a
PROGRESSIVE_PER_GROUP fan-out converges the pilot group first (observed by a
reconciler, verified, qualified), starts the next group only after the pilot
qualifies and soaks, defers a tainted host and catches it up once it recovers.

## Metrics

| Name | Kind | When |
|---|---|---|
| `hobo.cd.compose.modules` | gauge | once per composition |
| `hobo.cd.compose.failures` | counter | a reconciler is refused (`compose-realizer-missing`) |
| `hobo.cd.compose.unconfigured_refusals` | counter | an unconfigured runbook/suite/traffic port refused |
| `hobo.cd.compose.notify_dropped` | counter | an unrouted NOTIFY was dropped |
| `hobo.cd.compose.rail_delivery_invalid` | counter | a Rail `delivery` object did not parse |

## Runbook

- **`compose-realizer-missing`** — `hobo serve cd` or `hobo up` refused to start
  a reconciler. Configure the conductor realizer for the Camp's provider
  (hosting transitions for workload versions, Orchestrator ResourceActors for
  the resource graph), enroll an agent for agent-mode Camps, or define a
  publisher. `--simulate` reaches the labelled fixture realizer only.
- **`compose-store-multinode`** — more than one replica (`HOBO_CD_REPLICAS`) on
  SQLite. Set `HOBO_CD_POSTGRES_URL` (PostgreSQL 16 or later); SQLite is for a
  single conductor process (R6).
- **`compose-store-invalid` / `compose-artifacts-invalid`** — fix the named
  environment variable; the message names it.
- **`rail-delivery-invalid` metric rising** — a Station's Rail `delivery`
  object does not parse as `RailDeliveryRecord`. The Rail binds no Camp sets, so
  Placement sees no candidates and failover stays off. Republish the Rail with
  a valid object (`campSets`, `posture`, `failover`, `enrollment`,
  `maxFanoutCamps`).
- **`compose-traffic-unconfigured` in rollout notes** — the Camp has no Station
  cutover routing composed; a canary is refused as `progressive-unsupported`.
  Compose routing for the provider, or use an all-at-once strategy.
- **`compose-runbook-unconfigured` / `compose-suite-unconfigured`** — a pipeline
  declares RUNBOOK or SUITE hooks but the host composed no executor; the hook
  fails closed and the promotion stops at that hook point.
- **`compose-unbound`** — a module was called during composition. This is a bug
  in an adapter builder: read modules lazily inside adapter methods.
- **`fanout-aggregate-quote-missing` / `fanout-aggregate-budget-missing`** on a
  fan-out's first Camp (and `hobo.cd.compose.unconfigured_refusals` with
  `hobo.cd.port` = `fanout-quote` or `station-budget`) — no pricing or Station
  budget authority is composed. Bind the host's authorities through the
  `fanoutCost` adapter (`openCdRuntime({ fanoutCost })` in `@hobo/hobo`).
- **`fanout-budget-exceeded`** — the fan-out reaches more Camps than the Rail's
  `max_fanout_camps` (or the Station entitlement) allows, or costs more than the
  Station budget has left. Narrow the placement, or raise the limit through a
  governed Rail promotion or the budget authority.
- **`promotion-placement-unresolved`** — no recorded placement decision names the
  node's Camps (or a host replaced the promotion factory without the placed
  reader). Decide the placement before promoting through the node.
