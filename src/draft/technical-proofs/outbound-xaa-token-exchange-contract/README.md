# Outbound XAA Token Exchange Contract

HOBO-230 proof package for outbound Cross-App Access (XAA) token brokerage.

The package models the broker seam that:

- runs a pre-mint policy hook with `subject.delegatedBy`;
- mints a short-lived ID-JAG bound to exactly one target audience and resource;
- redeems that ID-JAG at the configured target authorization server via JWT bearer grant;
- falls back to `oauth2-obo` for non-XAA targets; and
- emits `token.Granted`, `token.Used`, or `token.Denied` events that the identity audit fold can reconstruct.

It deliberately does not define the ID-JAG wire format, inbound resource-server validation, connector authoring, or scope inference. Those stay in the existing referenced packages and follow-on issues.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\outbound-xaa-token-exchange-contract test
```

Covered behaviors:

- user ID token reference plus delegated agent subject mints an audience-bound ID-JAG for target A;
- unsupported source token types fail before policy or minting;
- target A authorization server redeems the ID-JAG into an access-token reference scoped only to A;
- `token.Granted` and `token.Used` reconstruct the user -> agent -> external app chain;
- missing `subject.delegatedBy` is denied before policy or mint;
- a target A ID-JAG cannot redeem at target B authorization server;
- a redeemed access token must carry the expected target audience;
- non-XAA targets use `oauth2-obo` fallback without minting ID-JAG; and
- long-lived target access tokens are rejected.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Outbound Xaa Token Exchange Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
