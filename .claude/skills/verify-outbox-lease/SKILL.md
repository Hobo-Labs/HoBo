---
name: verify-outbox-lease
description: Verify SQLite queue and outbox delivery attempts and stale-receipt fencing when changing journal lease handling.
---

# SQLite queue and outbox delivery

**Property:** After a delivery is reclaimed, any receipt for an earlier attempt is refused, including when the worker's lease ID and fence are reused.

**Why:** Accepting an earlier receipt can complete a replacement's work before that replacement delivers it.

**Review basis:** `2a8f17ad733218fdfbf26506cc7940c368e45593`. Earlier code checked only the caller's lease ID and fence, allowing a stale worker to acknowledge a replacement using the same pair. The current checks exercise the corrected implementation and the model below.

## Covered code

- `packages/storage-sqlite/src/journal.ts`: `leaseMessages`, `completeMessage`, `claimOutbox`, `ackOutbox`, and persistent delivery counters.
- `packages/storage-sqlite/src/schema.ts`: existing queue and outbox attempt columns.
- `packages/storage-sqlite/test/lease-fencing.property.test.ts`: generated multi-attempt histories, SQLite reopen, missing attempts, expiry, and counter exhaustion.

## Run

From the repository root:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-outbox-lease
```

The command runs focused real-code checks, fast-check generated histories, and TLC 1.7.4. Set `TLA2TOOLS` to the checksum-pinned jar or let the runner download it. Java 11+, Node, and the installed workspace dependencies are required.

## Scope and evidence

TLC explores one message, two caller IDs, two caller fences, and up to three delivery attempts. A tracked receipt can come from any of those attempts; IDs and fences may repeat, but the stored attempt strictly increases. Expiry permits reclaim and does not itself invalidate the current receipt. The model explores 289 distinct states. In a scratch copy, removing the attempt-equality guard violates `NoStaleAcknowledgment`; separate source mutations removing the queue or outbox generation predicate fail the real-code checks.

The generated real-code test uses seed 614446 and 150 histories with two to seven attempts, repeating and changing IDs and fences. It checks every older receipt against both the queue and outbox after each reclaim, then checks the current receipt succeeds. Separate cases reopen a file-backed SQLite journal, verify missing attempts fail closed, exercise acknowledgment after expiry before reclaim, and refuse unsafe counter increments.

The completion APIs require callers to pass the `deliveryAttempt` from the returned receipt; older callers omitting it fail closed. The argument is a concurrency fence, not an authentication secret. SQLite transactions and persisted counters are assumed to behave correctly. The model and tests do not prove another storage backend, external delivery, exactly-once effects, crash durability of the filesystem, or safe caller migration.

## Keep in sync

Inspect covered code and changes since the review basis, including uncommitted changes. Keep the model, real-code checks, and caller contract synchronized; replay counterexamples against the implementation. Run the skill, demonstrate a deliberately broken scratch variant, and update the basis only after checking correspondence. Use `/maintain-formal-verification-skill`.
