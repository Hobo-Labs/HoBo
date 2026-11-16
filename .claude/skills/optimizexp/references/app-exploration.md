---
type: Agent Skill Reference
title: "OptimizeXP app exploration (surface map)"
description: "Cold-start probes, surface-map.json schema, and how exploration feeds the experience catalog."
tags: [hobo, optimizexp, explore, surface-map, discovery]
timestamp: 2026-07-31T00:00:00Z
---

# App exploration

## Product binaries vs source (critical)

When the project ships a **compiled CLI** (e.g. `@hobo/hobo` → `hobo` → `dist/`):

1. **Build before capture** — `pnpm --filter @hobo/hobo build` (or the package's `pnpm run build`).
2. **Exercise the installed binary** — `hobo --help`, not only `node --import tsx packages/hobo/src/bin/…`.
3. **Link the package's declared bin** rather than a symlink you made yourself, so a rebuild reaches it.

Scoring `tsx src` while the user runs stale `dist` is a false green. Evidence commands should match the persona's real entrypoint.


Exploration produces a machine-readable **surface map** that **feeds** the experience catalog and feature generation. It is not a substitute for high-quality features.

## When

Before generating features for a project (init, bare optimizexp, or explicit):

```bash
node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --project hobo
node --import tsx .agents/skills/optimizexp/harness/explore-app.mts --mode validate --project hobo
```

## Output

```text
packages/hobo/.optimizexp/surface-map.json
# or global:
.optimizexp/surface-map.json
```

## Schema (v1)

| Field | Meaning |
|---|---|
| `binaries[]` | `name`, path/package from package.json `bin` |
| `defaultEntry` | Cold command, `interactive`, `driver` |
| `nonInteractiveHelp` | help / --help command |
| `commands[]` | Discoverable verbs/surfaces |
| `interactiveSurfaces[]` | TUI/chat paths + slash commands when known |
| `requiredJourneys[]` | Always includes default-entry when a binary exists |
| `probes[]` | Live help/empty probes: exitCode + stdoutDigest |

## Probe rules (safe)

1. Prefer **non-TTY** probes with timeouts (never hang on full Pi session during explore).  
2. Run `<bin> help` or `--help` when available.  
3. Detect interactive default from bin comments/docs (`TTY`, `chat`, `title`, `pi`, `splash`).  
4. Enumerate commands from help “Verbs:” tables or known verb arrays.  
5. Redact secrets in any stored probe text.

## Relation to feature quality

- Catalog builder reads surface-map + personas → P0 experiences.  
- Feature `primaryCommand` must align with map/catalog.  
- Interactive `defaultEntry` forces a **tui** (or degraded) default-entry feature.
