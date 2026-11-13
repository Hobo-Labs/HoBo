# `@hobo/fleet/client` (L07)

The typed HTTP client of the authority's API (design §6.15, §7.3).

| Entry point | What it does |
|---|---|
| `createFleetClient({ origin, fetch, auth })` | One method per route of `FleetApi` except the four browser-only ones |

- Bodies are protobuf JSON of the records of §7.1; answers are read with
  unknown fields ignored. An error body is a `FleetError` and comes back as
  the `FleetFailure` it names; any other failing body maps from its HTTP
  status (5xx is `unavailable`). A transport failure is `unavailable`. Nothing
  throws.
- Authentication by route: discovery, the tenant discovery, the JWKS and
  `signInStart` carry nothing. `signInComplete`, `signInPoll`, `enroll` and
  `credentials` carry a bare DPoP proof made with `auth.signer` (the sign-in
  key, the identity key or the SIGN key). Every other route carries
  `Authorization: DPoP <auth.token()>` and a proof whose `ath` hashes it; when
  `token()` answers "" the proof goes alone. With `auth` undefined nothing is
  added, so a caller with an account credential can add its own
  `Authorization: Bearer` in `fetch`.
- Query parameters: `listMembers` `?fleet=`, `fleetVerdict` `?label=`,
  `auditCheckpoints` `?from=` (`fromSequence`), `auditEntries` `?from=&to=`.
  `defineFleet` is `PUT /v1/fleet/fleets/{record.fleet_id}`.
- `contracts/fleet-authority.pact.json` is written by
  `test/client/client.pact.test.ts` (one interaction per route, with the
  DPoP proof verified over the method and URL) and replayed by L09 on the
  provider side.
