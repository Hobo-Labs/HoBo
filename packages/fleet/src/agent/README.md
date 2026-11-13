# `@hobo/fleet/agent` (L07)

The device agent core (design §6.5, §6.7–§6.9, §6.12; failures F1, F4, F7,
F16, F18, F19). `hobo fleet run` and the box worker compose it with a key
store, a bus connector, sandbox drivers, an egress proxy and transports.

| Entry point | What it does |
|---|---|
| `createFleetAgent(deps)` | Returns `enroll`, `start`, `drain`, `stop`, `bus()` and `status()` |

## Enrollment

`enroll(request)` opens the key store, builds key bundle 1 (SIGN and SEAL
keys, plus a TRANSPORT key only when the `p2p` transport reports a non-empty
endpoint id), signs it with the identity key and posts the enrollment through
`createFleetClient` with a bare DPoP proof made by the identity key. It asks
for a 24-hour bundle and, when fleet policy refuses that (`fleet-policy`,
rule `key-bundle-hours`), for a 1-hour one. The answer is accepted only if
its trust record is self-consistent (`acceptTrust(undefined, …)`) and its
member record is this device's, signed by a key of that trust record; the
trust record is then pinned in `AgentState.trust`. The whole
`EnrollmentResponse` is returned, so the host can hand `overlay_joins` to its
overlay before it creates the overlay transport.

## Credentials

- The refresh nonce is written to `AgentState.pendingRefreshNonce` before
  the request leaves. A refresh whose answer is lost keeps the generation and
  the nonce, so the retry (or the next process on the same key store) gets the
  authority's same answer instead of locking the device (F19). A copied key
  store refreshes with another nonce and locks the device (F7).
- The SVID is refreshed five minutes before it expires; failures retry after
  5 s, doubling to 60 s. The bus ticket callback refreshes first when the
  session ticket is within a minute of expiry.
- The key bundle is renewed at three quarters of its life: the next sequence,
  the same lifetime, sent in `CredentialRequest.key_bundle`.
- A trust record in any answer (credentials or discovery) with a higher
  sequence than the pin replaces it only when `acceptTrust(pinned, next)`
  accepts it; otherwise the pin stays and `hobo_fleet_trust_rotated` is logged
  with `accepted: false`.
- `agent-outdated` logs `hobo_fleet_update_required`; `generation-mismatch`
  and `member-locked` log `hobo_fleet_member_locked`; `member-revoked` stops
  the work.
- Every authority answer's `Date` header is compared with the local clock;
  a skew of 5 s or more logs `hobo_fleet_clock_skew` with `skew_ms` (F16).

## The bus

`start` connects through `deps.connector` with the discovery document, the
pinned trust record, the ticket callback and `AgentState.lastSequence`. A
failed connect retries with the same backoff; a connection whose status turns
`closed` is dropped on the next beat and replaced. Every component holds one
stable `FleetBus` (the link): calls go to the current connection, reject with
none, and every subscription resumes after the last sequence its handler took
when the next connection is attached. `bus()` answers that `FleetBus` while
the agent is started and connected, for `createBusRelayTransport`.

## Roles and observations

- Every 10 s the agent publishes an observation of itself, signed with its
  SIGN key: its fleets, health (`DRAINING` once draining), capacity, labels,
  platform, the sandbox tiers whose driver self-test passed, agent version,
  started transports, region and bundle sequence. Dispatchers rank only
  accepted, unexpired self-observations. It also signs and publishes, as
  observer, one observation for each `deps.sponsored` member.
- The dispatcher runs while a membership has role `DISPATCHER`; the executor
  (with `deps.egress`) while one has `EXECUTOR`. When the member's
  memberships change (read from the registry each beat and from refresh
  answers), the executor drains and is started again over the new set.
- The executor keeps receipts in `AgentState.pendingReceipts` and flushes
  them on start and every 10 s, so a bus outage loses none and each is
  published once when the bus is back (F4). The agent and the executor write
  `AgentState` through one queue; each replaces only its own fields.
- `serveSessions` runs on every started transport with the executors'
  `sandboxOf`, so shell, forward and blob sessions only ever run inside an
  order's sandbox and their close facts are signed with the SIGN key.
- Control messages verified against the pinned trust record are followed:
  `DRAIN` drains, `REFRESH_NOW` refreshes, `REVOKED` stops the work,
  `UPDATE_REQUIRED` logs `hobo_fleet_update_required`. Anything else is
  ignored.

## Limits

- The agent has no initiator API: a CLI that dials a session (`hobo fleet
  connect`, `cp`) publishes its own session-close fact.
- An executor that joins a fleet starts reading that fleet's offers from
  "new" (L04's executor), so an offer published before the restart is not
  claimed by it.
