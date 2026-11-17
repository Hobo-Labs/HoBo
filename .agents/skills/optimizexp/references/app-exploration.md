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

Mutating exploration, generation, capture, initialization, survey, doctor, and
cross-agent workflow commands preflight their `.optimizexp` trees before writing.
They refuse symlinks,
multiply linked files, and non-regular files in those trees, and refuse project
paths that resolve outside the repository or through a symbolic link to another
location. Use ordinary in-repository metadata
directories and resolve links before retrying. This protects against links
already present when the command starts; it is not atomic against another
process swapping paths during the run. Explicit destinations such as doctor
`--out` and init `--report`, and code intentionally run by a probe or capture,
are outside this preflight guarantee.

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
| `binaries[]` | `name`, repository-relative path, and package from package.json `bin` |
| `binAssessments[]` | Per-bin observed help or an explicit unverified disposition |
| `defaultEntry` | Cold command, `interactive`, `driver` |
| `nonInteractiveHelp` | help / --help command |
| `commands[]` | Discoverable verbs/surfaces |
| `interactiveSurfaces[]` | TUI/chat paths + slash commands when known |
| `requiredJourneys[]` | Always includes default-entry when a binary exists |
| `probes[]` | Explicit help probes: exitCode, stdoutDigest, and primary executable SHA-256 |

`cliAssessment` records only the `package.json` **bin** field. A valid
manifest with no declared bin makes package-bin CLI coverage not applicable;
it does not establish that scripts, web interfaces, or other experiences are
absent or covered. A missing or malformed manifest, or an old map without an
assessment, remains unverified. Re-explore after a manifest changes. Catalog
generation and doctor report the scoped status and refuse unknown or stale
assessments instead of treating an empty map as a pass. Catalogs are bound to
the full map; regenerate a catalog whenever its map changes. A secondary bin
remains unverified: this catalog cannot yet assess secondary-bin journeys, and
the binary may use a non-CLI protocol. The
catalog records persona goals whose required command has not been observed as
unverified, including the FinOps cost goal when neither a `cost` command nor cost-specific `plan`
help is observed. A generic `plan` verb is insufficient. Cost-specific help
selects a journey to inspect cost information; it does not prove runtime
output includes an accurate cost estimate. Secondary-bin journeys, including
`hobo-mcp`, block `from-catalog` until per-bin assessment is supported.

## Saved observations and scoped confirmation

An explicit `--probe-bin` observes the primary binary's help at that moment and
records a SHA-256 of its executable bytes before and after the probe. Later
validation, doctor checks, catalog planning, feature generation, and re-wiring
require an operator assertion scoped to that project and exact map digest:

```text
--confirm-surface-current=<project-id>:<surfaceMapDigest>
```

Copy `surfaceMapDigest` from that project's saved `experience-catalog.json`.
Use the flag only after independently checking that the observation still
represents the binary's imports, configuration, and execution environment.
Repeat it for each project. The command also re-hashes the declared executable;
changed or unreadable bytes refuse the saved observation even with the flag.
A file hash cannot prove unchanged dependencies or runtime behavior. Re-explore
with `--probe-bin` when the observation is stale. No binary is run to validate
the saved map. A no-bin assessment does not require this assertion.

From-catalog generation preserves the selected catalog entry exactly; an
unknown command stays a stub unless it is an observed primary-bin entry or a
declared local package script. Web entries are not run as shell commands.

## Probe rules

1. Discovery executes no project binary by default. `--probe-bin` explicitly
   runs the primary declared binary with `--help`, inheriting the environment;
   even help can change state or use credentials. Use it only for trusted code
   in an appropriate environment. Secondary binaries are not started.
2. A failed, missing, or unrequested probe leaves help and commands unknown.
3. Infer an interactive default only from the primary bin's source or an
   affirmative README statement about the default; treat the result as a
   heuristic until it is exercised.
4. Enumerate commands from successful help output. A source array alone is not
   evidence that the dispatched binary uses it. A
   persona desire alone does not prove a command exists.
5. Redact secrets in any stored probe text.

## Relation to feature quality

- Catalog builder reads surface-map + personas → P0 experiences.  
- Feature `primaryCommand` must align with map/catalog.  
- Interactive `defaultEntry` forces a **tui** (or degraded) default-entry feature.
