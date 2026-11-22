---
type: CI Ops Finding
title: "Finding 155: private 1Password owner channels built, not proven"
description: "The private owner form capture of a vault-scoped service account and the 24h reuse lease are shipped with tests on both sides but no production observation of a real value crossing either channel yet."
tags: [hobo, ci, cd, onepassword, owner-channel, hand-off, channel-evidence]
---

# Finding 155: private 1Password owner channels built, not proven

## Status

Built, not proven. Two channels between deployed components in
[#2598](https://github.com/Hobo-Labs/HoBo/pull/2598) have consumer and producer
tests, and no production observation of a real value crossing them:

1. **The private owner form capture.** The MCP owner channel elicits an existing
   vault-scoped 1Password service account
   (`OP_SERVICE_ACCOUNT_TOKEN` via `ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE`) from
   the owner's private form, and the run deposits it into the scoped trusted
   vault (`packages/hobo-ci/src/onepassword-access.ts`,
   `packages/hobo/src/mcp-owner-channel.ts`).
2. **The service-account reuse lease.** The owner form's provisioning writes
   `OP_SERVICE_ACCOUNT_EXPIRES_AT` beside the retained token, and every later
   run re-attests the retained token — parse, lease window, vault scope, and a
   non-secret read/create/update/delete capability probe — before the SDK client
   opens (`packages/hobo-ci/src/secret-stores.ts`). The lease bounds the time
   between owner setup and re-attestation; it is not evidence of the token's own
   expiry, which 1Password does not expose in the token.

Per the repo's channel-evidence rule, every signal here was built and
unit-tested on both sides; neither has been seen carrying a value in
production.

## Evidence that will close this

- **Channel 1:** one production owner setup run through the HoBo MCP private
  owner form (for example `cd up --hand-off` through `mcp-serve` on the CI
  relay) whose run record shows the form capture accepted and the scoped vault
  holding `OP_SERVICE_ACCOUNT_TOKEN` afterwards. Link the run here.
- **Channel 2:** one later production run inside the 24h lease window whose
  logs show the re-attestation path taken for the retained token — either the
  successful re-attestation opening the store, or the explicit
  `1Password could not be reached to re-attest` / refused-before-open refusal.
  Link the run here.

Until both links exist, treat both channels as operating unobserved: a silent
failure looks identical to a quiet success from the outside.

## Guard already in place

A refusal on either channel fails closed and leaves a record in the run's
outcome (refusal codes `HOBO_CI|CD_ONEPASSWORD_SIGN_IN`,
`HOBO_CI|CD_ONEPASSWORD_SERVICE_ACCOUNT`,
`HOBO_CI|CD_ONEPASSWORD_SERVICE_ACCOUNT_UNREACHABLE`), so a silent channel
raises instead of defaulting.
