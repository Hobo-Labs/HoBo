# Local mode (L33)

`createLocalFleet(init)` is the fleet package for a process that owns its
whole fleet: the hosted relay's cache backends, the Postgres reconcile
(design §6.2 "Local mode", D6). There is no authority service and no bus.

## What it does

1. Builds an in-memory `FleetEventStore` (`createMemoryEventStore`) and an
   in-process registry.
2. Composes the real enrollment state machine (`createEnrollmentAuthority`,
   L02) around the real fleet commands (`createFleetCommands`, L32) in
   `mode: "local"`, so `defineFleet` accepts `ONE_ACTIVE` (D39).
3. Defines the configured fleet as `init.owner`, then declares each
   configured member as that owner. The policy approval is `AUTO_OWNER`, so
   each member is declared, key-approved, accepted and activated at once
   (`fleet.MemberDeclared`, `KeyApproved`, `EnrollmentAccepted`,
   `MemberActivated`), exactly as in authority mode.
4. Returns the registry, the fleet record and the member records in
   configuration order.

The registry is rebuilt from configuration at every cold start. Member ids
are `sponsoredMemberId(tenant, kind, fleet, name)`, so a second start from
the same configuration yields the same ids. For a one-active fleet
`registry.membersOf(fleet)` lists the configured members as **candidates**;
which members decide an epoch is read from the assignment log, never from
this registry (§6.10 item 1).

## Nothing is signed

The record signer has no key and writes an empty signature; the trust record
holds no authority or witness keys and `trustEnvelope()` is undefined. The
registry keeps records as the process built them, without the signing-time
fields (`issued_at`, `not_after`, `authority_incarnation`), the same shape
the journal stores (D57). Nothing is verified, because nothing crosses a
trust boundary: the boundary is the process and the credentials of the stores
it writes.

## What local mode does not have

No sign-in, recorder, projection, audit chain, credential issuer, overlay
minter or bus channel. The parts and dependencies `createEnrollmentAuthority`
needs for those are present only as refusals (`unavailable`, or an error
naming the absent bus port). `registry.view(fleet)` is undefined: local mode
publishes no view. The policy engine allows `init.owner` every action and
refuses anyone else; each decision is still journalled as `policy.Decided`.

## Refusals

`createLocalFleet` rejects (an `Error` whose message carries the fleet error
code and rule) when:

- the policy's approval is `SINGLE` or `DUAL` (`fleet-policy`, rule
  `local-approval`): one process cannot be a second principal. An unset
  approval is read as `AUTO_OWNER`;
- two configured members share a name (`invalid-request`, rule
  `duplicate-name`);
- the fleet record or policy fails the §7.2 rules of `defineFleet`
  (`invalid-request`, `detail.rule` as there);
- a member fails `declare` (only `BACKEND` and `TARGET` are declared;
  `endpointDigest` is empty or `sha256:<64 hex>`; the kind is allowed by the
  policy).

## Proof

O41: `pnpm exec vitest run packages/fleet/test/local/local-fleet.test.ts`.
The test fails any `fetch`, socket connect or listen, UDP socket, or file
write outside its temporary directory.
