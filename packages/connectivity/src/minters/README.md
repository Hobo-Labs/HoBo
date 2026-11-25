# Overlay credential minters (L39)

`createTailscaleCredentialMinter` and `createNetbirdCredentialMinter` implement
the `OverlayCredentialMinter` port of `@hobo/fleet`. The fleet authority
composes them from configuration and enrollment calls them once per `ACTIVE`
device, with a 10-minute `ttlMs` (D54). Each call mints one join credential
through the provider's API with the `fetch` given in `OverlayMinterOptions` and
returns it as an `OverlayJoin`. They do not use or change the overlay API
clients in `src/overlay/`.

| Provider | Request | Single use | Expiry | Tags |
| --- | --- | --- | --- | --- |
| Tailscale | `POST {apiBase}/api/v2/tailnet/{organisation}/keys`, `Authorization: Bearer <token>` | `reusable: false`, `preauthorized: true`, `ephemeral: false` | `expirySeconds` = `ceil(ttlMs / 1000)` | `capabilities.devices.create.tags`: exactly the given tags, a bare tag prefixed with `tag:`, duplicates removed |
| NetBird | `GET {apiBase}/api/groups`, then `POST {apiBase}/api/setup-keys`, `Authorization: Token <token>` | `type: "one-off"`, `usage_limit: 1`, `ephemeral: false` | `expires_in` = `max(ceil(ttlMs / 1000), 86400)` | `auto_groups`: the ids of the groups named by the tags; a tag naming no group is `invalid-request` and nothing is minted |

`expires_at` in the returned `OverlayJoin` is the expiry the provider reports.
A failed token read, a network error, a non-2xx reply, a redirect (requests use
`redirect: "error"`), a 10-second timeout, or a reply without a key or expiry
is an `unavailable` outcome; the authority leaves that minter's join out of
the enrollment response. The minters write no log line, and no failure message
or detail carries the credential or the operator's API token.

## Assumption A13

**Not tested, fallback taken.** No provider account or provider-recorded
interaction was available to this lane. The consumer contracts in
`test/minters/pacts/` were written from the providers' API references and run
on every test pass; the `[A13] …` cases in `test/minters/minters.pact.test.ts`
replay `test/minters/recorded/*.pact.json` and skip while no recording is
committed. Until they run, the overlay transport is offered only where an
operator joined the device by hand.

Found while checking the NetBird API reference: a setup key's `expires_in`
must be at least one day, so a NetBird join credential lives for a day, not
10 minutes. It stays single use (`one-off`, usage limit 1), so it cannot be
replayed after the device joins. Lifting the fallback needs recordings made
with a real tailnet and a real NetBird account, committed under
`test/minters/recorded/` with the provider names `TailscaleAuthKeysApi` and
`NetbirdSetupKeysApi`.
