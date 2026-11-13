---
layout: ../../layouts/Docs.astro
title: Errors & codes
description: "Stable machine-readable error codes for EventStore, aggregates, contracts, queue, resilience, and identity — map at boundaries, never string-match prose."
---

# Errors & codes

Prefer **stable codes** over string matching. Map adapter errors at package boundaries. Do **not** leak SQL, filesystem paths, or secret material into app-facing errors.

## Shape conventions

Errors that cross a boundary should carry:

| Field | Role |
|---|---|
| `code` | Stable SCREAMING_SNAKE or dotted machine code |
| `message` | Human-safe summary (no secrets) |
| `retryable` | Explicit when known (do not infer from message) |
| `cause` chain | Internal only; strip before external MCP/CLI if sensitive |

Parse-don’t-validate constructors throw typed parse errors (`CoreParseError`, `EffectValidationError`, …) rather than returning “maybe invalid” DTOs.

## EventStore / storage

| Code | Meaning | Typical retry |
|---|---|---|
| `OPTIMISTIC_SEQUENCE_CONFLICT` | Stale `expectedSeq` | Yes — reload stream |
| `STALE_FENCE` | Fence below `owner_epoch` | No as OCC retry |
| `MISSING_FENCE` | Unfenced write to fenced stream | No — acquire lease |
| `CHECKPOINT_REGRESSION` | Non-monotonic checkpoint | No |
| `UNSUPPORTED_SCHEMA_VERSION` | DB newer than code | No — upgrade binary |
| `MIGRATION_FAILURE` | Migrate failed | No until fixed |
| `STREAM_INTEGRITY` | Noncontiguous / head mismatch | No |
| `UNSUPPORTED_CODEC` | Unknown payload codec | No |
| `PERSISTENCE_UNAVAILABLE` | e.g. OPFS required but missing | No / change mode |
| `SQLITE_BUSY` | Busy timeout | Maybe — backoff |
| `SNAPSHOT_AHEAD` | Snapshot seq > head | No |
| `STORAGE_WORKER_TERMINATED` | Worker crash | Restart worker |

## Aggregates 

| Code | Meaning | Retry? |
|---|---|---|
| `AGGREGATE_CONFLICT` | OCC / concurrent writers | Yes — reload & retry |
| `AGGREGATE_INVARIANT` | Business rule reject | No |
| Stale fence surfaced at aggregate | Lost lease | No blind retry |

## Resilience failure classes

| Class | Retry via ResilienceProfile? |
|---|---|
| `transient` | Yes (within profile) |
| `policy.Decided` | **Never** |
| `terminal` | **Never** |
| `cancellation` | **Never** |
| `deadline` | Policy-dependent; not infinite retry |

## Contracts / Gatekeeper

Compatibility and gate denials surface as structured reasons (`MachineReadableReason` with `gate: contracts | policy | obligations | cost | effects | resilience`), not only thrown exceptions. CLI/MCP should print reason codes agents can act on.

## Identity / config

Prefer ref-safe messages (“resolution rank failed at provider-federation”) over embedding token fragments. Static-escape expiry is a hard fail, not a silent fallback to plaintext.

## CI fleet

Why a runner provider was not chosen for a job. [Fleet balancing](/HoBo/ci/fleet-balancing/) returns one of these for every provider it skips; a pricing or budget refusal carries that engine's own code behind a `pricing.` or `budget.` prefix.

<!-- generated:ci-fleet-codes:start -->
<!-- Generated from the fleet code by packages/ci/scripts/fleet-docs.ts. Do not edit by hand. -->

| Code | Meaning | Typical retry |
| --- | --- | --- |
| `fleet.disabled` | The provider is not enabled in policy | No: enable the provider |
| `fleet.unhealthy` | The provider's host is critically short of a resource | Yes, when the host recovers |
| `fleet.label-bound` | The job is already queued on a label this provider does not serve | No: the label is fixed once queued |
| `fleet.visibility` | The provider does not serve this repository's visibility, or public repositories are not turned on there | No: a fact about the provider |
| `fleet.organization-only` | The provider serves organization-owned repositories only | No: a fact about the provider |
| `fleet.docker` | The job needs Docker and the provider has none | No: a fact about the provider |
| `fleet.fork` | The provider does not run jobs from forks | No: a fact about the provider |
| `fleet.isolation` | The job needs its own machine and this provider is shared | No: a fact about the provider |
| `fleet.machine` | The job needs more CPU or memory than this provider's machine class has | No: a fact about the machine class |
| `fleet.runtime` | The job's reserved minutes exceed the longest the provider lets one machine run | No: a fact about the provider |
| `fleet.capacity` | Every slot is in use | Yes, when a slot frees |
| `fleet.agreement.new-denied` | Placing the job would open a new paid plan | No: open the plan, or allow it |
| `fleet.payer-budget` | The job would exceed the operator's ceiling for that provider account | No: raise the ceiling or wait for the period |
| `fleet.account-budget` | The job would exceed the account's ceiling | No: raise the ceiling or wait for the period |

<!-- generated:ci-fleet-codes:end -->

## Related

[EventStore](/HoBo/reference/eventstore/) · [Effects](/HoBo/reference/effects/) · [ActorHost](/HoBo/reference/actor-host/) · [Contracts](/HoBo/reference/contracts/)
