# `@hobo/control-yard` — agent instructions

Game-first control-plane UI (ADR-0150). Projections only; sourced pixel art per the package styles (ADR-0148 — Bo art bible retired);
asset index is the sole clip metadata source.

## Evidence is mandatory (do not claim without files)

**Self-report is not acceptance.** A feature is not done until Playwright has
written **screenshots and MP4 recordings** under this package and the
evidence manifest validates them.

### Required evidence layout

```text
public/shots/
  evidence-manifest.json     # written by `pnpm run play` / `pnpm run evidence`
  visual-report.json         # automated check log
  01-boot-live.png
  02-connection-bay-sheet.png
  03-cost-booth.png
  04-policy-board.png
  05-error-bunker.png
  06-after-actions.png
  07-walk.png
  canvas-only.png
  anim-bo-idle.png
  anim-bo-walk-east.png
  anim-bo-walk-west.png
  recordings/
    01-yard-loop.mp4           # full loop: boot → zones → sheets
    02-connection-sheet.mp4    # connection bay open + confirm path
    03-bo-walk-east-west.mp4   # AnimTest east then west (not mirrored)
    04-rail-cost-doctor.mp4    # policy / cost / error bunker sheets
  baselines/                   # imgdiff baselines (gamedev/playwright skills)
```

### Agent rules

1. **Capture before claim.** After any UX/game-loop/asset change, run:

   ```bash
   pnpm --filter @hobo/control-yard run evidence
   ```

   This must produce non-empty PNGs **and** MP4s, then write
   `public/shots/evidence-manifest.json` with byte sizes + sha256 digests.

2. **Read the evidence.** Open/read at least:
   - one full-yard PNG
   - east + west AnimTest PNGs (bindle arm must not be a horizontal flip)
   - the primary MP4 (`01-yard-loop.mp4`)

   Use the image/video tools available to you. If you cannot open an MP4, run
   `ffprobe` and extract key frames with ffmpeg, then read those PNGs.

3. **Manifest is the gate.** `pnpm run evidence:check` fails when:
   - any required path is missing
   - any file is under the minimum size (PNG ≥ 2KB, MP4 ≥ 10KB)
   - digests in the manifest do not match on-disk files

4. **No “it passed in my head.”** Unit tests and architecture:guard are
   necessary but not sufficient for visual features. Screenshot + MP4
   evidence is required for zone interaction, Bo walk E/W, generative
   sheets, traffic/cost meter, and guest agents.

5. **Recordings must show motion.** Static single-frame “videos” are invalid.
   Prefer ≥ 2s wall-clock recording of interactive play. Use Playwright
   `recordVideo` (webm) then `ffmpeg` → H.264 MP4 (`yuv420p`, `+faststart`).

6. **Builderpack skills.** Use installed skills under `.agents/skills/`:
   - `gamedev-assets` — probe/coverage before loading sheets
   - `phaser-gamedev` — measure-before-load STOP rule
   - `playwright-testing` — `__TEST__` seam, deterministic `?test=1&seed=…`

7. **Sync UX proof.** When evidence changes, copy/link key shots + MP4s into
   `src/draft/exp-proofs/ux/control-yard/assets/evidence/` in the same change
   (see that package’s `AGENTS.md`).

## Commands

```bash
pnpm --filter @hobo/control-yard run assets:validate
pnpm --filter @hobo/control-yard run assets:coverage
pnpm --filter @hobo/control-yard test
pnpm --filter @hobo/control-yard run evidence      # capture screenshots + MP4s
pnpm --filter @hobo/control-yard run evidence:check
```

## Non-goals

- Live cloud E2E
- Claiming west walk by flipping east sheet
- Hand-edited generated codegen outside asset index
- **Blaming east when west jitters.** East/walk-right is the good plate. West
  foot plant is re-registered to the east baseline in `assets/assets_index.json`.
  Do not mirror either sheet. Do not “fix” east.
  If west gait still vibrates after baseline stabilize, delegate redraw of **west**.
