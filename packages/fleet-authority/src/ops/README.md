# Operations (L27)

`runCeremony`, `rotateKey`, `backup` and `restore` (design §6.16, §7.3), for
both profiles. Each reads the configuration file `OpsContext.configPath`
names, composes the deployment from it (`compose.ts`), runs, and closes what
it opened. Every failure is an `Outcome`; nothing is thrown across the entry
points. The modules beside `index.ts` are private to this lane.

## Configuration

A JSON object; unknown keys are ignored, so the authority's own
configuration file serves both.

| Key | Default | Meaning |
|---|---|---|
| `tenant` | required | The tenant id |
| `profile` | `standalone` | `standalone` or `high-availability` |
| `secretPrefix` | `hobo-fleet/<tenant>` | Every key's secret is `<secretPrefix>/<which>` |
| `operatorName` | `hobo-fleet` | The operator's name in its JWT |
| `dataDir` | `data`, beside the file | Standalone: the SQLite journal (`eventstore.sqlite`, @hobo/runtime-local's default name) |
| `natsUrls` | none | NATS servers; required for high availability |
| `natsCredentialsSecret` | `<secretPrefix>/nats-authority` | The authority's static-user credentials |
| `witnessTimeoutMs` | 120000 | How long a trust-record change waits for the witness |

## Keys in the secret store

One secret per key, `<secretPrefix>/<which>`. A slot holds every version
verifiers may still need and names the active one (`{ v: 1, active, keys:
[{ kid, seed, publicKey }] }`); Ed25519 keys as raw base64url, NATS keys as
nkey text. The token-signing key is @hobo/identity's ring
(`loadSecretStoreKms` with prefix `<secretPrefix>/token-signing`). Rotation
progress is `<secretPrefix>/rotation/<which>` and holds key ids only.

## Ceremony

`runCeremony` generates the NATS operator identity key, uses it once to sign
the operator JWT naming a fresh operator signing key (stored at
`<secretPrefix>/operator-jwt`), and returns it only as two shares
(`hobo-fleet-share:<1|2>:<operator public key>:<32 bytes>`): the first is
random, the second the seed XOR the first, so either alone is uniformly
random. It also creates the record-signing (`authority#1`) and witness
(`witness#1`) keys and the token ring when absent. It refuses to run twice
(`conflict`). Nothing it writes or logs holds the operator key (O19,
`test/ops/ceremony.test.ts`).

## Rotation

Add, publish, switch, remove; each step is idempotent and its progress is
written before the next starts, so a crash at any write and a second call
finish the rotation (`test/ops/rotation.test.ts` crashes at every write of
every key). `reached` is the last step completed: `add` while the witness
or NATS cannot publish, `switch` until the grace period has passed, `done`.

| Key | Publish / remove | Grace before remove |
|---|---|---|
| `record-signing`, `witness` | A new trust record listing the slot's keys: `fleet.TrustRotated` journalled first (data `record` = the record's bytes, base64; `sequence`), proposed on `fleet.audit.trust`, put in the registry once the witness co-signs | 30 minutes (a record's lifetime) |
| `token-signing` | The new key joins the ring; switch retires the old one, which verifies for 15 minutes more | 15 minutes |
| `operator-signing`, `account-signing`, `scoped-*` | `NatsSigningKeys.publish(which, keys)` | 30 minutes |

The composition's `NatsSigningKeys` answers `unavailable` (the rotation
stops at `add`): @hobo/fleet-nats derives every tenant key from the operator
signing seed and has no entry point that publishes an account's signing
keys; publishing the operator JWT needs the ceremony's shares. O19
(`test/ops/rotation.integration.test.ts`) rotates each of the eight keys
against a NATS double while a device refreshes every second, with zero
refusals, and checks one more trust change works afterwards.

## Backup and restore

`backup` writes one archive (`hobo-fleet-backup/v1`, JSON, mode 0600): the
witnessed checkpoints, then every audit entry, then the journal (so the
journal covers every entry), and the pinned trust record, with a manifest of
SHA-256 digests; `manifestDigest` is the SHA-256 of the manifest's canonical
JSON. The standalone journal is a consistent SQLite snapshot (`VACUUM
INTO`); the high-availability journal is every envelope in `readAll` order.

`restore` refuses an archive whose digests do not match, of another tenant,
or into a deployment that is not fresh (`conflict`). It loads the journal,
puts the archived trust record, restores the audit entries and checkpoints,
waits for the witness to co-sign the restored checkpoints, then increments
the incarnation with a witnessed trust record (journalled as
`fleet.TrustRotated`, reason `restore`; the audit chain is ticked once
because no authority runs yet), and rebuilds the registry from each member
and fleet stream's last journalled `record`, signed under the new
incarnation. A second run continues where the first stopped and does not
increment twice. `checkIncarnation` (`incarnation.ts`) refuses a session
ticket or member record of an earlier incarnation with `incarnation-stale`.
O18 (`test/ops/restore.integration.test.ts`) restores a SQLite deployment
with ACTIVE members enrolled by the real enrollment authority.

The high-availability restore answers `unavailable`: the journal store's
port can only append new envelopes, and a restore must keep every envelope
id the audit log names (a JetStream stream restore of `FLEET_JOURNAL` does).
