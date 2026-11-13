# `@hobo/fleet`

One package for every fleet (ADR-0182). A **fleet** is a named set of members
inside one tenant, with one policy and one coordination mode; a **member** is a
`DEVICE` (runs the agent and holds its own keys), a `BACKEND` or a `TARGET`
(declared and observed by a sponsor). This package owns member identity,
enrollment, the registry, health and capacity observation, and both ways of
coordinating members: `MANY_ACTIVE` (work is offered, claimed, ordered and
receipted) and `ONE_ACTIVE` (the assignment register decides which member is
active). It has no I/O beyond `node:crypto`: the bus, the key stores, the
sandboxes and the transports are ports, implemented in `@hobo/fleet-nats`,
`@hobo/fleet-agent`, `@hobo/fleet-p2p` and `@hobo/connectivity`.

It is used in two modes with one code path. In **authority mode** members cross
a trust boundary, records are signed and credentials issued. In **local mode**
(`createLocalFleet`) one process declares, observes and assigns its own fleet
with the same records and state machine and nothing signed; the hosted relay's
cache fleet uses it.

## Entry points

| Subpath | Holds |
|---|---|
| `@hobo/fleet` | Generated records, the ports of `src/ports.ts`, `FleetError` codes, the signing contexts, event and log-event names, branded ids and their `parse*` constructors |
| `@hobo/fleet/keys` | JWKs and thumbprints, member ids, signed and witnessed envelopes, trust acceptance, DPoP, sealing, session keys, fingerprint words, the in-memory key store and credential issuer |
| `@hobo/fleet/membership` | The enrollment authority, fleet commands, local mode, sign-in, the recorder and registry projection, governed decisions |
| `@hobo/fleet/observation` | Observations, fit, eligibility for active, ranking and claim turns, fleet views and verdicts, the reliability ledger |
| `@hobo/fleet/assignment` | The one-active assignment register (moved from `@hobo/backend-routing`, names kept), membership epochs, the cache-key replica, the one-active loop |
| `@hobo/fleet/work` | Work digests, trust classes, sandbox tiers, order, claim and start-fence checks, the dispatcher and executor, the `oci-command` work kind |
| `@hobo/fleet/transport` | Session authorisation, AEAD framing, transport selection, serving sessions, verified blob fetch |
| `@hobo/fleet/audit` | The audit hash chain, its verification, the witness |
| `@hobo/fleet/agent` | The device agent |
| `@hobo/fleet/client` | The typed HTTP client of the authority |
| `@hobo/fleet/verdict-wire` | `parseFleetVerdict`, a file with no imports for the route job |
| `@hobo/fleet/testing` | The in-memory bus, event store and fake sandbox, `createTestAuthority`, and the conformance suites |

Each subpath is a barrel that only re-exports the directory of the lane that
builds it; until a lane lands, its entry points have their final signatures and
throw `FleetNotImplemented`.

## Landed parts

Each lane writes its part of this README next to its code; the coordinator
gathers them here as the waves merge.

- **Keys** (`@hobo/fleet/keys`, wave 1) —
  [`src/keys/README.md`](src/keys/README.md). JWK parsing and RFC 7638
  thumbprints, member ids (`dev_` + 32 hex of SHA-256 of the thumbprint text;
  `bkd_`/`tgt_` from tenant, kind, fleet and name), signed and witnessed
  envelopes, trust acceptance against the pinned record, RFC 9449 DPoP with
  `jti` claimed per `dpop:<jkt>`, sealing and session keys with the §7.4
  parameters, BIP-39 fingerprint words, and the in-memory key store and
  credential issuer. `node:crypto` only. The memory key store also runs the
  shared `runKeyStoreConformance` suite.
- **Assignment** (`@hobo/fleet/assignment`, wave 1) —
  [`src/assignment/README.md`](src/assignment/README.md). The one-active
  register moved from `@hobo/backend-routing` with its algorithm unchanged,
  log formats 1 and 2, the cache-key replica (stored key
  `hobo:fleet:assignment`), membership epochs (off by default) and
  `createOneActiveFleet`. The loop uses `eligibleForActive` from
  `@hobo/fleet/observation`.
- **Conformance suites** (`@hobo/fleet/testing`, wave 1) —
  [`src/testing/conformance/README.md`](src/testing/conformance/README.md).
  The seven suites (bus, transport, sandbox logic, sandbox isolation probe,
  key store, replica, journal) every adapter of a fleet port runs against
  itself, and what each `make` must return.

