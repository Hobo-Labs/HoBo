# Pipeline Package & Live Commands

`com.unity.pipeline` turns a running Unity Editor (or development Player) into a localhost automation target for the `unity` CLI, CI, and agents.

Package docs index: Unity package `com.unity.pipeline` → Documentation~  
Product page: https://docs.unity.com/en-us/unity-production-pipeline/local-tools-cli/unity-pipeline-package

Experimental — command sets evolve. **Always discover** with `unity command` on the connected instance.

## Prerequisites

- Unity **6.0 LTS+**
- Unity CLI installed and on `PATH`
- `unity auth login` (or valid CI credentials)
- Project can compile (not stuck in fatal Safe Mode without Pipeline)

## Install / upgrade

```bash
unity pipeline install
unity pipeline install --project-path /path/to/project
unity pipeline install --package-version 0.3.1-exp.1
unity pipeline install --force          # re-resolve latest
unity pipeline upgrade
unity pipeline list-versions --format json
unity pipeline list --format json
```

`pipeline install` writes package dependency into the project (`Packages/manifest.json` / lock). Commit those files.

After install: open project (or wait for running Editor recompile). Verify **Pipeline: Installed** and server reachability via `pipeline list` / `status`.

## Connectivity model

- Server binds **localhost** only
- Port/descriptor files locate the instance
- Bearer token auth gates privileged operations (including eval)
- Runtime (Player) path is **opt-in**, for **development** builds — never production

```bash
unity status --format json
unity pipeline list --format json

# List tools
unity command
unity command --project-path /path/to/project
unity list --project-path /path/to/project

# Player runtime
unity command --runtime MyGame runtime_status
unity command --runtime-path "/path/to/MyGame.app" runtime_status
```

If package is installed but `isReachable: false`: wait for domain reload, check console errors, ensure Editor finished importing, retry `status`.

## CLI invocation pattern

```bash
unity command [options] [command-name] [command-args...]
```

| Option | Purpose |
|--------|---------|
| `--project-path` | Disambiguate Editor by project |
| `--runtime` | Player process/exec name |
| `--runtime-path` | Directory / `.app` with runtime port file |
| `--timeout` | Seconds (default 30) |
| `--format json` | Machine-readable result |

Omit `command-name` to list available commands.

## Eval & hot reload

```bash
unity command eval "return Application.version;"
unity command eval "return UnityEditor.EditorApplication.isPlaying;"
unity command eval_file ./tools/probe.cs
```

- Roslyn compile, main thread
- Prefer explicit `return` expressions
- Keep snippets small and side-effect intentional
- Hot reload variants (package): `reload_file`, `reload_file_override`, `hotreload_status`, `cleanup_hotreload`

## Authoring custom commands

```csharp
using Unity.Pipeline.Commands;
using UnityEngine;

public static class GameAutomationCommands
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

Design tips:
- Static methods; attributes discover automatically
- Clear command names (snake or short verbs matching built-ins style)
- Document args; mark required fields
- Respect `MainThreadRequired` / `RuntimeOnly` as needed
- For mutations: follow package **confirm / dry_run** and undo-scope conventions
- Prefer returning structured serializable data over only `Debug.Log`

See package guides: Creating commands, Authoring commands, Safety & mutations.

## Built-in command catalog (overview)

Names below are from `com.unity.pipeline` 0.3.x docs. Your Editor may add/remove entries — discover live.

### Assets & files
`create_asset`, `import_asset`, `move_asset`, `copy_asset`, `rename_asset`, `delete_asset`, `find_assets`, `set_import_settings`, `get_import_settings`, `create_folder`, `read_text_file`, `write_text_file`

### Scenes
`create_scene`, `open_scene`, `save_scene`, `save_all`, `list_open_scenes`, `set_active_scene`, `get_scene_hierarchy`, `add_scene_to_build`, `remove_scene_from_build`

### GameObjects & components
`create_gameobject`, `create_gameobjects`, `find_gameobjects`, `set_transform`, `set_parent`, `set_active`, `set_tag`, `set_layer`, `rename_gameobject`, `delete_gameobject`, `add_component`, `remove_component`, `get_component_properties`, `set_component_properties`

### Prefabs
`create_prefab`, `instantiate_prefab`, `create_prefab_variant`, `apply_prefab_overrides`, `revert_prefab_overrides`, `unpack_prefab`, `save_prefab_contents`

### Scripts
`create_script`, `attach_script`, `set_serialized_field`, `get_serialized_fields`

### Animation / Timeline
`create_animation_clip`, `set_animation_curve`, `get_animation_clip`, `remove_animation_curve`, `create_animator_controller`, `add_animator_parameter`, `add_animator_layer`, `add_animator_state`, `add_animator_transition`, `get_animator_controller`, `create_timeline`, `add_timeline_track`, `add_timeline_clip`, `get_timeline`

### Materials
`get_material_properties`, `set_material_properties`, `list_shaders`, `get_shader_properties`

### Baking (async — poll `*_status`)
`bake_lighting`, `lighting_bake_status`, `cancel_lighting_bake`, `clear_baked_lighting`, `get_lighting_settings`, `set_lighting_settings`, `bake_navmesh`, `navmesh_bake_status`, …, `bake_occlusion_culling`, …

### Selection & search
`get_selection`, `set_selection`, `search`

### Capture
`capture_game_view`, `capture_scene_view`, `capture_editor_element`, `capture_runtime_element`, `screenshot`

**Screenshot practice (agents):** Prefer `screenshot --view Game|Scene --output <stable-repo-path> --width 1920 --height 1080`. Re-frame Main Camera / SceneView before capture when the subject changed. For layout work, save **both** a hero Game shot and a **close Scene** shot of the seam (dock edge, stair, prop pile) — wide Game alone hides thin floors, stabbed rails, and interpenetrating props.

### Build / compile / test (async where noted)
`build`, `build_status`, `switch_build_target`, `list_build_targets`, `get_build_settings`, `set_build_settings`, `list_build_profiles`, `recompile`, `recompile_status`, `list_tests`, `run_tests`, `test_status`, `cancel_tests`

### Project settings
Paired `get_*` / `set_*` for audio, graphics, input, physics, player, quality, tags/layers, time — setters typically need **confirm**.

### Packages
`package_list`, `package_search`, `package_add`, `package_remove`, `package_resolve`, `package_status`

### Editor lifecycle
`editor_play`, `editor_stop`, `editor_pause`, `editor_status`, `editor_focus`, `menu`, `set_autotick`, `get_console_logs`, `clear_console`, `get_performance_stats`, `get_authoring_root`, `set_authoring_root`

### Runtime (Player)
`runtime_status`, `quit`, `set_target_framerate`, `set_timescale`, `simulate_key`, `simulate_pointer`, `log`, `console`, `eval`, `eval_file`, hot-reload commands

## Mutation safety

Shared conventions in package docs:
- **confirm** / **dry_run** gates on destructive or settings changes
- Undo grouping via authoring undo scopes
- Path sandbox under authoring root for content writes

Agent default: dry-run or read commands first; confirm only with user intent for deletes, settings, package remove, build target switches.

## Async operations

Long work (`build`, bakes, `run_tests`, `recompile`, package ops) often returns immediately — **poll** the matching `*_status` command until complete or failed. Raise `--timeout` on the CLI when the synchronous path is used.
