---
type: Reference
title: "HoBo Code isolation & cleanup runbook"
description: "Historical record of the removed HoBo Code isolation and cleanup workflow (ADR-0139)."
tags: [hobo, design, code, isolation]
---

# HoBo Code isolation & cleanup runbook

> **Historical:** `packages/code`, `@hobo/code`, and the `hobo-code` binary
> were removed. The commands and package APIs below describe the former
> implementation and are no longer runnable from this repository. The source
> remains in [commit `225352177`](https://github.com/Hobo-Labs/HoBo/tree/225352177c2bb83574b5669b82efafec9575a876/packages/code);
> see also [ADR-0139](./adr/03-data-plane.md#adr-0139).

## Platform matrix

| Platform | Preferred | Fallback | CI default | Notes |
|---|---|---|---|---|
| Linux btrfs / reflink | rift | worktree | worktree | Enable with `HOBO_RIFT=1` + `HOBO_RIFT_COW=1` |
| Linux generic (no CoW) | worktree | worktree | worktree | Classical git worktrees only |
| macOS APFS | rift | worktree | worktree | clonefile path when probe succeeds |
| Windows | worktree | worktree | worktree | Always worktree |

Rift is experimental and **never vendored** into the monorepo. Worktree is first-class.

## Layout under `HOBO_HOME`

```text
$HOBO_HOME/
  sandboxes/<runId>/     # ephemeral mediated view (cleaned always)
  durable/code/<runId>/  # handback, evidence, promotions, isolation.json
  worlds/<runId>/        # Local World durable checkpoints
```

Durable learning artifacts survive cleanup. Ephemeral roots never hold institutional knowledge.

## Lifecycle

1. **Create** — `hobo-code isolate` or `hobo-code session`  
   - Dedicated branch `code/<runId>`  
   - Station pin when available (`--station` / profile)  
   - `mediatedOnly: true` — canonical project is read-only for agents  

2. **Work** — agents/subagents only in the isolation root  
   - Subagents are **Eve-shaped** (filesystem-first; parent delegates like tools)  
   - Secure path: **DeepAgents + OpenShell + MxC** (credentials outside sandbox)  
   - Schema/contract fixtures only; no ambient credentials  
   - Skills via harness core; token tools global/MCP  
   - Durable steps/checkpoints: **Local World** offline; **Vercel Workflow World** prod shape

3. **Evidence** — passing Gherkin + OpenFeature emits Playwright + mp4 + screenshots under `durable/code/<runId>/evidence/`  

4. **Promote** — `hobo-code promote <runId>`  
   - Required gates: `architecture:guard`, `standards:check`, `agent:check`, `docs:freshness`  
   - Exclusive squash-merge only  
   - Audit record under `durable/code/<runId>/promotions/`  

5. **Cleanup (mandatory)** — success, cancel, or exception  
   - Remove sandbox root  
   - `git worktree remove` + `prune` when applicable  
   - Delete task branch  
   - Assert `listSandboxOrphans(hoboHome) === []`  
   - Primary worktree stays clean  

## Operator commands

```bash
# Default verb is dispatch:
hobo-code "refine the openui bindle"
hobo-code dispatch "refine the openui bindle"

hobo-code status            # box chrome · STATE/AGENT/SUMMARY · chip
hobo-code platform          # flag LED strip (all ON by default)
hobo-code join tyler        # ◇ human join + peer preview
hobo-code agent worker      # ◆ agent identity
hobo-code nodes             # capacity bars
hobo-code rooms             # human/agent inventory
hobo-code session           # isolation + mux chrome
hobo-code scaffold --name demo   # first paint + step rail
hobo-code isolate run-demo
hobo-code promote run-demo  # gate checklist
hobo-code budget            # spend meter
hobo-code remote            # named endpoint reach
hobo doctor                 # includes data.codeHarness (ADR-0139)

# All code.* flags default ON; disable only deliberately:
hobo feature set code.monetization.surface --percent 0
HOBO_CODE_MONETIZATION=0 hobo-code budget
```

Status chrome is a Herdr-style box (`renderStatusText`) with glyph legend; human verb panels share a 44-col rule via `panel()`.

## Failure & abort

Always run cleanup. Prefer:

```ts
import { cleanupIsolation, listSandboxOrphans } from "@hobo/code";

try {
  // agent work
} finally {
  cleanupIsolation(runId, { hoboHome, ok: false, gates: ["aborted"] });
  if (listSandboxOrphans(hoboHome).length > 0) {
    throw new Error("orphan sandboxes remain");
  }
}
```

## Remote

`hobo-code remote` registers the deterministic named endpoint (`code` resource, ADR-0130).  
mosh is optional resilience for lossy mobile/SSH-from-phone sessions; primary path is tailnet + named DNS.

## Related

- [ADR-0139](./adr/03-data-plane.md#adr-0139)
- [CLI spec — `code`](./cli-spec.md)
- `@hobo/stations` (ADR-0131)
- `@hobo/connectivity` named endpoints (ADR-0130)
