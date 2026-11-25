# POC Rollup Ledger

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Typed domain event-body contract | `src/draft/technical-proofs/domain-event-body-contract` | HOBO-42 | App developer | Order fact carries canonical typed payload | CQRS write to reactive read | EventStore append | eventstore-append-boundary | verified | implemented_in_reference_impl | WIT/protobuf round trip is executed. |
| `hobo:projection` port | `src/draft/technical-proofs/hobo-projection-port-contract` | HOBO-46 | Platform data engineer | Projection is a stable port decision | Projection sinks and search | Projection sink | projection-sink-boundary | contracted | integrated | Boundary vocabulary is consumed by architecture and inventory. |
| Materialization/subscription/data.Changed contract | `src/draft/technical-proofs/materialization-subscription-contract` | HOBO-51 | App developer | Reactive materialization emits data.Changed | CQRS write to reactive read | Projection sink, subscription gateway | projection-sink-boundary, subscription-gateway-boundary | verified | implemented_in_reference_impl | `createDataChanged` is executed. |
| Consistency/reactivity class contract | `src/draft/technical-proofs/projection-consistency-reactivity-contract` | HOBO-53 | Platform data engineer | Session consistency defaults are visible | CQRS write to reactive read | GraphQL facade | graphql-facade-boundary | verified | implemented_in_reference_impl | GraphQL materialization declares session consistency. |
| Event-body upcaster gate | `src/draft/technical-proofs/event-body-upcaster-gate` | HOBO-57 | Platform data engineer | Old event bodies stay replayable | CQRS write to reactive read | EventStore append | eventstore-append-boundary | simulated | integrated | Upcaster concern is represented in replay/live and poison handling. |
| Replay/live equivalence spike | `src/draft/technical-proofs/replay-live-equivalence-poc` | HOBO-60 | App developer | Live subscription and replay match | CQRS write to reactive read | EventStore append | eventstore-append-boundary | verified | promoting_via_hobo_601 | `assertReplayEqualsLive` promoted in `src/draft/technical-proofs/deterministic-replay-engine` (HOBO-601); production target `@hobo/runtime/replay`. |
| GraphQL facade generation spike | `src/draft/technical-proofs/graphql-facade-generation-poc` | HOBO-65 | App developer | Materialization shape drives GraphQL facade | CQRS write to reactive read | GraphQL facade | graphql-facade-boundary | simulated | integrated | Runtime facade uses same generated-shape boundary. |
| CQRS command aggregate | `src/draft/technical-proofs/cqrs-command-aggregate-contract` | HOBO-69 | App developer | Command emits event under aggregate invariant | CQRS write to reactive read | EventStore append | eventstore-append-boundary | verified | implemented_in_reference_impl | `createCommandRuntime` is executed. |
| Native log projection | `src/draft/technical-proofs/native-log-projection-contract` | HOBO-74 | App developer | Native projection folds from the log | CQRS write to reactive read | Projection sink | projection-sink-boundary | simulated | integrated | The reference fold uses the log as source of truth. |
| Default read surface | `src/draft/technical-proofs/default-read-surface-contract` | HOBO-76 | App developer | Read surface replays then pushes live | CQRS write to reactive read | Subscription gateway | subscription-gateway-boundary | simulated | integrated | Reactor and GraphQL read paths consume the same event stream. |
| Reactor skeleton | `src/draft/technical-proofs/reactor-skeleton-contract` | HOBO-80 | App developer | Read-set append wakes subscribed projection | CQRS write to reactive read | Subscription gateway | subscription-gateway-boundary | verified | implemented_in_reference_impl | `createInMemoryReactor` is executed. |
| Reads-your-writes | `src/draft/technical-proofs/reads-your-writes-contract` | HOBO-85 | App developer | Command seq advances the materialization | CQRS write to reactive read | EventStore, subscription gateway | eventstore-append-boundary, subscription-gateway-boundary | simulated | integrated | Per-stream seq vector is asserted in tests. |
| GraphQL facade runtime | `src/draft/technical-proofs/graphql-facade-runtime-contract` | HOBO-92 | App developer | GraphQL reads materialization snapshot | CQRS write to reactive read | GraphQL facade | graphql-facade-boundary | verified | implemented_in_reference_impl | `createGraphqlFacadeRuntime` is executed. |
| Repo/view escape hatches | `src/draft/technical-proofs/repo-view-escape-hatches-contract` | HOBO-96 | Platform data engineer | Snapshot/repo/view escapes are visible debt | CQRS write to reactive read | GraphQL facade, projection sink | graphql-facade-boundary, projection-sink-boundary | simulated | integrated | Raw-driver POC carries the risky escape hatch. |
| Cursor pagination | `src/draft/technical-proofs/paginated-query-contract` | HOBO-107 | App developer | Snapshot@seq bounds paginated query reads | CQRS write to reactive read | GraphQL facade | graphql-facade-boundary | contracted | integrated | Pagination remains a facade concern, not a new provider boundary. |
| Relational projection sink | `src/draft/technical-proofs/relational-projection-sink-contract` | HOBO-232 | Platform data engineer | Relational sink receives materialized order | Projection sinks and search | Projection sink | projection-sink-boundary | simulated | integrated | Consumer-visible sink status is emitted. |
| Document projection sink | `src/draft/technical-proofs/document-projection-sink-contract` | HOBO-234 | Platform data engineer | Document sink receives materialized order | Projection sinks and search | Projection sink | projection-sink-boundary | simulated | integrated | Consumer-visible sink status is emitted. |
| Change-feed conformance | `src/draft/technical-proofs/projection-sink-change-feed-conformance-contract` | HOBO-237 | Platform data engineer | Sink change-feed normalizes to data.Changed | Projection sinks and search | Projection sink | projection-sink-boundary | verified | implemented_in_reference_impl | `data.Changed` helper is executed. |
| Snapshot compaction | `src/draft/technical-proofs/snapshot-compaction-contract` | HOBO-240 | Security reviewer | Snapshot is cache, not source of truth | Adversarial data integrity | EventStore append, projection sink | eventstore-append-boundary, projection-sink-boundary | simulated | integrated | Divergence path rebuilds from full replay. |
| Full-text search | `src/draft/technical-proofs/full-text-search-contract` | HOBO-245 | App developer | Text query reacts over data materialization | Projection sinks and search | Search/embed | search-embed-boundary | verified | implemented_in_reference_impl | `createSearchProjection` is executed. |
| SQL/document idiom packages | `src/draft/technical-proofs/paradigm-idiom-packages-contract` | HOBO-248 | Platform data engineer | Opt-in paradigms map to projection port | Projection sinks and search | Projection sink | projection-sink-boundary | contracted | integrated | Kept as authoring surface over same sink boundary. |
| Vector/graph search extensions | `src/draft/technical-proofs/search-extension-packages-contract` | HOBO-252 | App developer | Vector search is an off-reactive-path step | Projection sinks and search | Search/embed | search-embed-boundary | verified | implemented_in_reference_impl | `runVectorSearchStep` and local embed are executed. |
| Optimistic updates | `src/draft/technical-proofs/client-optimistic-update-contract` | HOBO-256 | App developer | Local patch reconciles at authoritative seq | Adversarial data integrity | Subscription gateway | subscription-gateway-boundary | simulated | integrated | Modeled as client-facing behavior of the same seq contract; latest technical-proof change reconciled without changing the simulation. |
| Cross-Camp bounded staleness | `src/draft/technical-proofs/cross-camp-bounded-staleness-contract` | HOBO-261 | Platform data engineer | Remote Camp labels staleness honestly | Adversarial data integrity | Projection sink, subscription gateway | projection-sink-boundary, subscription-gateway-boundary | simulated | integrated | Bound appears in lag/staleness docs, no live replication; latest technical-proof change reconciled without changing the simulation. |
| Raw driver escape hatch | `src/draft/technical-proofs/raw-driver-escape-hatch-contract` | HOBO-265 | Platform data engineer | Raw reads are portability debt; raw writes blocked | Projection sinks and search | Projection sink | projection-sink-boundary | verified | implemented_in_reference_impl | `createRawView` is executed. |
| Auth/flag read-set | `src/draft/technical-proofs/auth-flag-readset-contract` | HOBO-269 | Security reviewer | Session revoke and flag change repush reads | Adversarial data integrity | Governance/erasure, subscription gateway | governance-erasure-boundary, subscription-gateway-boundary | verified | implemented_in_reference_impl | `createAuthFlagReadsetReactor` is executed. |
| Projection rebuild-from-zero | `src/draft/technical-proofs/projection-rebuild-contract` | HOBO-273 | Platform data engineer | Rebuild catches up before cutover | Adversarial data integrity | EventStore append, projection sink | eventstore-append-boundary, projection-sink-boundary | simulated | integrated | Rebuild is documented as follow-on provider work. |
| Projection lag consistency | `src/draft/technical-proofs/projection-lag-consistency-contract` | HOBO-278 | Security reviewer | Stale reads are labeled as lagged | Adversarial data integrity | Projection sink | projection-sink-boundary | simulated | integrated | `projection.Lagged` appears in simulation output. |
| Snapshot/replay divergence | `src/draft/technical-proofs/snapshot-replay-divergence-contract` | HOBO-283 | Security reviewer | Divergent snapshot fails closed to replay | Adversarial data integrity | EventStore append, projection sink | eventstore-append-boundary, projection-sink-boundary | simulated | integrated | Full-replay recovery is asserted. |
| Reactor coalescing/fan-out | `src/draft/technical-proofs/reactor-coalescing-fanout-contract` | HOBO-288 | App developer | Burst fan-out coalesces by stream seq | Adversarial data integrity | Subscription gateway | subscription-gateway-boundary | simulated | integrated | Coalescing policy is in simulation output. |
| Poison event quarantine | PR #351 / HOBO-291 evidence | HOBO-291 | Security reviewer | Bad event emits quarantine fact and deterministic skip | Adversarial data integrity | EventStore append, projection sink | eventstore-append-boundary, projection-sink-boundary | simulated | integrated | Behavior implemented from issue/PR evidence without taking over child PR. |
| Crypto-shred erasure | `src/draft/technical-proofs/crypto-shred-erasure-contract` | HOBO-295 | Security reviewer | Forgettable fields tombstone without log rewrite | Adversarial data integrity | Governance/erasure | governance-erasure-boundary | verified | implemented_in_reference_impl | Crypto-shred log/keyring POC is executed. |

