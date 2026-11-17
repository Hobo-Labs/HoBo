# OptimizeXP run summary: `hobo-code` evidence re-certification

> **Historical record:** `packages/code` and its recordings were removed from
> this branch. The scores and claims below describe the original run; they are
> no longer checked against evidence in the current tree. The original files are
> preserved in [commit `225352177`](https://github.com/Hobo-Labs/HoBo/tree/225352177c2bb83574b5669b82efafec9575a876/packages/code/.optimizexp/features/hobo-code-default-entry/evidence).

Run: `20260803-hobo-code-recert`
Product: `hobo-code` (`packages/code`, project id `code`)
Experiences: UX, DX
Stop reason: `evidence-recertification`

## Why this run exists

`20260801-hobo-code-optimizexp` claimed `pareto-equilibrium` on evidence that
could not be audited: its iteration scores were never committed, and the
flagship "cold-start bare TTY" capture was taken on the **non-TTY fail-closed
path** — the InteractiveShell had no evidence of ever having rendered. That
run is now marked `superseded.json`.

This run re-captures the flagship feature against the **rebuilt** shell using
the installed bin entry, with real TTY recordings.

## Scope — what this run does and does not claim

- **Does** re-certify `hobo-code-default-entry` (all three scenarios) with
  real, reviewed, non-degraded evidence: `capture-evidence --mode validate
  --strict` reports zero problems.
- **Does** score harm/friction against a **measured** baseline: the
  pre-overhaul shell was rebuilt from `origin/main` and recorded under an
  identical 100x30 pty for the same 5s window, so `baseline.json` is an
  observation rather than a memory.
- **Does not** claim a harm/delight equilibrium or a pareto stop. Implementable
  findings remain (SGR mouse regions; the engine path needs provider
  credentials to exercise end to end), so the stop reason is deliberately not
  a completion reason and `lint-runs` classifies this run as *not claiming*.
  Its evidence checks were retired when the package and recordings were removed.

## Measured before / after (same pty geometry, same 5s window)

| | before (`origin/main`) | after (this branch) |
|---|---|---|
| Full-screen erases | **53** | **0** |
| Terminal bytes | 182,576 | 37,944 (4.8x less) |
| Alternate screen (destroys transcript) | yes | no |
| Synchronized output (tear-free) | no | yes |

Scores in `baseline.json` / `iterations/001/scores.json` are agent judgments;
the original machine checks and recordings are available in the historical
commit linked above; they are not current-tree evidence.

## Evidence captured (all `via: capture-evidence`, `degraded: false`)

| Scenario | Kind | Perceptual |
|---|---|---|
| cold-start bare TTY | recording (asciinema) | firstOutput 186 ms · maxSilentGap 1054 ms · 31 KB / 6.2 s · 0 full-screen erases |
| in-session slash palette | recording (asciinema) | selection window follows the marker (`1-6/17` → `5-10/17`) |
| help one-shot | transcript | exit 0, grouped help surface |

## What the recordings prove

- Static chrome (logo, status line, footer) is written **exactly once** across
  a 6.2 s session — the differential renderer never redundantly repaints.
- Idle rest spans are silent for >1 s at a time; the old shell repainted the
  full screen every 95 ms unconditionally.
- The shell is honest at rest: `engine:none · dispatch-only` in the footer and
  a welcome that states prompts queue dispatch tasks.

## Defect found by this run

Capturing the in-session palette on a real 80x24 TTY surfaced a live defect:
the palette rendered only the first N lines, so moving the selection scrolled
the `▸` marker out of view — arrow keys worked but the selection was
invisible. Fixed (viewport follows selection, with a `1-6/17 · ↓11 more`
range indicator) and pinned by regression tests before re-capture.
