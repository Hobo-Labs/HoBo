---
type: Runbook
title: "HoBo.CD runbook: Freight sources"
description: "Pull discovery and webhook nudges. Assembled from the Runbook section of packages/cd/src/sources/README.md."
tags: [hobo, cd, runbook, sources]
---

# HoBo.CD runbook: Freight sources

Pull discovery and webhook nudges. This page is assembled from the **Runbook** section of `packages/cd/src/sources/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Cause | Action |
| --- | --- | --- |
| `hobo.cd.source.polls{outcome="source-rate-limited"}` rising; `backoff` gauge high | Registry quota exhausted | Nothing urgent: the source honours `Retry-After`. Raise `pollIntervalMs`, rely on webhook nudges, or set a `credentialRef` with a higher quota. |
| `source-auth-failed` | Credential missing, expired or under-scoped | Rotate the secret behind the subscription's `credentialRef` (scope `cd:source:read`); the next tick retries. |
| `source-git-capability-missing` | Git server without protocol v2 or `uploadpack.allowFilter` | Enable `protocol.version=2` and `uploadpack.allowFilter` on the server. Discovery never clones. |
| `source-transport-not-binary-safe` | The composed `HttpTransport` decodes binary bodies as UTF-8 | Compose a transport that returns binary content (packfiles, blobs, packages) as latin1, one char per byte. |
| `skipped` with `source-provenance-missing` | Image pushed without an attestation | Sign it (Sigstore bundle or in-toto attestation pushed as an OCI referrer) and publish a new tag; the skipped tag stays skipped (forward-only). |
| `skipped` with `source-provenance-rejected` | Attestation from an unpinned builder/signer | Compare the attestation with `trustedBuilderIds` / `trustedSignerIdentities`; fix the pin or re-sign. |
| `refused` with `source-freight-refused` | The ledger refused the manifest (e.g. digest not at its coordinate) | Read the ledger reasons in the event meta; fix the artifact and publish a newer version. |
| `deferred` events, no Freight | Assembly is waiting for another subscription | Check the missing subscription named in the reason; for `SAME_COMMIT` make sure images carry `org.opencontainers.image.revision`. |
| Nudges answered `401` | Sender secret differs from `webhook/<receiver>` (scope `cd:source:nudge`) | Re-share the secret with the sender. A `401` never schedules a poll. |
| Nudges answered `202` with `scheduled: []` | Payload names a repository no subscription matches | Compare the payload repository with the subscription locator (keys are normalized: host lowercased, `.git` dropped, Docker Hub `library/`). |
| A retired Rail was discovered earlier | It was approved, discovered, then retired in a later poll | Yank the Freight through the ledger (`freight.yank`); a Rail retired before discovery is never discovered. |

Rebuild: everything above is the fold of `cd-source-<name>`; dropping the
process loses only the in-memory poll schedule and backoff, and the next tick
polls every automatic source once.
