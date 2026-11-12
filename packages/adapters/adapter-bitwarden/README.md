# @hobo/adapter-bitwarden

Optional `SecretsPort` adapter (kind `bitwarden`) for
[Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/),
one of the three secrets managers a HoBo deployment can be pointed at
(ADR-0179 amendment "Secrets manager, not Infisical"). One secret per key in
one project; `valueRef` is `bitwarden://<organization>/<project>/<secret id>`.

## Secretless? No, for a workload

Checked 2026-11-12 against Bitwarden's help center: machine accounts sign in
with an **access token** (expiry "Never" by default); no workload-identity or
OIDC federation is documented for machine accounts. So HoBo does **not** use
Bitwarden for the hosted relay's runtime reads (the token would have to live
in Vercel environment secrets or GitHub secrets, which ADR-0179 forbids). It
is used on the owner's side, with a machine-account token the owner holds in
their own shell (`bws`, `BWS_ACCESS_TOKEN`).

## How it is wired

The official SDK (`@bitwarden/sdk-napi`) is not a dependency. A composition
that has it builds `new BitwardenClient(settings)`, signs it in with
`client.auth().loginAccessToken(token)`, and passes it; `client.secrets()`
(`list`, `get`, `create`, `update`) satisfies `BitwardenSdkClient`
(`src/sdk-port.ts`). Values stay in-process: no `bws` command line carries
them.

## Gates

- **Protobuf + CUE**: [`data-models/adapter_bitwarden.proto`](data-models/adapter_bitwarden.proto)
  and [`.cue`](data-models/adapter_bitwarden.cue) (closed: a binding cannot
  carry a token; HTTPS API only); fixtures in `data-models/fixtures/`.
- **Parse, don't validate**: `parseBitwardenBinding` makes the only
  `ParsedBitwardenBinding`.
- **PACT**: [`contracts/`](contracts/README.md), the SDK boundary as recorded
  calls; provider-verified against the stand-in.
- **Redaction**: `BitwardenError` names an operation and a code only.
