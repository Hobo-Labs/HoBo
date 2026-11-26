---
name: unity-cli
description: "Drive Unity from the terminal with the unity CLI: install/manage Editors and modules, open projects, auth, CI builds/tests, com.unity.pipeline automation, unity command/eval against a live Editor or Player, MCP setup, and structured JSON automation. Use when installing Unity CLI, Hub headless migration, batchmode builds, pipeline package, CliCommand, agentic Unity workflows, or unity --help/doctor/status."
metadata:
  short-description: "Unity CLI, pipeline package, and agent automation."
  version: 1.7.0
  tested-against:
    unity-cli: 1.0.0-beta.2
    com.unity.pipeline: 0.3.1-exp.1
    unity-editor: 6000.5.4f1
    os: macOS 26.5.2
---

# Unity CLI

Operate Unity the way automation and agents need it: a fast standalone `unity` binary for editors and projects, plus `com.unity.pipeline` so a **running** Editor (or dev Player) becomes a local, self-describing command surface.

The CLI is **experimental**. Treat `unity --help` on the installed binary as authoritative when docs and flags disagree.

## Versioning & Provenance

**Skill version 1.7.0** — field-tested against Unity CLI `1.0.0-beta.2`, `com.unity.pipeline` `0.3.1-exp.1`, Unity Editor `6000.5.4f1`, macOS 26.5.2. If your installed versions differ, expect flag/command drift and lean harder on live `--help` and `unity command` discovery. The built-in command catalog in `references/pipeline-and-commands.md` decays fastest.

