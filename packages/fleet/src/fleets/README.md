# Fleet commands (L32)

`createFleetCommands(deps)` implements the `FleetCommands` part of the
authority API (design §6.2, §6.9, §6.12, §6.13, §7.5): `listFleets`,
`getFleet`, `defineFleet`, `fleetView`, `fleetVerdict`, `grantSession` and
`submitWork`. `createEnrollmentAuthority` routes those routes here through
`AuthorityParts.fleets`; local mode calls it with `mode: "local"`.

## Behaviour

- **`defineFleet`** (person). Validates the record against the `FleetRecord`
  and `FleetPolicy` rows of §7.2 (refusal `invalid-request`, `detail.rule`
  names the rule). `ONE_ACTIVE` is refused in `mode: "authority"` with
  `fleet-policy`, rule `one-active-authority` (D39), and accepted in
  `mode: "local"`. A fleet's coordination mode never changes
  (`fleet-policy`, rule `coordination-immutable`). A new fleet is governed as
  `fleet.define` and journalled as `fleet.FleetDefined` (revision 1); a change
  is governed as `fleet.policy.change` and journalled as
  `fleet.FleetPolicyChanged` (next revision); a PUT of the current policy
  journals nothing. The signed record is published to the registry at once,
  so enrollment (which reads fleets from the registry) sees it before the
  first enrollment; a failed publish answers `unavailable` and a retry
  publishes it.
- **`listFleets`, `getFleet`** (person, device or account). From the journal,
  signed at read time (30-minute `not_after`).
- **`fleetView`** (reader). The registry's view, re-signed; before the
  projection has published one, a view built with `fleetView` of L03 from the
  registry's members (all `LOST`).
- **`fleetVerdict`** (reader, or a workload token whose repository the fleet
  lists in `repositories`; otherwise `forbidden`). `fleetVerdict` of L03 over
  the same view. Labels are at most 80 characters.
- **`grantSession`** (person or device). The peer must be an `ACTIVE`
  `DEVICE` with a seal key; a device initiator must be `ACTIVE`, initiate as
  itself, present the transport identity and seal key registered in its key
  bundle (the member id when it has no transport key), and share a fleet with
  the peer. Some such fleet must list the purpose in `session_purposes`
  (`fleet-policy`, rule `session-purpose`). `fleet.session.grant` is governed
  (a device's tags are `role:<n>` of its roles in that fleet). The grant
  lives `ttl_seconds` (600 when zero, at most 3600) and is journalled as
  `fleet.SessionGranted` on `fleet-session-<sessionId>`.
- **`submitWork`** (person or account). Only `MANY_ACTIVE` fleets whose
  `work_kinds` include `oci-command` (`fleet-policy`, rules `coordination`,
  `work-kind`); every egress host must be in the fleet's `egress_allow`
  (rule `egress`). Governed as `fleet.work.submit` (an account's tags are its
  scopes). The `WorkSubmission` is signed, journalled as
  `fleet.WorkSubmitted` on `fleet-work-<WorkDigest>` and published to
  `FLEET_SUBMISSIONS`; `ttl_seconds` is 3600 when zero, at most 86400.

## Event data (frozen by D57)

`fleet-fleet-<FleetId>`: `subject` (`fleet.<FleetId>`), `subjectSequence` and
`revision` (the record's revision after the event), `record` (protobuf JSON
of the `FleetRecord` without `issued_at` and `not_after`).

`fleet-session-<sessionId>`: `subject` (the stream id), `subjectSequence` 0,
`sessionId`, `fleet`, `purpose`, `initiator` (member id, else principal),
`acceptor`, `expiresAt`, `grant` (protobuf JSON of the `SessionGrant`).

`fleet-work-<WorkDigest>`: `subject` (the stream id), `subjectSequence` 0,
`submissionId`, `workDigest`, `fleet`, `kind` (`oci-command`), `workKey`
(the submission id), `author`, `submittedAt`, `expiresAt`, `submission`
(protobuf JSON of the `WorkSubmission`), `envelope` (protobuf JSON of its
signed envelope).

## Idempotency

`defineFleet` appends with `expectedSeq` and retries up to 8 times, so two
instances on one store never lose a change. The submission id is the first 32
hex of SHA-256 over the tenant, the author and the canonical request (env in
key order) plus a generation counter, and the work digest is
`sha256("oci-command" ‖ 0x00 ‖ submission id)`, so a retried request lands on
the same stream and is answered without publishing again. Once the earlier
submission has expired, the same request is new work under the next
generation. A submission this instance journalled but failed to publish is
published by the next retry to the same instance.
