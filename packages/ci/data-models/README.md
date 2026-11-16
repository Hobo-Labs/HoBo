# Shared CI contracts

`ci.proto` owns configuration, account offers, repository connections, jobs, leases,
events and snapshots. `ci.cue` constrains every message; valid/invalid fixtures are
executed by schema-tools. Generated records live under `src/_generated`.
`SequencedCiEvent` pairs a stored event with its position in the partition's
journal and `CiEventPage` is one cursor read of an account's events; the
position orders a catch-up read and is not part of the stored event. A page
holds exactly the account's events; its `more` and `truncated` say when the
page was full and the account has events after it, or older than it.

Lease prices and free-allocation validity are pinned when capacity is reserved.
Settled free consumption is recorded separately from reserved free minutes so a
host finishing beyond the evidence window cannot be accounted as free. Jobs carry
the exact GitHub job name and their admitted memory class/request; leases persist
that request so active and reserved memory survives worker restarts. A legacy lease
without a request is accounted at the heavy class by the box worker.


`policy.proto` defines SDK-authored desired policy separately from the runtime
Account, leases and observed usage. `ci.cue` constrains policy fixtures.
`parseCiPolicy` enforces cross-reference and duplicate checks at the protobuf
JSON boundary; provider/Station authorization requires an external resolver.
Only manual budget periods are accepted until automatic rollover is implemented.
`CiPolicyProvider.capacity` is a oneof of a kubernetes-only ARC `scale_set` or
Dagger `engine`; `location` is vercel-only. CUE and `parseCiPolicy` reject either
on another kind; fixtures `desired-policy-kubernetes-shapes.json` and the
`desired-policy-*-wrong-kind` / `scale-set-and-engine` invalids pin the rules.

Azure DevOps offers pair `provider: "azure-devops"` with `backend: "ado"`;
desired policy accepts the same provider kind. CUE and runtime configuration
parsers reject mismatched backend/provider pairs. This authorizes an explicitly
host-bound adapter and does not infer a provider entitlement or remote agent.

Portable Pipeline environment maps reject `__proto__` before protobuf JSON
parsing can discard that declared binding. The CUE fixture and runtime constructor
enforce the same rule across all backends; literal values and ordinary names such
as `constructor` keep their normal meaning.

`fleet_v2.proto` owns strict execution identity, profiles, demands, runner slots,
claims, capacity, effects, outbox/delivery fences, observations, incarnations, and
secret-free audit events. `fleet_v2.cue` closes states and execution classes;
valid/invalid fleet fixtures cover positive attempts, fixed-capacity limits, Linux
x64 profiles, and rejection of raw binding credentials. Store conformance protects
the transactional boundary with SQLite and opt-in Testcontainers PostgreSQL lanes;
these gates do not claim live-provider production readiness.

`runner_route.proto` owns the runner order (`RunnerOrder`, its steps and retry
policy), one relay job's question (`RunnerRouteRequest`) and the answer
(`RunnerRouteDecision` with every step passed over). `runner_route.cue`
constrains them: a minutes limit only on `github`, a spend limit only on a
hosted provider, and a decision whose fields agree with its outcome. Step
uniqueness is a cross-element rule `parseRunnerOrder` enforces. Fixtures are
under `fixtures/runner_route/`.

`relay_job.proto` owns what a relay job carries between its parts
(ADR-0183): the message an answerer receives (`RelayJobMessage`), what it
completes the job with (`RelayJobAnswer`), the route journal entry
(`RunnerRouteEvent`), a machine's advert (`MachineAdvert`), a stored provider
health record (`ProviderHealthRecord`) and one run attempt's facts (`RunFact`,
`JobFact`, `StepFact`, field for field what the insight reports read).
`relay_job.cue` constrains them: a failed answer carries an annotation saying
why, and a decision is on `runner.route.Decided` and nowhere else. It imports
`runner_route.proto`, so this folder's `buf.gen.yaml` generates `.js` import
paths. Fixtures are under `fixtures/relay_job/`; the parsers are in
`src/runner-order/relay-job.ts`.
