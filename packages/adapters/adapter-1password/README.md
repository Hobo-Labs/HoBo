# @hobo/adapter-1password

Optional `SecretsPort` adapter (kind `1password`) for
[1Password](https://1password.com), one of the three secrets managers a HoBo
deployment can be pointed at (ADR-0179 amendment "Secrets manager, not
Infisical": 1Password, Bitwarden Secrets Manager, Infisical). One Password item
per secret in one vault; the value in the item's built-in concealed
`password` field; `valueRef` is the item's `op://<vault>/<item>/password`.

## Secretless? No, for a workload

Checked 2026-11-12 against 1Password's developer docs: a workload signs in
with a **service-account token** (or a Connect server token). 1Password's
workload-identity integration ("brokered access", public preview, 1Password
Business) federates GitHub Actions and custom OIDC issuers, but still has the
workflow hold an **integration key** as a runtime secret, and does not list
Vercel. So HoBo does **not** use 1Password for the hosted relay's runtime reads:
the token would have to live in Vercel environment secrets or GitHub secrets,
which ADR-0179 forbids. It is used on the owner's side: the owner's own
desktop-app session (`DesktopAuth`) or the official Claude Code plugin, which
keeps secret values away from the model.

## How it is wired

The official SDK (`@1password/sdk`) is not a dependency. A composition that
has it passes `await createClient({ auth, integrationName, integrationVersion })`;
its `items` (`list`, `get`, `create`, `put`) satisfies `OnePasswordSdkClient`
(`src/sdk-port.ts`). Tests pass an in-memory stand-in.

## Gates

- **Protobuf + CUE**: [`data-models/adapter_1password.proto`](data-models/adapter_1password.proto)
  and [`.cue`](data-models/adapter_1password.cue) (closed: a binding cannot carry
  a token); fixtures in `data-models/fixtures/`; `pnpm run codegen`.
- **Parse, don't validate**: `parseOnePasswordBinding` makes the only
  `ParsedOnePasswordBinding`.
- **PACT**: [`contracts/`](contracts/README.md), the SDK boundary as recorded
  calls; provider-verified against the stand-in.
- **Redaction**: `OnePasswordError` names an operation and a code, never the
  SDK's message (which may quote input) or a value.
