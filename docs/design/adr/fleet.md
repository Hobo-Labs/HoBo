---
type: Architecture Decision Record
title: "HoBo Fleet: One Package for Every Fleet"
description: "One package, @hobo/fleet, owns member identity, enrollment, the registry, observation, many-active work (offers, claims, orders, receipts) and the one-active assignment register for every kind of fleet member: devices, sponsored backends and sponsored targets. NATS in operator mode behind @hobo/fleet-nats, peer-to-peer streams behind @hobo/fleet-p2p, an authority with a witness, and cost-based choosing kept outside in @hobo/ci and @hobo/backend-routing."
tags: [hobo, design, adr, fleet, ci, identity, security, nats]
---

# ADR-0183 — HoBo Fleet: One Package for Every Fleet {#adr-0183}

**Status:** Accepted. Built and tested in the repository; not proven in
production until a production observation is linked here. None is linked
yet.
**Date:** 2026-11-14
**Design narrative:** [HoBo Fleet](../fleet.md). Runbooks:
[`docs/maintenance/fleet/`](../../maintenance/fleet/index.md).
**Supersedes:** [ADR-0180](fleet-verdict.md#adr-0180) (the hosted fleet
verdict, its reporter keys, signed reports and agreement across reporters);
[CI Relay Mesh](../ci-relay-mesh.md); the
[fleet enrollment design](../fleet-enrollment-design.md) (`fleet-v2`); the
Camp enrollment model of [ADR-0182](01-architecture-core.md#adr-0182) D19.
**Amends:** [ADR-0181](routing-slips.md#adr-0181) (the routing slip stays;
its reasons now come from `@hobo/fleet` `fleetVerdict` and its leader from
rank 0 of `rankMembers`); [ADR-0122](07-portability-extensibility.md#adr-0122)
(the overlay port is named `overlay`); [ADR-0179](hosted-relay-stateless.md#adr-0179)
(the cache fleet is a local-mode one-active fleet of `@hobo/fleet`).
**Out of scope, unchanged:** [ADR-0031](01-architecture-core.md#adr-0031)
(the component runtime's host lattice).

## Context

HoBo had several kinds of thing that join a group, are trusted, are watched
for health and are chosen to do work: machines that run CI jobs, delivery
agents, junction hosts, storage backends behind the hosted relay, deploy
targets. Each kind had its own way of joining, its own identity, its own
health record and its own rule for who is active. None was secure enough to
let a developer enroll their own device, and a bug fixed in one stayed in
the others.

- **Six enrollment models that shared nothing:** a hand-edited list of mesh
  node keys; a repository variable naming the local runner; `fleet-v2`
  device and cluster enrollment with no credential code; the fleet verdict's
  reporter keys in relay configuration; the delivery agent's bootstrap token
  to key to SVID; and storage backends that joined only by editing
  configuration.
- **Two unrelated fleet implementations:** the compute mesh (`@hobo/ci`
  `mesh/`, the `mesh-*.ts` files of `@hobo/ci-gh-actions`) and the storage
  backend fleet (`@hobo/backend-fleet`, `@hobo/data-postgres` `fleet/`, the
  hosted relay's cache fleet).
- **Ten member-identity types** across the overlay adapters, environment
  membership, two JWT-SVID claim types, launch measurements, junction
  manifests, backend ids and mesh node reports.
- **NATS with no security model:** one shared token, no TLS options, every
  node holding stream-administration rights, and job claims in a KV bucket
  that any publisher could overwrite, delete or purge.
- **Work with no sandbox:** a developer machine ran jobs as the developer;
  the box worker mounted the host Docker socket by default with no
  capability drop, seccomp profile or read-only root.
- **Fleet state through repository variables** with hand-written parsers,
  three DPoP implementations, two SVID implementations (one signing with a
  public default secret), unreachable overlay joins, an unauthenticated
  `decidedBy` string choosing a storage fleet's active backend, and no
  rotation, revocation, clone detection, audit trail, minimum agent version,
  deployment assets or runbooks for any of it.

## Decision

One package owns every fleet, and everything that was a second
implementation of one of its ideas is deleted. The design narrative,
[HoBo Fleet](../fleet.md), describes the result; the decisions it rests on
are these.

### Packages and terms

1. **D1 The common package is `@hobo/fleet`.** "Fleet" has one owner and
   describes every member kind. "Mesh" names only the coordination plane
   among a tenant's devices (the bus they share and the transports between
   them); it is not a package, not the network overlay and not the in-process
   internal router.
2. **D2 Six packages: one domain package and five edges.** `@hobo/fleet`
   (contract layer: domain logic, records, ports, in-memory adapters, local
   mode, the typed client, test kits; no I/O beyond `node:crypto`);
   `@hobo/fleet-nats` (every NATS interaction); `@hobo/fleet-p2p` (the only
   native binding); `@hobo/fleet-agent` (key stores, sandbox drivers, the
   egress proxy, host capacity, service installers); `@hobo/fleet-authority`
   (the authority service, sign-in providers, operations, the status feed,
   the witness); `@hobo/backend-routing` (cost-based choosing among storage
   backends, renamed from `@hobo/backend-fleet`). The domain must sit at the
   contract layer so that `@hobo/data-postgres`, runtimes and adapters can
   import it, and I/O must stay out of it.
3. **D3 Three member kinds.** `DEVICE` holds its own keys; `BACKEND` and
   `TARGET` hold none and are sponsored: a sponsor declares them, holds a
   reference to their credential and observes them. That is the one
   difference that matters to enrollment and observation.
4. **D4 Two coordination modes in one package.** `MANY_ACTIVE`: members
   claim units of work. `ONE_ACTIVE`: exactly one member is active, decided
   by the assignment register. These are the two ways existing code decided
   who does the work, and both need the same member, registry and health
   records.
5. **D5 Cost-based choosing stays outside.** Runner provider selection lives
   in `@hobo/ci` `runner-routing`; storage backend selection in
   `@hobo/backend-routing`. Both depend on pricing and budget policy, which
   the fleet package must not import. They read members, health and capacity
   from `@hobo/fleet` and write their choice through it.
6. **D6 Local mode.** A process that owns its whole fleet (the hosted relay
   and its cache backends) runs the same code with an in-process registry,
   no authority, no bus and no signatures. The relay must keep working with
   no other service (ADR-0179), and signing records to oneself adds a key to
   manage and no protection.
7. **D12 Provider selection in `@hobo/ci` is "runner routing".** The route
   job's user-facing mode value `fleet` stays: it means "the hobo fleet",
   which is now literally true.

### The one-active assignment register

8. **D7 Assignment entries stay unsigned.** One-active fleets run only in
   local mode, where whoever can write the assignment key can already write
   every record the fleet stores.
9. **D8 A membership change is a decided epoch, one member at a time.** The
   set that decides epoch `e` is the set carried by decided epoch `e − 1`,
   derived from entry `e` itself; a log with no member sets is first pinned
   to the configured set. Before this, the majority size changed silently
   whenever configuration changed, which could let two entries be decided
   for one epoch.
10. **D9 The stored log stays readable both ways.** It keeps its key, its
    `format` field and every existing field with its type. Member sets are
    written only as format 2, and only once a fleet's policy sets
    `membership_epochs`, so a previous relay reads every log a new one
    writes until that switch is turned on.
11. **D10 `@hobo/data-postgres` `fleet/` is kept and rewired.** Its tick
    becomes a caller of `createOneActiveFleet`; its two re-export files are
    deleted. It is the second consumer that shows the register is
    engine-neutral.
12. **D39 One-active fleets in authority mode are out of scope.** The
    authority refuses to define one (`fleet-policy`, rule
    `one-active-authority`), serves no override, writes no assignment events
    and publishes no "active" field in views. Nobody would own the loop
    there: members' logs live in their own stores, and signed entries would
    have to verify against principals that hold no key.
13. **D43 Health eligibility is one function.** `eligibleForActive` answers,
    per member and with reasons, whether it could be made active on health
    alone. `decideFleet` and `routeFleetByBudget` keep their names, outputs
    and ranking and take `NamedObservation`s.
14. **D46 The one-active loop reports the cache fleet's tick values.**
    `OneActiveTick` carries today's values (`single`, `bootstrap`,
    `activate`, `sealed-waiting`, `reseal`, `keep`, `hold`, `switch`,
    `failover`, `no-majority`, `undecided`) plus `membership`; a single
    member bypasses the register; `chooseAction` is asynchronous and gets
    the members in configured order.

### Delivery and the CI box

15. **D11 Camp inventory keeps its placement policy.** Taints, claims,
    management mode and typed signal sources stay with `@hobo/cd`. Member
    identity and lifecycle come from the fleet: every Camp is backed by a
    member, and a revoked or suspended member becomes a `NO_PLACE` taint.
    Reachability comes from the fleet only where a device observes the
    member; an agentless Camp keeps its signal sources.
16. **D19 This supersedes `fleet-v2` (#1688) and the hosted verdict with
    ADR-0180's reporter layers (#1952).** Each was a partial second
    implementation. Their useful parts are kept: the start fence, and the
    verdict as a function (`fleetVerdict`) of a signed fleet view.
17. **D23 The dedicated box may keep the host Docker socket** for fleets
    `hobo` and `hobo-trunk` through `allow_host_docker`, and nowhere else.
    The flag is off by default and allowed only for dedicated-only fleets.
    Moving those jobs to `S3` and removing the flag is follow-up work.
18. **D26 Profiles.** The standalone profile runs on the CI box; high
    availability is three hosts in one region, the smallest cluster that
    survives one loss.
19. **D30 Whether a device offers `S3`** is decided by its driver's
    self-test at start, not by configuration.
20. **D34 The route job reads the routing slip** with `contents: read`
    (ADR-0181). The authority's verdict route accepts a GitHub Actions OIDC
    token for reading only.
21. **D60 `BUSY` is not `NO_CAPACITY`.** `VerdictState` has `BUSY`, and an
    observation carries a `refusal` reason (`NONE`, `OWN_WORK`, `PRESSURE`,
    `STORAGE`, `DRAINING`), so a box that is busy only with its own jobs is
    never refused (ADR-0181 R4). Routing treats `BUSY` like `OPEN`
    (`fleet-busy`).
22. **D61 A box takes fleet settings only from committed config** (the
    `fleet` block of `.hobo/ci.json`, beside `runnerRouting`) or from its
    enrolled `AgentState`, never from environment variables (ADR-0181 R2).
    Only a file path to the state or the token may come from the process.
23. **D62 The routing slip stays as routing.** Its issuer is re-pointed to
    `fleetVerdict` for its reasons and to the rank-0 dispatcher of
    `rankMembers` for its leader. Main's `fleet-v2` code and the hosted
    verdict and reporter stack are deleted, so one implementation of each
    idea remains.

### NATS

24. **D13 NATS enforces; the authority decides.** Per-device credentials
    come from auth callout in operator mode, with a public deny-all sentinel
    user that selects the tenant account. NATS's JWT format is specific to
    it, and callout is the documented way to bring outside identity.
25. **D14 A device holds no NATS key.** It proves itself with its `SIGN` key
    over the server's nonce inside the connect token, under the context
    `hobo-fleet/nats-connect/v1`, so the server cannot obtain a signature
    usable anywhere else.
26. **D15 Devices connect as plain TLS clients, not leaf nodes.** A leaf
    node is a second server on every laptop, and the leaf-node port carried
    the year's worst advisories.
27. **D16 Claims are a stream** with one message per subject and
    discard-new, not a KV bucket: create-only cannot be enforced by
    permissions on a KV bucket.
28. **D25 One tenant per relay account.** HoBo's own tenant is `hobo`; each
    tenant has one NATS account, the server's isolation boundary.

### Identity, trust and work

29. **D17 A device is punished only on evidence it signed itself.** Forged
    or replayed claims are deleted and attributed to nobody; otherwise any
    device could have any other suspended.
30. **D21 The trust class of work is derived on the device.** A dispatcher
    never asserts `OWN`, so a compromised dispatcher cannot lower a personal
    device's sandbox.
31. **D22 Fork and public work never runs on personal or dedicated
    devices.** It goes to `EPHEMERAL` devices at `S3`.
32. **D24 Sign-in providers.** `github` and generic `oidc` are built and
    enabled by configuration; `atproto` is built and off, because AT
    Protocol has no per-device keys and can only identify the person.
33. **D27 The witness is a separate process** with its own key and bus
    user. It is the only check on the authority; on the box it runs under a
    different operating-system account, which the standalone profile
    documents as weaker.
34. **D29 Windows devices are supported at `S1`, own work only.** No
    per-order virtual machine mechanism ships for Windows.
35. **D31 No automatic self-update.** A minimum agent version is enforced at
    ranking and at credential refresh instead.
36. **D32 Authority signing keys live in the secret store** behind
    `SecretsPort`. `KmsLike` is synchronous, so a non-exportable key needs a
    port change, recorded as follow-up.
37. **D35 Fleets are closed.** There is no open marketplace: attestation on
    consumer hardware can be forged, and open enrollment has no Sybil
    defence.
38. **D36 Peer-to-peer transport is iroh behind a port**, with self-hosted
    relays; the overlay and the bus relay are fallbacks. It is the one option
    with a stable wire format, an official Node binding and key-based
    dialling, and the port keeps it replaceable.
39. **D42 Sponsored member ids hash tenant, kind, fleet and name.** Name
    uniqueness per fleet is checked by the commands against the projection
    (`name-taken`); in authority mode only a `DEVICE` sponsor's observations
    count, because only a device has a `SIGN` key.
40. **D44 A browser enrollment signs the person in with the device identity
    key**, so the fingerprint the person approves is the key that enrolls.
41. **D45 The witness matches a registry change to an audit entry by key and
    record sequence.** A re-sign keeps the sequence and is not a change.
42. **D54 Overlay join credentials are minted by the authority at
    enrollment**, for `ACTIVE` devices only, with a 10-minute lifetime. A
    failing minter is left out of `overlay_joins` and does not fail the
    enrollment; the bus relay is always there.
43. **D58 The sandbox runtime is not a host prerequisite.**
    `@hobo/fleet-agent` provisions gVisor `runsc` itself (release
    `20261026.0`, verified against SHA-512 values pinned in source, unpacked
    in-process), probes privilege mode instead of assuming it, and does not
    advertise a tier it cannot provide (`hobo_fleet_sandbox_unavailable`).
    Without cgroup v2 delegation `runsc` runs with `--ignore-cgroups` and the
    sentry enforces memory and pids limits; CPU is then not capped. A `runsc`
    sandbox satisfies `S1` and `S2`.
44. **D59 Violation reports stay one per offer** and the authority counts
    early claims per claimant across reports; a bus-relay session party
    carries `relay:<SEAL key>`; `report()` checks claims against the
    projection's ranking, never an empty one.

### Storage, recording and metering

45. **D33 The event store** is JetStream (`FLEET_JOURNAL`) in the
    high-availability profile and SQLite in standalone (ADR-0135). A
    Postgres `FleetEventStore` is out of scope.
46. **D38 Authority-side code uses `FleetEventStore`** (the core port plus
    `readAll`), and bus subscriptions take a start position, so the audit
    chain, projection rebuilds and recorder catch-up have an ordered read
    and a resume point.
47. **D40 One emitter per usage type.** The authority's recorder and
    projection emit all four fleet usage types; two emitters would
    double-bill.
48. **D41 `@hobo/fleet-agent` imports only `@hobo/fleet` and `@hobo/core`.**
    `hobo fleet run` and the box worker compose it with the bus and the
    transports.
49. **D57 Event data is the shape the first writer appended.** The data of
    the `fleet-member-*`, `fleet-fleet-*` and `fleet-token-*` events is what
    the enrollment and fleet commands write; nothing invents a second shape,
    and each event's data names the record `sequence` it produced.

### Contracts and verification

50. **D20 This record is ADR-0183**, the next free number after ADR-0180 to
    ADR-0182.
51. **D18, D37, D62 Base and order.** The work was built from one base on
    `main`, with `main` merged in once so that delivery, the routing slip
    and the removal of `fleet-v2` and the verdict stack share one base. Each
    part was verified against what was already merged; parts that compose
    in the same step are joined by parameter, never by module mocking.
52. **D47 Every outcome is one command,** `pnpm run fleet:outcome <id>`,
    that fails on a missing named file, a skipped test or an unmet
    threshold.
53. **D48 A fallback has its own threshold,** selected only through
    `fleet-fallbacks.json`.
54. **D49 Sandbox isolation is proven inside real sandboxes**
    (`runSandboxIsolationProbe`), separately from the driver logic suite; at
    least the `S1` driver must be present, and the start fence is tested once
    with a real `S1` sandbox and the real hook script.
55. **D50 Moved tests are checked mechanically** (`pnpm run
    fleet:moved-tests`): in `exact` mode only imports, named helpers and
    fixed rename and value maps may differ; in `assertions` mode every test
    title and `expect` statement must stay.
56. **D51 Verification is a protocol a script can run** (`pnpm run
    fleet:verify`).
57. **D52 Contract snapshots** (`contracts/api.snapshot.d.ts`) are written
    only by `scripts/emit-fleet-contracts.mts` in commits carrying a
    `Fleet-Contract:` trailer, and `pnpm run fleet:contracts` compares
    against the newest such commit.
58. **D53 What is not verified before cutover is said so.** Availability
    targets, the five-minute enrollment goal, a real identity provider and
    release attestations need production traffic, a person's machine,
    registered OAuth clients or a real release. They are built, not proven,
    until a production observation is linked.
59. **D55, D56 Contract amendments.** `ById` defaults to an empty object
    type; `AuditLog.onCheckpoint` and `KmsLike.keyIds`/`activeKeyId` are
    optional; `P2P_ENDPOINT_KEY_CONTEXT` is a derivation label outside
    `FLEET_CONTEXTS`; `hobo_fleet_egress_refused` is a log event. Declined:
    DPoP proofs in the sign-in method signatures (bound at the transport
    instead), a host Docker field on observations (`docker` is met only by
    `S3`), and streaming stdin or `connect(port)` on `Sandbox` (v1 shell and
    forward sessions are line-batched execs and forwarded requests; streaming
    is a follow-up ADR).
60. **D28 ADR-0031 is out of scope and unchanged.** It rests on the
    wasmCloud v1 lattice over NATS, which wasmCloud v2 removed; that is a
    runtime decision, not a fleet one, and nothing here depends on it.

## Consequences

- **(+)** One place to fix a bug: compute devices, delivery agents,
  junction hosts, storage backends and deploy targets are members of fleets
  in one model, with one identity, one enrollment state machine, one
  observation record and one health vocabulary.
- **(+)** A developer enrolls their own device in one command with no shared
  secret on disk (`hobo fleet enroll`), and their work runs in a sandbox
  chosen on the device from facts it checks.
- **(+)** Nothing that grants trust depends on the bus operator: every
  registry record, view, order and grant is signed against a pinned,
  witnessed trust record and expires. A compromised bus can delay work and
  hide a revocation for at most a record's lifetime (30 minutes), never
  grant anything.
- **(+)** The hosted relay's cache fleet keeps working with no other
  service, now on the same register as every other one-active fleet, and
  its stored log stays readable by the previous relay until
  `membership_epochs` is turned on.
- **(+)** Every operation has a runbook
  ([`docs/maintenance/fleet/`](../../maintenance/fleet/index.md)) and every
  deployment asset lives in `deploy/fleet/`.
- **(−)** Three new operated services (the authority, the witness, the
  peer-to-peer relay) and a NATS cluster in the high-availability profile.
- **(−)** The callout is a single point of failure for new bus connections;
  it runs as two or more responders in one queue group.
- **(−)** Clone detection needs both copies of a key to refresh: a copy of a
  device that stays offline works until the original returns. A held key
  (`T1` or above) is the defence.
- **(−)** In the standalone profile the witness shares a host with the
  authority, which protects against a database writer, not against whoever
  controls the host.
- **(−)** Not built here, on purpose: non-exportable authority keys (needs
  an asynchronous `KmsLike`), authority-mode one-active fleets, a Postgres
  `FleetEventStore`, automatic agent self-update, interactive streaming
  shells, and moving the box's Docker jobs to `S3`.
