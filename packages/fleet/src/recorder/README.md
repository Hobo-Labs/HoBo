# Recorder and registry projection (L31)

`createRecorder` and `createRegistryProjection`, re-exported by
`@hobo/fleet/membership`. Together they are the only emitters of the four
fleet usage types (D40).

## Recorder

- Reads offers and claims (per fleet), every order (`observeAll`), receipts
  and session-close facts, and log chunks from the bus.
- Verifies every envelope against the signer's `SIGN` key in the
  identity-signed key bundle of its registry record, under the one context the
  §7.4 table lists. Offers and orders must come from a `DISPATCHER` of that
  fleet; claims, receipts, logs and closes must be signed by the member they
  name and published under its subject. A refused envelope is never recorded
  and is counted: `hobo_fleet_bus_status` with `recorder: "unverifiable"`,
  `kind`, `reason` and the running `count`.
- Appends `fleet.WorkOffered`, `fleet.WorkClaimed`, `fleet.WorkOrdered` and
  the six receipt events on `fleet-work-<WorkDigest>`, and
  `fleet.SessionClosed` on `fleet-session-<sessionId>`. `meta` carries
  `busStream` (`FLEET_OFFERS.<fleet>`, `FLEET_CLAIMS.<fleet>`, `FLEET_ORDERS`,
  `FLEET_EVENTS`), `busSequence` and `idempotencyKey` (event type and the
  SHA-256 of the signed payload), so a replay, a republish or a second
  replica records each fact once. `start` resumes each subscription from
  `{ after: <highest recorded> }`. Order secrets are never journalled.
- Log chunks are not journalled: their read store is `FLEET_EVENTS` (§7.5),
  so that subscription always starts from the oldest retained chunk.
  `workLogs` answers the verified chunks of the latest order, from its
  executor only.
- `fleet.work.sandbox`: one per receipt carrying `sandbox_seconds`
  (unit `second`, metadata `tier`, `memberId`, `workDigest`).
  `fleet.transport.relay` (`bus-relay`) or `fleet.transport.direct` (`p2p`,
  `overlay`): one per session, from the acceptor's close (the grant names the
  acceptor; with no grant on record, the first close bills), with
  `crossChecked` against the initiator's close when it is already recorded.
  Each is emitted only by the append that recorded the fact first.
- `workStatus` and `workLogs` map a submission id from `fleet.WorkSubmitted`
  (`data.submissionId`) or from an offer's authority-signed submission.
- `reliability()` is `createReliabilityLedger` fed every recorded receipt; a
  new recorder rebuilds it from the journal on its first read.

## Registry projection

- Rebuilds member records from `fleet-member-*` and fleet records from
  `fleet-fleet-*`: each event's `data.record` (protobuf JSON, no signing-time
  fields), with the sequence the record carries (`record_sequence`,
  `revision`; else `data.subjectSequence`, D57).
- Signs each with `issued_at` now and `not_after` 30 minutes later (members
  also get `authority_incarnation`), publishes fleets before members, and
  re-signs every 10 minutes and always at least 2 minutes before `not_after`
  with the sequence unchanged, so the witness ignores a re-sign (D45).
- Wakes on every journal append (`store.subscribe`), so a newly defined fleet
  is on the bus before the first enrollment into it; `caughtUp()` resolves
  once everything journalled so far is published.
- Every 30 s, builds each fleet's view with `fleetView` from the verified
  observations on the board (`acceptObservation`, each new value accepted or
  refused once; refusals log `hobo_fleet_observation_rejected`) and the
  recorder's reliability, signs it and publishes it.
- `fleet.member.active`: the time each member was `ACTIVE` as seen at each
  tick, emitted once per member per completed UTC hour (unit `hour`,
  metadata `hour` and a deterministic `usageKey` a sink can deduplicate on).
- Drive `tick()` about once a second.