- **Membership** (`@hobo/fleet/membership`, wave 2, L02) —
  [`src/membership/README.md`](src/membership/README.md). The enrollment
  authority: members and bootstrap tokens, approval (`SINGLE`, `DUAL`,
  `AUTO_OWNER`), sponsored members, credentials and session tickets,
  `authenticate`, clone detection by generation, and claim reports. It
  implements the member and token methods of `FleetApi` and routes the rest to
  `AuthorityParts`; after each record change it also publishes the signed
  record to the registry straight away.
- **Sign-in** (`@hobo/fleet/membership`, wave 2, L30) —
  [`src/signin/README.md`](src/signin/README.md). `createSignIn`: browser
  (PKCE, loopback redirect) and device-code flows that issue a 15-minute,
  DPoP-bound person token, refreshable for 12 hours.
- **Observation** (`@hobo/fleet/observation`, wave 2, L03) —
  [`src/observation/README.md`](src/observation/README.md). Signed
  observations and `acceptObservation`, `fitWork`, `eligibleForActive`,
  ranking and claim turns, fleet views and verdicts, `parseFleetVerdict`, and
  the reliability ledger. Moved from `packages/ci/src/mesh/`.
- **Transport** (`@hobo/fleet/transport`, wave 2, L28) —
  [`src/transport/README.md`](src/transport/README.md). Session
  authorisation, ChaCha20-Poly1305 framing, transport selection (`p2p`, then
  `overlay`, then `bus-relay`), the session server with its private session
  protocol (shell and forward are batched, not interactive), and verified blob
  fetch.
- **Audit** (`@hobo/fleet/audit`, wave 2, L06) —
  [`src/audit/README.md`](src/audit/README.md). The authority's hash chain
  with checkpoints every 60 s or 1,000 entries, `verifyAuditChain`, and the
  witness that co-signs checkpoints and trust proposals. Only one replica may
  run the chain.
- **Work** (`@hobo/fleet/work`, wave 3, L04) —
  [`src/work/README.md`](src/work/README.md). Work digests, trust classes,
  sandbox tiers, the dispatcher's claim rules (`discard`, `not-entitled`,
  `early`, `valid`), the dispatcher and executor loops, order acceptance with
  receipts, the start fence, and the `oci-command` work kind (its work key is
  the submission id).
- **Recorder and registry projection** (`@hobo/fleet/membership`, wave 3,
  L31) — [`src/recorder/README.md`](src/recorder/README.md). The recorder
  verifies and journals offers, claims, orders, receipts and session-close
  facts with per-stream resume points, and is the only emitter of the four
  fleet usage types; the projection re-signs member and fleet records (fleet
  records first) and publishes fleet views.
- **Fleet commands** (`@hobo/fleet/membership`, wave 3, L32) —
  [`src/fleets/README.md`](src/fleets/README.md). `listFleets`, `getFleet`,
  `defineFleet`, `fleetView`, `fleetVerdict`, `grantSession` and
  `submitWork`, journalled on `fleet-fleet-*`, `fleet-session-*` and
  `fleet-work-*`; a fleet's coordination mode is immutable and `submitWork`
  is idempotent while the earlier submission is unexpired.

## Gates

- **TypeScript:** `pnpm --filter @hobo/fleet run build`.
- **Protobuf + CUE:** `data-models/fleet.proto` holds every record and
  `data-models/fleet.cue` constrains every message, with valid and invalid
  fixtures under `data-models/fixtures/`; `src/_generated/fleet_pb.ts` is
  generated by `pnpm codegen --filter packages/fleet`. Parse, don't validate:
  ids are branded derived types built only by `parseMemberId`, `parseFleetId`,
  `parseMemberName`, `parseWorkDigest` and `parseKeyId`, and every signed record
  is a parsed type reached only through envelope verification.
- **PACT:** `contracts/` (a placeholder until the authority client and the
  cache-key replica pacts land).
- **Contract snapshot:** `contracts/api.snapshot.d.ts`, checked by
  `node --import tsx scripts/emit-fleet-contracts.mts --check`.
- **Tests:** `test/<area>/` per subpath; `pnpm exec turbo run test --filter @hobo/fleet`.

## Architecture placement

A contract-layer package (it imports only `@hobo/core` and
`@bufbuild/protobuf`), so data, routing, runtime and adapter packages may
depend on it. State is event-sourced: every command of the enrollment
authority reads its stream on the core event store (`FleetEventStore`), decides,
and appends `fleet.*` events with `expectedSeq`; commands are idempotent on
their natural key. Each device's agent is an actor with its own mailbox on the
bus. Projections (materialized views) build the registry, fleet views and
verdicts, reliability, work status and the audit chain by replay; snapshots are
caches only, and the read stores are the `fleet-registry` and `fleet-views`
buckets and the event stream for work logs. One-active assignments are not
events: they live in the members' own logs.
