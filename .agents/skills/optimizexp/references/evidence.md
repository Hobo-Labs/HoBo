---
type: Agent Skill Reference
title: "OptimizeXP evidence capture"
description: "What personas see: capture, store, overwrite policy, and media preference for feature scenarios."
tags: [hobo, optimizexp, evidence, screenshot, video, tui, web]
timestamp: 2026-07-30T00:00:00Z
---

# Evidence

Evidence is **what the persona sees** while a scenario runs — not only logs of what the agent thinks. Every scored scenario should produce durable media under the feature’s `evidence/` tree.

## One recording per scenario

```text
.optimizexp/features/<feature-slug>/evidence/<scenario-slug>/
```

Rules:

1. **Exactly one current primary artifact** per scenario (`primary.*` + `manifest.json`).
2. A new capture **overwrites** the previous primary for that scenario (no version pile-up in-tree).
3. Optional `frames/` is replaced as a set when keyframe mode runs.
4. Bus outcome entries **link** to the evidence path; they do not embed binaries.
5. Run-local copies under `.optimizexp/runs/<runId>/artifacts/` are allowed as scratch; **canonical** evidence is the feature folder path.
6. Native capture may promote only media created or changed by the current command; preserve its exit code and mark non-zero captures degraded.

## Capture priority by interface

| Interface | Prefer | Fallback chain |
|---|---|---|
| **web** | Browser video recording (Playwright / browser MCP) | Screenshot sequence → stitch to video → GIF |
| **native** | Computer-use / OS recorder video | Screenshots at key moments → stitch → GIF |
| **tui** | Terminal recording (asciinema cast / script) + screen size | Full terminal transcript + cols×rows + optional PNG of terminal if available |
| **cli** (non-TUI) | Replayable asciicast (`primary.cast`) + HTML player + transcript | Transcript only when recording is impossible; mark degraded |
| **api** | Replayable Playwright/API script plus sanitized HAR or structured request/response trace | A raw log is supporting evidence only; preserve status, headers, payload, timing, and correlation id |
| **docs** | Rendered page screenshot or HTML snapshot | Markdown excerpt + path |

**Visual artifacts prefer video.** If video cannot be produced or attached:

1. Capture keyframe screenshots at expect/act/outcome boundaries
2. Stitch to **mp4/webm** if `ffmpeg` exists
3. Else stitch to **GIF** (markdown/PR friendly)
4. Else keep ordered PNGs + `frames/index.md`

GUI evidence is graphical by definition: a DOM dump, accessibility tree, event
log, or screenshot of JSON cannot stand in for the rendered web/mobile/desktop
journey. TUI evidence may be text-native (`.cast`) because the terminal state is
the interface; graphical terminal capture is preferred when available. API
evidence is an exchange history, not a visual artifact, and must be replayable
from a sanitized script/HAR/trace.

## meta.json (required)

```json
{
  "featureId": "agent-check-staged",
  "scenarioSlug": "staged-skill-edit-selects-skill-gates",
  "personaIds": ["developer"],
  "interface": "cli",
  "driver": "cli",
  "capturedAt": "2026-07-30T21:00:00.000Z",
  "runId": "20260730-dx-baseline",
  "screen": { "cols": 120, "rows": 40, "widthPx": null, "heightPx": null },
  "primary": {
    "file": "primary.cast",
    "kind": "recording",
    "bytes": 4096,
    "sha256": "…"
  },
  "frames": [],
  "repro": {
    "command": "pnpm agent:check -- --staged",
    "cwd": ".",
    "envKeys": ["CI_AGENT"]
  }
}
```

## manifest.json (required)

```json
{
  "scenarioSlug": "staged-skill-edit-selects-skill-gates",
  "primaryPath": "primary.cast",
  "kind": "recording",
  "updatedAt": "2026-07-30T21:00:00.000Z",
  "overridesPrevious": true
}
```

## Independent review (required before scoring)

Capture writes `review.json` with `status: "pending"`. Playback must be
reviewed by a human or independent agent:

```bash
node --import tsx .agents/skills/optimizexp/harness/capture-evidence.mts \
  --mode review --feature <id> --scenario <slug> --reviewer <agent-or-human> \
  --relevant yes --complete yes --covered-claims all \
  --notes "Playback covered entry, each action, and the visible outcome."
```

The reviewer must confirm identity, relevance, and full-journey coverage. The
review stores the primary SHA-256; recapture invalidates the prior review.
Strict validation and `assert-complete` reject pending/partial/degraded,
hash-mismatched, or claim-incomplete evidence.

## Bus linkage

Outcome entries MUST include:

```json
"evidence": {
  "featureId": "agent-check-staged",
  "scenarioSlug": "staged-skill-edit-selects-skill-gates",
  "path": ".optimizexp/features/agent-check-staged/evidence/staged-skill-edit-selects-skill-gates/",
  "primary": "primary.cast",
  "kind": "recording"
}
```

Metrics without an evidence path are invalid. CLI/TUI captures must expose a replayable cast and generated `REPLAY.html`; transcripts are supporting summaries, not the primary visual evidence.

## Secrets

Redact tokens, cookies, and `.env` values before writing evidence. Prefer env **names** in `repro.envKeys`. Harness applies a basic redaction pass; agents must not disable it for convenience.

## PR publishing

After a PR exists for the iteration, post evidence per `references/pr-delivery.md`. Large media: compress, downscale, split comments, or link to committed paths in the PR branch when upload APIs refuse the payload.
