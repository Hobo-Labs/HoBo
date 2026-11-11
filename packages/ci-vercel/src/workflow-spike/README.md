# Workflow SDK spike: one CI job as one durable run

**Status:** throwaway spike, not wired into the relay. Nothing in `api/` or
the relay's composition imports this folder. The question it answers: can the
hosted relay hold each CI job's lifecycle as one Vercel Workflow run instead of
per-job store state?

Pinned versions (newest releases at least two weeks old on 2026-11-11):
`workflow@5.2.3` and `@workflow/vitest@5.0.6`. Both pull `@workflow/core@5.2.3`
and `@workflow/world-local@5.1.2`.

Run the evidence (no network, Local World in-process):

```sh
pnpm --filter @hobo/ci-vercel test:workflow-spike
```

The suite is `test/workflow-spike/job-workflow.spike.ts`, under its own Vitest
config (`vitest.workflow-spike.config.ts`). The package's `test` lane does not
pick it up.

## The workflow

`jobWorkflow(job, deadlines)` claims the token `job:<repo>:<job>:<attempt>`
with `createHook()` and `getConflict()` before any step runs. It then runs the
JIT-config and dispatch steps and waits for `in_progress` and then
`completed` deliveries. Each wait races the hook against one durable `sleep()`
deadline. It drops any delivery whose `deliveryId` it has already seen, and
ends with a settle step.

## Findings

| Question | Result |
|---|---|
| `'use workflow'` in plain `api/` functions | No documented integration. Only framework guides exist; the Express, Hono and Fastify guides all build through Nitro. The CLI builds the bundles, and `start({ workflowId })` works without the compiler. Wiring the flow function into `vercel.json` is undocumented and was not deployed. |
| N concurrent `start()` calls, one run | On 5.2.3, N calls create N runs. One owns the token and the others return `duplicate` after `run_created`, `run_started`, `hook_conflict` and `run_completed`. They run no steps. `start({ experimental_hook })` arrived in 5.4.0 (2026-11-04). On 5.2.3 the option is silently ignored at runtime. |
| Payloads before the hook | Before the run registers its hook: `HookNotFoundError`, not buffered. After registration but before the run awaits it: kept in order. A start Hook (5.4.0 and later) is resumable from admission. |
| Duplicates | Each `resumeHook()` appends its own `hook_received`, and the run sees every copy. The in-run dedupe drops them. |
| Retries and timeouts | A step that throws a `RetryableError` is retried (attempts 1, 2 and 3). A 300 ms `sleep()` deadline fired after about 1.2 s on the Local World. |
| Token after the run ends | With no retention, a new `start()` with the token is a fresh run. With `experimental_minRetention`, a finished run keeps refusing the token (`duplicate`, and `resumeHook` gives `HookNotFoundError`) until the retention passes. |

### zod skew

The generated bundles inline `@workflow/core` but leave `zod` external.
`@workflow/core@5.2.3` calls `z.compile()`, which needs zod `~4.5.4`. From this
package, `zod` resolves to 4.4.3 (`^4.1.13`), so every run fails at the
transport with `z10.compile is not a function`. The spike config works around
this with a `node_modules/zod` symlink next to the bundles. A production
integration must move the package's own zod to at least 4.5.

### Build outputs observed

- `pnpm --filter @hobo/ci-vercel build` passes. It runs tsc only, which keeps
  the directives as inert strings.
- `workflow build` (standalone) passes. It scans the whole package, so it
  picks up `dist/` copies and the `"use step"` functions that `@vercel/sandbox`
  ships: 6 workflows and 101 steps, with a 12 MB `flow.mjs`.
- `workflow build --target vercel-build-output-api` scans `./workflows` only.
  It writes `flow.func` (`maxDuration: "max"`, queue trigger
  `__wkf_workflow_*`, `nodejs22.x`) and `webhook/[token].func`. It
  overwrites `.vercel/output/config.json`, which then holds only the webhook
  route.

## Events per job (Vercel billing rule)

The rule: 3 for the run, 3 per first-try step, at least 1 more per retry, 2 per
`sleep()`, at least 2 per hook. Per job: run 3, plus 3 steps (9), plus 2
deadlines (4), plus 1 hook (2), plus 2 `hook_received` (in_progress and
completed), which comes to **about 20**. One redelivery and one retry bring it
to about 22. Each duplicate run on 5.2.x adds 4. On the Local World, measured
logs run from 15 (pickup timeout) to 19 events.

## Self-hosted Worlds

- **Postgres World:** the docs rule it out on Vercel: "needs a long-lived
  process to run its worker, so it does not work on serverless platforms".
- **Community Redis, Upstash and Turso Worlds:** all pin `@workflow/world`
  4.x (Upstash 4.5.0, Turso and Redis 4.1.0-beta.2), so none of them runs
  with `workflow` 5.
- **`EphemeralStatePort`** (branch `claude/relay-cache-port`): it cannot back
  a World. Every key expires and the port is loss-tolerant by contract, while
  a World needs a durable, dense, append-only event log per run.

## Not done

Nothing was deployed or sent to Vercel. `vercel build` did not run. Nitro was
not tried. `experimental_hook` was not executed, because 5.4.0 is less than two
weeks old. To check it, bump `workflow` once that release is two weeks old and
turn the second 2a test around.
