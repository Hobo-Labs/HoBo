# Fleet records

`fleet.proto` (package `hobo.fleet.v1`) holds every record of HoBo Fleet: keys
and signed envelopes, member and fleet records, the trust record and
discovery, sign-in, enrollment and credentials, observations and fleet views,
many-active work (offers, claims, orders, receipts, logs), the one-active
assignment log, transport sessions, control, audit, lists and the error body.
It is a frozen contract: field numbers are final, and a change is a coordinator
amendment, never a lane edit. Timestamps are RFC 3339 UTC strings with
milliseconds unless a field name ends in `_ms`.

Signed records travel inside a `SignedEnvelope` (or a `WitnessedEnvelope`,
signed by the authority and the witness) whose `context` names what the payload
is; the signature is over `utf8(context) || 0x00 || payload`, and a verifier
decodes the payload only after checking it. `@hobo/fleet` lists the contexts
as `FLEET_CONTEXTS`.

## Constraints

`fleet.cue` has one definition per message and enum and a root `#Fleet` that is
their disjunction; the fixture gate vets every fixture against `#Fleet`. It
reads protobuf JSON as `toJson` writes it: lowerCamelCase names, enums by name,
64-bit integers as decimal strings, bytes as base64, and a field holding its
default value left out. So every field is optional, and a field a record
cannot do without is checked by a hidden `_need*` list of presence tests.
Closed definitions are the "no secret field" rule: a field that is not in
`fleet.proto`, such as a private key, makes a record invalid.

It enforces the identifier patterns (member ids, fleet ids and member names,
tenants, key ids, envelope contexts, work digests and order ids) and the
record rules: a key bundle's purposes; device versus sponsored member records;
one-active fleet policy; observations; reliability in `(0, 1]`; offer trust and
sandbox floors; an order's tier; assignments and the assignment log (format 1
carries no member sets; epochs ascend with no gap); session purposes; verdicts;
bootstrap token lifetimes; and sign-in redirects, fingerprint words and user
codes.

Two messages can encode to the same bytes: a refused `ApprovalDecision` is
`{"state": …}`, like a `SignInPoll`, and an empty `Capacity` is `{}`, like a
`SignInRefresh`. `#Fleet` marks `#SignInPoll` and `#Capacity` as defaults
only to break those ties, so `cue vet` can answer for such a value.

## Fixtures

`fixtures/valid/` has at least one record per message, each exactly what
protobuf `toJson` writes for it. `assignment-log-format-1.json` is byte for
byte what `encodeAssignmentLog` in `@hobo/backend-fleet` (now
`@hobo/backend-routing`) writes, with no trailing newline: the one-active log
format of today's cache fleet is unchanged. `assignment-log-format-2.json` is a
format-2 log with a pin and an admission.

`fixtures/invalid/` has one record per constraint row of the design, each a
valid record with one rule broken, plus a format-1 log whose entry carries
`members` and a member record carrying a `privateKey` field.

## Generation

Generated TypeScript lives in `../src/_generated/fleet_pb.ts`. Run scoped
generation and the drift and fixture check from the monorepo root:

```sh
pnpm codegen --filter packages/fleet
pnpm codegen:check --filter packages/fleet
```