- **1.0.0** (2026-07-23) — authored from official Unity CLI/pipeline docs plus the live `--help` surface.
- **1.1.0** (2026-07-23) — field lessons from real automation sessions: disk-level asset surgery workflow (GUID discipline), tiered verification ladder, Hub cold-start latency, filenames-vs-GUID-wiring anti-patterns.
- **1.2.0** (2026-07-24) — agent scene-composition field lessons: `-automated` Editor, place→measure→assert loop, composition audits (prop AABB / pier contact / stair rise), hero frame + close-up Scene screenshots (see Workflow G in `references/agent-workflows.md`).
- **1.3.0** (2026-07-24) — shader / render look-dev field lessons: shader errors are invisible to `get_console_logs` (use `ShaderUtil.GetShaderMessages`), `capture_game_view` is project-root scoped, Play Mode gates scene edits but not asset edits, probe package paths and API shape instead of trusting memorized ones (see Workflow H in `references/agent-workflows.md`).
- **1.4.0** (2026-07-24) — test-isolation field lessons from a live driving session: never disable gameplay components to freeze state for a test (the disabled flags get baked into the saved scene by the agent's own save path), always read the output of a restore/cleanup step instead of piping it to `/dev/null`, and the Editor does not tick `Update`/`LateUpdate` while unfocused — invoke the frame method directly via eval for a deterministic single-frame capture (see Workflow H in `references/agent-workflows.md`).
- **1.5.0** (2026-07-25) — asset & render gotchas from a sprite/lighting session: Unity strips `_EMISSION` when `globalIlluminationFlags` is `EmissiveIsBlack`; a depth-writing sprite clips ground decals queued after it; measuring texture art needs `isReadable` + uncompressed; crop high-res captures instead of moving the camera (normalize `WorldToScreenPoint` first); `editor_stop` is advisory; review incidental diffs before committing.

- **1.6.0** (2026-07-25) — layout field lessons: declare each zone rect ONCE and derive mass/floor/rails from it (hand-typed insets invert their sign eventually), prove reachability with an ASCII raycast walkability map before trusting screenshots, `FloorToInt` not `RoundToInt` when tiling to a rect, and Unity's `SaveAssets()` mtime touches showing as phantom `git status` modifications (Workflow G).
- **1.7.0** (2026-07-25) — Workflow G gains its framing and two missing measurements: placement is a measurement problem, not a coordinate problem (an asset's name records what the artist called it, not its geometry); unit forensics (two packs can share root scale 100 while one is authored in metres and the other centimetres — normalizing the root scale shrinks the second 100x into apparent non-loading); and surface-vs-bounding-box (`bounds.max.y` on a pier is the mooring poles, not the deck — histogram vertex heights and take the dense band).
## Philosophy: Three Layers, One Feedback Loop

Think of the Unity CLI as three stacked surfaces:

| Layer | Role | Typical verbs |
|-------|------|----------------|
| **Manage** | Machine setup — Editors, modules, auth, projects | `install`, `editors`, `auth`, `open` |
| **Drive** | Control a live Editor/Player via Pipeline | `pipeline install`, `command`, `list`, `status` |
| **Reach** | Ad-hoc power when no registered command fits | `command eval`, `command eval_file` |

**Agent loop**: observe → act → verify. Prefer structured results over scraping console text.

**Before running anything, ask**:
- **Goal layer**: Setup machine, open project, CI batchmode, or live Editor automation?
- **Instance state**: Is an Editor already open on this project? Is Pipeline installed and reachable?
- **Side effects**: Install/uninstall vs read-only inspect vs mutate scene/assets vs Play Mode?
- **Output contract**: Human terminal, pipe/script (`tsv`/`json`), or agent tool (`--format json`)?
- **Authority**: Prefer live `unity <cmd> --help` over memorized flags when unsure.

**Core principles**:
1. **JSON for machines, human for humans**: Automation and agents should use `--format json` (or `UNITY_FORMAT=json`). Don't parse progress bars.
2. **Discover, then act**: `unity command` / `unity list` report what the connected Editor actually exposes. Don't assume a fixed command list across package versions.
3. **Prefer registered commands over eval**: Use named Pipeline commands for stable automation; use `eval` for one-off inspection and unanticipated APIs.
4. **Confirm destructive mutations**: Many Pipeline mutators gate on `confirm` / `dry_run`. Use dry-run first when available.
5. **Localhost-only power**: Pipeline is local and token-gated. Never treat it as a production remote API; runtime server is for dev/QA Players only.
6. **Match project Editor version**: Open/build/test against `ProjectSettings/ProjectVersion.txt` unless the user explicitly overrides.
7. **Disk is also an API**: Unity assets are text YAML plus `.meta` GUID pairs. Deliberate on-disk edits (asset text, sprite bytes) + an import refresh are a legitimate automation layer alongside Pipeline commands — see `references/agent-workflows.md` Workflow F for GUID discipline.
8. **Slow ≠ hung**: Hub-backed commands (`editors`, first `install`) can take 25s+ while services wake cold. Wait it out with `--format json`; don't kill and retry.

## Quick Orientation

```bash
# Install CLI (macOS/Linux; beta channel as of docs)
curl -fsSL https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.sh | UNITY_CLI_CHANNEL=beta bash
# Windows PowerShell:
# $env:UNITY_CLI_CHANNEL='beta'; irm https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.ps1 | iex

unity --version
unity --help
unity doctor --format json
unity auth status --format json
unity editors -i --format json
```

Binary typically lives under `~/.unity/bin` (sourced via `~/.unity/env`). Self-update with `unity upgrade`.

**Global flags worth muscle memory**:
- `--format json|tsv|human|ndjson` / env `UNITY_FORMAT`
- `--non-interactive` / `UNITY_NON_INTERACTIVE` (CI — no prompts)
- `--no-banner`, `--quiet`, `--verbose`
- Exit codes: `0` success, `1` error, `130` cancelled

**Streams**: data on `stdout`, errors on `stderr`. Piped stdout defaults to **TSV** — set `--format` explicitly in scripts.

## Decision Tree

```
Need Unity capability from terminal?
├─ Install/list Editors or modules?     → Manage layer (install / editors / modules)
├─ Sign-in / service identity?          → auth
├─ Open project in correct Editor?      → open (or unity ./Project)
├─ Headless tests / CI Player build?    → test / build / run (batchmode spawn)
├─ Live inspect or mutate open Editor?  → Drive layer
│   ├─ Pipeline missing?                → unity pipeline install && reopen/recompile
│   ├─ Server not reachable?            → unity status / pipeline list; wait for domain reload
│   ├─ Known operation?                 → unity command <name> ...
│   └─ Ad-hoc C# / unknown API?         → unity command eval "..."
├─ Bulk asset swap / GUID retarget?     → disk-level YAML edit + refresh (Workflow F in workflows ref)
└─ Wire an AI client?                   → unity mcp / unity mcp configure <client>
```

## Manage Layer (Editors, Auth, Projects)

### Install and modules
```bash
unity install lts
unity install 6000.5.4f1 -m webgl android --cm --accept-eula --yes
unity install-modules -e 6000.5.4f1 -l
unity install-modules -e 6000.5.4f1 -m ios android --accept-eula
unity uninstall 6000.3.7f1
```

**Version aliases**: `latest`, `lts`, `default`, short streams like `6` / `6.5` / `2022`.

**CI installs** need non-interactive flags: `--yes`, `--accept-eula`, and often `--non-interactive`. Use `--cm` when child modules (SDK/NDK) matter.

### Editors registry
```bash
unity editors -i --format json          # installed
unity editors -r                        # available releases
unity editors default                   # show default
unity editors default 6000.5.4f1        # set default
unity editors add /Applications/Unity/Hub/Editor/6000.5.4f1/Unity.app
```

### Open, projects, auth
```bash
unity open ./MyProject                  # or: unity ./MyProject
unity auth login
unity auth status --format json
unity auth logout
```

Only Hub/CLI-installed Editors can receive modules. Manually dropped Editors must be registered (`editors add`) or reinstalled.

Deep flags, logs, Hub migration: see `references/cli-reference.md`.

## Drive Layer (Pipeline + Commands)

Requires **Unity 6.0+**, signed-in CLI (`unity auth login`), and package in the project:

```bash
unity pipeline install --project-path .
# optional pin: --package-version 0.3.1-exp.1
unity pipeline list --format json
unity status --format json
```

After install, the Editor must import/recompile. Package present ≠ server reachable — wait until `pipeline list` / `status` shows a reachable server.

```bash
unity command                           # list commands on connected Editor
unity list                              # same idea: tools on connected Editor
unity command --project-path . editor_status
unity command find_gameobjects --name Player
unity command editor_play
unity command get_console_logs
```

**Targeting**:
- `--project-path <path>` when multiple Editors are open
- `--runtime <player name>` or `--runtime-path <dir>` for a **development** Player
- `--timeout <seconds>` (default 30)

### Eval (reach any API)
```bash
unity command eval "return Application.version;"
unity command eval "return UnityEditor.EditorApplication.isPlaying;"
unity command eval "var s = Application.dataPath; return s.Length;" --format json
unity command eval_file path/to/script.cs
```

Eval is compiled with Roslyn on the main thread — powerful and fast, security-token gated. Prefer small pure expressions with explicit `return`.

### Custom project commands
Expose stable agent tools with attributes (no manual registration):

```csharp
using Unity.Pipeline.Commands;
using UnityEngine;

public static class MyPipelineCommands
{
    [CliCommand("greet", "Log a greeting and return its length")]
    public static int Greet(
        [CliArg("name", "Who to greet", Required = true)] string name)
    {
        Debug.Log($"Hello, {name}!");
        return name.Length;
    }
}
```

```bash
unity command greet --name World
```

Built-in command map (assets, scenes, GameObjects, prefabs, tests, play mode, …): see `references/pipeline-and-commands.md`.

## CI / Batchmode Layer

These spawn the Editor; they do **not** require a GUI session, but they do need a matching Editor install and license/auth story for the environment.

```bash
# Tests
unity test . --mode EditMode --filter MySuite --output test-results.xml --format json

# Player build (requires project executeMethod)
unity build . --target WebGL --execute-method Builder.PerformBuild -o Builds/WebGL

# Generic batchmode forward
unity run . --args "-batchmode -nographics -quit -executeMethod My.Method"
```

Prefer Pipeline `run_tests` / `build` **against a warm Editor** when iterating interactively; prefer `unity test` / `unity build` for clean CI agents.

## MCP and Agent Wiring

```bash
unity mcp configure --list
unity mcp configure vscode --local --yes    # project-local where supported
unity mcp --project-path .                  # stdio MCP server for this project
```

Pipeline commands map naturally to tool calls. Agents should:
1. `status` / `pipeline list` — is the Editor alive and reachable?
2. `command` with no args — what tools exist **now**?
3. Call specific commands with `--format json`
4. Verify via `get_console_logs`, captures, tests, or Play Mode status

Workflows and anti-footguns: `references/agent-workflows.md`.

## Anti-Patterns to Avoid

❌ **Parsing animated progress or human tables in scripts**  
Why bad: format is for eyes; pipes default to TSV and progress is unstable.  
Better: `--format json` and check exit codes.

❌ **Using Hub `-- --headless` syntax on the new CLI**  
Why bad: flags moved (`install -v` → positional version; `-e` for modules; errors on stderr).  
Better: migrate with `references/cli-reference.md` Hub migration section.

❌ **Assuming Pipeline is live because the package is in manifest.json**  
Why bad: server starts after import; domain reload / Safe Mode can block it.  
Better: `unity pipeline list` / `unity status` and wait for reachable.

❌ **eval for every mutation**  
Why bad: unreproducible, hard to review, easy to skip safety gates.  
Better: registered commands + `confirm`/`dry_run`; reserve eval for discovery.

❌ **Pointing runtime Pipeline at production Players**  
Why bad: remote control surface is for dev/QA only, off by default for a reason.  
Better: development builds only, localhost, token-gated.

❌ **Interactive prompts in CI**  
Why bad: hangs the job.  
Better: `--non-interactive --yes --accept-eula` and explicit versions.

❌ **Ignoring ProjectVersion.txt**  
Why bad: wrong Editor → silent API/package mismatches.  
Better: `unity open` / default resolution, or pin `--editor-version`.

❌ **Treating docs-only command lists as complete**  
Why bad: experimental surface moves; projects add `[CliCommand]`s.  
Better: live `unity command` discovery every session.

❌ **Killing a "hung" CLI call after a few seconds**  
Why bad: Hub-service-backed commands legitimately take 25s+ on cold start; killing mid-flight can leave partial state.  
Better: allow ~60s before diagnosing; then `unity doctor` / `--verbose`.

❌ **Trusting asset filenames over GUID wiring**  
Why bad: prefab/clip/inspector references are the source of truth; filenames lie (a `Death.wav` may be wired as the respawn sound).  
Better: trace `guid:` references in the YAML, or query the live Editor (`get_component_properties`, eval).

❌ **Checking the console for shader compile errors**  
Why bad: `get_console_logs` is silent on shader compilation, and `Shader.Find()` returns a non-null handle for a broken shader — so both say "fine" while the screen renders magenta.  
Better: `UnityEditor.ShaderUtil.GetShaderMessages(shader)` plus `shader.isSupported`; for look changes, a fresh `capture_game_view` you actually read is the test (see Workflow H).

❌ **Treating "Play Mode ran with 0 console errors" as full verification**  
Why bad: scale, binding, and visual bugs pass a clean-console smoke test.  
Better: tiered evidence — structural checks on asset text, console logs, Play Mode, and a screenshot artifact at a stable repo path (see `references/agent-workflows.md`).

❌ **Treating "named mesh placed + wide Game screenshot" as layout done**  
Why bad: thin floor tiles look like platforms, full stair meshes on near-zero height deltas stab fences, crates/wagons interpenetrate, posts miss deck undersides — all pass a distant hero PNG.  
Better: place → measure `bounds` → assert contacts/non-overlap → capture **Game hero + close Scene** of the junction; promote regressions into Verify / disk tests (Workflow G).

❌ **Driving agent layout without `-automated`**  
Why bad: modal dialogs block Pipeline and hang the session.  
Better: open the project with `-automated` (e.g. project helper or `unity open … --args "-automated"`).

❌ **Disabling gameplay components to freeze state for a test**  
Why bad: Play Mode toggles look reversible, but the agent's own save path (builder re-run, `SaveOpenScenes`, an edit-mode toggle) bakes the disabled state into the saved scene — the user opens Play Mode to a locked camera and an immobile player.  
Better: read state without mutating it, or accept a moving target across frames; if a toggle is unavoidable, disable **and** restore inside a single eval call — never split disable and restore across two calls.

❌ **Piping a restore/cleanup step's output to `/dev/null`**  
Why bad: a cleanup you have not verified is not a cleanup — the restore can silently fail to apply.  
Better: read the actual output of every restore call before declaring the scene clean.

## Variation Guidance

**IMPORTANT**: Choose the path from context — do not always open the Editor, always eval, or always batchmode.

- **Greenfield machine** → install CLI → auth → install Editor+modules → open project → pipeline install  
- **Day-to-day gameplay fix with Editor open** → `status` → discover commands → mutate → Play Mode → console/logs  
- **Agent-built scenes / kitbash vignettes** → Workflow G: rebuild recipe + composition audit + dual screenshots  
- **CI regression** → non-interactive `unity test` / `unity build` with JSON/XML artifacts  
- **Unknown engine question** → small `eval` probes, then promote stable ops to `[CliCommand]`  
- **Multi-project host** → always pass `--project-path`

Vary command choice with package version, whether Play Mode is active, and whether the user wants durable project changes vs throwaway inspection.

## References

- **CLI manage/automation surface**: `references/cli-reference.md`
- **Pipeline package + built-in commands + custom commands**: `references/pipeline-and-commands.md`
- **Agent/CI observe-act-verify patterns**: `references/agent-workflows.md`

External docs (may lag the binary):
- https://docs.unity.com/en-us/unity-cli/use-unity-cli
- https://docs.unity.com/en-us/unity-cli/unity-cli-reference
- https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package
- Package manual: `com.unity.pipeline` Documentation~

## Remember

The CLI is not a thinner Hub — it is the **execution surface** for scripts, CI, and agents. Manage installs cleanly, drive a live Editor when feedback speed matters, and use eval as a scalpel. Always prefer discoverable, structured, verifiable operations over brittle GUI automation or log scraping.

**When in doubt**: `unity doctor`, `unity status`, `unity command`, then the smallest command that proves the next fact.
