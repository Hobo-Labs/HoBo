---
type: Runbook
title: "HoBo.CD runbook: Delivery feed"
description: "The outbound-only feed agents read. Assembled from the Runbook section of packages/cd/src/feed/README.md."
tags: [hobo, cd, runbook, feed]
---

# HoBo.CD runbook: Delivery feed

The outbound-only feed agents read. This page is assembled from the **Runbook** section of `packages/cd/src/feed/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **Agent sees `lease-held`.** Another reconciler (agent or conductor) holds
  `cd:camp:<id>`. It expires 30 s after its last renewal; if the holder is
  unexpected, revoke that reconciler.
- **`stale-fence` on reports.** The lease was taken over (expiry or another
  holder). The agent re-claims; nothing it wrote under the old fence landed.
- **Agent keeps re-reading the same frame.** It is not checkpointing; check
  `POST checkpoints` refusals (`checkpoint-regression` means it tried to go
  backwards — restart it so it resumes from the committed position).
- **`blob-missing` / `resolved-set-missing`.** Restore the blob into the
  artifact store or re-apply the Set; the Camp stays blocked until it verifies.
- **`blob-corrupt` / `resolved-set-mismatch`.** The stored bytes no longer hash
  to the digest; restore from a verified copy. Nothing is rebuilt (I1).
- **`attribute-undeclared` / `attribute-oversize`.** The agent reports more
  than the bound posture packs declare or more than 16 KiB per resource;
  upgrade the agent or narrow the packs.
- **Feed responses always end `long-poll` with no frames.** Nothing new since
  the checkpoint — expected. If a Set was applied, check that it landed on
  `cd-camp-<id>` (spec) and that the Station's desired-state projection tails.
- **High `hobo.cd.feed.request_ms`.** Check journal latency first (every
  request appends a DPoP replay record), then frame size (inline sets near
  256 KiB).