| Domain event body | `src/draft/technical-proofs/domain-event-body-contract` | HOBO-42 | App developer | Order fact carries canonical typed payload | CQRS write to reactive read | EventStore append | eventstore-append-boundary | verified | implemented_in_reference_impl | Latest leaf validation is absorbed; replay evidence unchanged. |
| Event body upcaster | `src/draft/technical-proofs/event-body-upcaster-gate` | HOBO-57 | Platform data engineer | Old event bodies stay replayable | CQRS write to reactive read | EventStore append | eventstore-append-boundary | simulated | integrated | Latest leaf validation is absorbed; replay evidence unchanged. |

## Cascade absorptions

Changes to referenced technical proofs that this rollup has taken in, and what
each one did or did not move.

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/deterministic-replay-engine` | `architecture/replay_report.cue` was unparseable — every line of every definition body carried a leading `#`, which is a definition sigil in CUE and not a comment, so the file had never been read by any tool that claims to check it. Repaired, and the divergence guard was then replaced. | No disposition, evidence path, or Linear link moves. The `Replay/live equivalence spike` row's `promoting_via_hobo_601` disposition and its `assertReplayEqualsLive` promotion target are unchanged. |
| `src/draft/technical-proofs/graphql-facade-runtime-contract` | latest validated leaf hardening | GraphQL materialization and read-consistency simulation unchanged. |
| `src/draft/technical-proofs/graphql-facade-generation-poc` | Restored the nullish defaults the anti-slop sweep stripped, which had left the leaf crashing on omitted optional fields (`projection.args`, sorted-record input) | Generated facade shape and simulation unchanged. |

