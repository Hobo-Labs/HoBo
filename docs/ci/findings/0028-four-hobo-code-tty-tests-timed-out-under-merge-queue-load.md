---
type: CI Performance Finding
title: "Finding 28: four @hobo/code TTY tests timed out under merge-queue load"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 28: four @hobo/code TTY tests timed out under merge-queue load

PR #1696 merge_group run 41772348951 hit the 20 s per-test timeout in `cli-verb-sweep` (`session renders without throwing`), live-TTY navigation (`leaves the catalog on escape`), live-TTY surfaces (`takes a second turn after the first one lands`), and scripted streaming (`marks a failure as failed`). The failures came from test scheduling and real side effects, not assertions that needed a larger budget:

- `session` composed real dashboard/Evidence sidecars because `startCodeSession` read ambient `process.env` instead of the CLI's injected environment. The CLI now passes `sidecarsEnabled(env)`, and both verb-formatting sweeps disable them. Those sweeps also inject shared workspace allocation and a tmux runner: they check verb results and formatting, not rift/tmux provisioning. This removes subprocesses and the overlay probe that made baseline `mux` cleanup cases fail locally with EACCES.
- Navigation paced keys with 30 ms timers. Surfaces used 150 ms gaps, increased to 400 ms for the second-turn case, plus 3–4 s delayed hosts. Both live harnesses now wait for the shell's ready event, acknowledged TUI input, settled turns, and stdout writes. Ctrl-C and Escape still interrupt active turns; delayed hosts are pending promises instead of timers. Every waiter also races shell completion, so the existing `maxMs` backstop cannot leave a helper stranded.
- Scripted streaming yielded with `setTimeout(0)`, polled the turn flag every 10 ms against a 12 s deadline, then slept 40 ms for a final render. The shell now tracks the active turn promise and awaits it directly; the same 12 s `maxMs` remains only as an expiry backstop, and the final render flushes on `process.nextTick`. The 20 s test/hook timeouts are unchanged and no retries were added.

Twelve tests across `review-command-surface`, `review-target-kinds`, `review`, `session-delivery-approval`, and `session-orchestrator` also hit the 20 s timeout during pre-commit. On clean main with a quiet box, global `commit.gpgsign=true` and an SSH signer reproduced 11 failures in 6.5 min wall time but only 8 s CPU time; `GIT_CONFIG_GLOBAL=/dev/null` passed 175/175 in 4 s. Real fixture commits were invoking the developer's signer and could inherit other global/system settings, so the shared Vitest setup now ignores both config sources while fixtures keep local git identities. A regression test checks the effective signing config in a real fixture repository; timeouts and retry policy remain unchanged.

Five runs per file, sequentially, with four `node -e 'for(;;){}'` CPU hogs on the same 4-CPU worktree. Values are whole-process wall seconds in run order; the median is across the five runs. Baseline CLI runs each also reported the five unrelated `mux` EACCES failures; all 20 after runs passed every test.

| File | Before: five runs | Before median | After: five runs | After median |
|---|---|---:|---|---:|
| `cli-verb-sweep.test.ts` | 17.90, 16.87, 17.19, 17.32, 17.78 | 17.32 | 9.20, 10.01, 9.28, 9.47, 8.66 | 9.28 |
| `shell-live-tty-navigation.test.ts` | 19.64, 19.88, 13.96, 14.11, 19.75 | 19.64 | 11.90, 11.79, 12.31, 11.21, 11.74 | 11.79 |
| `shell-live-tty-surfaces.test.ts` | 28.92, 29.27, 38.79, 31.57, 28.91 | 29.27 | 11.34, 11.75, 11.36, 11.30, 11.46 | 11.36 |
| `shell-streaming-turn.test.ts` | 10.17, 10.64, 10.46, 10.47, 10.07 | 10.46 | 9.26, 9.60, 8.72, 8.90, 9.07 | 9.07 |

The test-body reductions are larger than whole-process wall time: Vitest transform/import still costs about 7–10 s under this load. After test bodies were about 0.7 s CLI, 3.7 s navigation, 3.0–3.2 s surfaces, and 0.8 s streaming, with no individual case near the unchanged 20 s budget.
