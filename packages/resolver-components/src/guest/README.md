# `src/guest/` — guest SDK and canonical ABI

`types.ts` is the guest-side view of `wit/resolver.wit` in its canonical JSON
lowering (records → objects, tuples → two-element arrays, option → value or
`null`, result → `{ok}`/`{err}`, variant → `{tag, val}`). `abi.ts` lifts and
lowers those values; the host lifts every guest value before trusting it, and
an out-of-contract value is an `AbiError` → `component.output-unparseable`.
`index.ts` exports `defineResolverGuest` and small helpers (`ok`, `rejected`,
`unsupported`, `outcome`, `header`, `properties`).

Rules for authors: authenticated calls go through
`authorizedFetch(request, request.credentialRef)`; never set `authorization`,
`cookie` or other host-owned headers (the host drops them); never put
credential-shaped keys in outputs (the core parser refuses them).

## Runbook

- `component.output-unparseable` naming a WIT path (`resolve-outcome.action`,
  `http-request.headers[0]`…): the guest returned a value outside the
  contract; the message names the exact field.
- A guest that needs a header the host owns (for example a provider-specific
  auth scheme) must declare the host in the credential binding; the
  credential resolver returns the header map to attach.