The guard change is the part that is not merely cosmetic. `#ReplayDivergence`
carried `if live_state_digest == replay_state_digest { _conflict: "divergence
requires differing digests" }`, which reads as a refusal and enforces nothing:
assigning a string to a hidden field nothing else defines can never conflict.
Measured on a reduced case with `cue v0.14.0` — a divergence record whose two
digests are byte-identical exits **0** under the old form and fails under the
new `_divergent: true & (live_state_digest != replay_state_digest)` with
`conflicting values false and true`; a record with genuinely differing digests
exits 0 under both. This is the same form the production counterpart at
`packages/runtime/data-models/replay/replay_report.cue` now carries.

What this does **not** change is any claim in the table above. The
`Snapshot/replay divergence` row's `simulated` disposition rests on the
simulation's full-replay recovery assertion, not on this schema; nothing in
`simulation/` or `reference-implementation.yaml` consumed the unenforced guard,
because nothing could — the file did not parse.

## Adversarial Scope Review

| Review area | Decision |
|---|---|
| Requirement proven | The accepted POCs jointly prove write-side CQRS, log-backed reads, reactive materializations, portable sink/search boundaries, and fail-closed data integrity behavior. |
| Unsafe details discarded | Live databases, hosted embedders, unbounded fan-out, raw writes to projected sinks, silent stale reads, snapshot-as-truth, poison-event rewrites, and erasure deletes are excluded. |
| Contract strategy | Every service boundary has a consumer-side Pact fixture and deterministic mock provider strategy. Provider verification is deferred until real services exist. |
| Simulation risk | The simulation demonstrates architecture shape and negative behavior; it does not claim production EventStore, sink, gateway, GraphQL, search, or governance services exist. |
| Active epic conflict | The reference implementation is isolated under the Data Plane epic slug and does not modify other epic reference paths or child PR branches. |
| Follow-up split | Provider-side Pact verification, real sink adapters, live replication, and production poison-event provider integration remain follow-up work outside this reference PR. |

| `src/draft/technical-proofs/projection-consistency-reactivity-contract` | latest validated leaf hardening | Projection consistency and replay evidence unchanged. |
| `src/draft/technical-proofs/projection-sink-change-feed-conformance-contract` | latest validated leaf hardening | Change-feed and materialization evidence unchanged. |
| `src/draft/technical-proofs/reactor-skeleton-contract` | latest validated leaf hardening | Reactor and event-reactivity evidence unchanged. |
| `src/draft/technical-proofs/reads-your-writes-contract` | latest validated leaf hardening | Read-your-writes consistency evidence unchanged. |

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/search-extension-packages-contract` | final validated leaf hardening | Extension-search evidence unchanged. |
| `src/draft/technical-proofs/snapshot-replay-divergence-contract` | final validated leaf hardening | Event replay and divergence evidence unchanged. |
