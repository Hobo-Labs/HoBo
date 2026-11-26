# Azure DevOps edge-case matrix

The default package test command and `test:contracts` execute this matrix. Every
Azure response comes from the shared Pact broker; delivery faults alter framing,
latency or connection completion around a recorded message. Filesystem and CLI
cases use actual files and subprocesses. Typecheck includes every test/helper.

| Boundary | Covered cases | Executable evidence |
| --- | --- | --- |
| Pool and definition admission | missing/zero/ambiguous pools, hosted/unconfirmed pools, vendor extensions, missing/wrong revisions, encoded project/pool spaces, HTTP 401/403/404/429/500/503 | `live.test.ts`, `contracts/live-edge.pact.json` |
| Preview | malformed/empty/null YAML, duplicate jobs, mixed/multiple stages, absent pools, hosted images, stale or extended digest, missing/wrong tasks, missing inline script or bundle guard | `live.test.ts` |
| Run creation | missing/negative/malformed identity, denied POST, lost response, exactly one allocation attempt | `live.test.ts`, `test/live.test.ts` |
| Run completion | queued/postponed/running states; failed/cancelled/partial/unknown results; wrong run/source/pool and malformed reads | `live.test.ts` |
| Cancellation | known-run cancellation, wrong confirmation identity, denied/malformed replies, pending status, interruption, actual overall deadline, actual 15-second reconciliation expiry | `live.test.ts` |
| HTTP delivery | empty/truncated/oversized bodies, exact one MiB boundary, broken/stalled streams, absent headers, late transport completion, rejected or stalled body cleanup, credential-safe errors, redirect refusal | `live.test.ts`, `contracts/live.consumer.test.ts` |
| Authentication | PAT and bearer headers, missing/empty/unresolved/NUL/newline/oversized/inherited credentials, pre-aborted signals, disabled native verification, default process environment and polling | `live.test.ts` |
| Reports and bytes | unsuccessful statuses, bad identities/digests/counts/metadata, unknown JSON fields, exact manifest anchor, duplicate/missing paths, zero/one MiB/oversized files, 16/17 file boundary, corrupted memory snapshots | `artifacts.test.ts` |
| Filesystem | undeclared root/nested files and empty directories, matching internal symlink, escaping links, missing files, directories/FIFOs, traversal, existing stage targets | `artifacts.test.ts` |
| Authoring and secrets | count/text/name bounds, NUL and Azure expressions, frozen intent, invalid Git ref components, literal conflicts, inherited variables, overlapping/multiline redaction, prototype-map keys | `authoring.test.ts`, CUE valid/invalid fixtures |
| CLI | missing/duplicate/unknown/malformed arguments, stale guards, spaced workspaces, literal shell metacharacters/Unicode, config FIFO/size bound, escaping artifact/working directory links, side-effect refusal | `cli.test.ts` |
| Generated pipeline and replay | native publish/download Pact inputs, source mutation after collection, downloaded hashes, attempt naming, secret isolation, SQLite restart/replay | `test/production.test.ts` |

Pact fidelity and consumption are checked separately from expected client errors,
so a malformed test request cannot masquerade as a successful rejection test.
The broker refuses extra requests; failure cases also verify that allocation,
retries or cancellation happen only for the run whose identity is known.

Coverage measurement supplements this matrix. Native global Fetch against Azure
and hostile concurrent filesystem mutation are separate environmental properties;
consumer fixtures do not establish remote Microsoft verification or adversarial
host isolation. The runtime still rejects changed file metadata while reading.

After building, `pnpm --filter @hobo/ci-ado test:coverage` measures the five
in-process boundary modules and enforces 98% statements/functions, 97% branches
and 99% lines. The package pins matching Vitest/coverage-provider versions. CLI
behavior is verified through actual subprocesses and is outside these in-process
coverage totals.
