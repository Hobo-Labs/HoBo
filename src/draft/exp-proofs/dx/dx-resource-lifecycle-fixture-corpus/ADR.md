# DX Resource Lifecycle Fixture Corpus - Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-572. It pins the
shared reference-fixture corpus before downstream SDK, CLI, API, docs, and visual
proof packages consume it.

## Decision

Record one deterministic, redacted, tenant-safe fixture corpus for resource
lifecycle examples. The corpus includes deploy, manage, migrate, rollback,
import/adopt, drift, stale projection, policy-denial, contract-incompatibility,
and support-evidence paths. Each path carries shared `dx.lifecycle.*` fixture
facts so downstream proofs consume the same accepted resource, plan, gatekeeper,
actor, projection, log, drift, import/adopt, migration, and support evidence.

## Alternatives

- Let each downstream proof create its own fixtures. Rejected because it invites
  one-off facts embedded inside mockups and inconsistent domain claims.
- Generate production catalog data. Rejected because HOBO-572 is a reference
  fixture proof and explicitly excludes generated production catalogs.
- Use live providers. Rejected because default proof tests must stay offline and
  deterministic.

## Parse, Don't Validate

`parseDxResourceLifecycleFixtureCorpus` is the trust boundary. Raw input is
parsed once into the `ParsedDxResourceLifecycleFixtureCorpus` parsed domain type;
consumers receive that parsed, derived type or a fail-closed error list.
Downstream SDK, CLI, API, docs, or visual examples do not accept broad raw DTOs.

## Event Architecture

- **Command** - record or amend the accepted DX resource-lifecycle fixture
  corpus.
- **Event** - append `dxFixtureCorpus.Accepted` with scenario and boundary
  evidence ids.
- **Actor** - the DX example corpus owner applies corpus acceptance events in
  order.
- **Event store** - accepted corpus events remain the durable evidence source.
- **Projection** - downstream package views fold the event log into SDK, CLI,
  API, docs, and visual fixture slices.
- **Snapshot/read store** - consumers query a parsed corpus snapshot instead of
  each reauthoring domain facts.

No production event store, projector, SDK, CLI, API, support system, or visual
runtime is implemented here.
