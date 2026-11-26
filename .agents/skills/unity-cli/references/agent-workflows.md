# Agent & Automation Workflows

Patterns for using Unity CLI + Pipeline as an **observe → act → verify** loop.

## Environment bootstrap (once per machine / job)

```bash
export PATH="$HOME/.unity/bin:$PATH"
export UNITY_NON_INTERACTIVE=1
export UNITY_NO_BANNER=1
export UNITY_FORMAT=json

unity --version || {
  curl -fsSL https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.sh \
    | UNITY_CLI_CHANNEL=beta bash
}

unity doctor
unity auth status
# Interactive machines: unity auth login
# CI: inject supported service credentials via env (never commit secrets)
```

## Workflow A — First-time project enablement

Goal: this repo can be driven from the terminal.

1. Read `ProjectSettings/ProjectVersion.txt`
2. `unity editors -i` — install matching Editor if missing (`unity install <ver> -m …`)
3. `unity open .` (or user already has Editor open)
4. `unity pipeline install --project-path .`
5. Commit `Packages/manifest.json` + `packages-lock.json`
6. Wait for compile; `unity pipeline list` until reachable
7. `unity command` — snapshot available tools

## Workflow B — Live bugfix (Editor open)

Example: "player falls through floor"

1. `unity status --project-path .`
2. `unity command` — confirm tools
3. Inspect:
   - `unity command get_scene_hierarchy`
   - `unity command find_gameobjects --name Player` (args per live help)
   - `unity command get_component_properties …`
   - or targeted `eval` for runtime-only state in Play Mode
4. Hypothesize → smallest mutation (enable collider, fix component field)
5. `unity command editor_play` → observe
6. `unity command get_console_logs` / capture game view
7. `unity command editor_stop`
8. Persist fix in project files/assets; don't leave only eval side effects

## Workflow C — Implement feature with verification

1. Edit scripts/assets in the workspace (normal agent file tools)
2. If Editor open: wait recompile (`recompile` / `recompile_status` or natural reload)
3. `unity command get_console_logs` — fail fast on compile errors
4. Run focused tests:
   - Warm Editor: `unity command run_tests` + `test_status`
   - CI-style: `unity test . --mode EditMode --filter …`
5. Optional Play Mode smoke: play → capture → stop
6. Summarize evidence (test XML, log excerpts, screenshots paths)

## Workflow D — Headless CI

Prefer **spawned** Editor jobs for isolation:

```bash
unity test "$PROJECT_PATH" --mode EditMode --output test-results.xml
unity build "$PROJECT_PATH" --target WebGL \
  --execute-method CiBuilder.BuildWebGL \
  -o "$BUILD_PATH"
```

Use Pipeline against a long-lived Editor only when the farm intentionally keeps warm instances (faster feedback, more state leakage risk).

## Workflow E — MCP client

```bash
unity mcp configure --list
unity mcp configure cursor --local --yes
# or
unity mcp --project-path /path/to/project   # stdio server
```

MCP exposes the same local automation surface. Still apply confirm/dry-run discipline for mutations.

## Workflow F — Disk-level asset surgery (art/audio swaps, bulk retargets)

Unity assets are plain text (YAML) plus a `.meta` file whose `guid:` is the identity every
scene, prefab, and clip reference points at. For content swaps and bulk edits, editing files
on disk is often faster and more reviewable than driving the Editor — the Editor just imports
the result.

Two swap strategies, chosen deliberately:

| Strategy | How | Properties |
|----------|-----|------------|
| **In-place overwrite** | Replace asset bytes (e.g. PNG), keep the existing `.meta` (same GUID) | All references keep working automatically; original only recoverable via git |
| **Dual-pack + GUID retarget** | Keep both asset packs on disk; rewrite `guid:` references in `.asset`/prefab/clip text (or via an editor script) | Reversible A/B toggle; record slots in a manifest (e.g. `world-artset-manifest.json`) |

Rules learned the hard way:

1. **Never delete or regenerate a `.meta`** for an asset that anything references — that orphans every reference.
2. **Filenames lie; GUIDs don't.** Before swapping "the death sound" or "the tree sprite", grep the YAML for which GUID is actually wired where (clips, prefabs, StateMachineBehaviours). Verify with `get_component_properties` / eval if unsure.
3. **After external disk edits with a live Editor**, force an import before verifying: `unity command import_asset …` or `unity command eval "UnityEditor.AssetDatabase.Refresh(); return true;"`.
4. **Size-lock generative replacements**: match original pixel dimensions, PPU (`spritePixelsToUnits` in the `.meta`), and alpha coverage, or world scale silently drifts.
5. **Promote repeated swap operations** into a project `[MenuItem]` or `[CliCommand]` plus a manifest — the agent gets a stable command and the user gets a one-click toggle.

## Workflow G — Agent scene composition (kitbash / vignette / layout)

Goal: place meshes from a free pack (or primitives) into a readable scene **without** floating skins, stabbed fences, or interpenetrating props — and leave a **reproducible** builder + Verify path.

### The one idea

**Placement is a measurement problem, not a coordinate problem.** An asset's name records what
the artist called it, not what its geometry is. Across a full project every single placement
bug — floating docks, invisible kits, stairs to nowhere, hovering characters — was a *label
standing in for a measurement*:

| Assumed | Actually |
|---------|----------|
| `Floor_WoodLight` is a deck plank | a 2 cm sheet — a carpet floating over water |
| `bounds.max.y` is the dock's walking surface | the mooring-pole tops; the deck was 0.55 m lower |
| `Stairs_Exterior_Platform` is stairs | a legged 1 m table with no steps |
| both kits' root scale 100 means the same | metres in one, **centimetres** in the other |
| a sprite's pivot is the bottom of the cell | 25–29 px of padding below the feet |

None were logic errors; all compiled and ran. So the order is always **measure → derive →
look at it**, and the cheapest of the three is measuring.

### Preconditions

- Editor open with **`-automated`** so modal dialogs do not block Pipeline (`unity open … --args "-automated"` or a project helper script).
- Pipeline reachable: `unity status` / `unity pipeline list` / bare `unity command`.
- Prefer a project **`Build*Scene.Build()`** + **`Verify*Scene.Verify()`** (or `[CliCommand]`) over pure one-off `eval` placement so layout is reviewable and re-runnable.

### Loop (place → measure → assert → capture)

1. **Edit builder / place recipe** on disk; force recompile if needed (`recompile` → poll `recompile_status`).
2. **Rebuild** via eval or menu: `Build….Build()` (saves scene).
3. **Measure after place** (eval or Verify) — do not trust asset names:
   - `Renderer.bounds.size` (thickness, rise, footprint)
   - Thin “Floor_*” (`size.y ≲ 0.15`) = **decoration**, not a platform
   - Stair mesh `size.y` must match real floor-to-floor Δh (near-zero Δh → level walk, not full exterior stairs)
   - **Unit forensics first, before anything else.** Two packs from the *same author* can both
     import at root scale 100 while one is authored in metres and the other in centimetres — so
     the 100× is redundant in one and *is* the unit conversion in the other. Normalizing the root
     scale shrinks the second by 100× into invisibility, which reads as "the asset failed to
     load". Instantiate one prefab from each pack, print `bounds.size`, and decide per pack
     whether to keep or reset the root scale. Getting this wrong costs iterations, not minutes.
   - **A bounding box is not a surface.** `bounds.max.y` on a pier returns the mooring-pole tops,
     not the deck you must stand on. For any walkable/placeable surface, histogram the mesh's
     world-space vertex heights and take the dense cluster:
     ```csharp
     // eval: find the real deck height, not the silhouette's extreme
     foreach (var v in mesh.vertices) {
       var w = mf.transform.TransformPoint(v);
       bucket[Mathf.RoundToInt(w.y * 20f)]++;   // 5 cm bands
     }   // report bands with a high count — those are flat surfaces
     ```
4. **Assert structure & composition** (project Verify and/or eval):
   - Support contact: `postTop ≈ deckBottom` (small positive gap)
   - Stacked props: next pivot Y = base `bounds.max.y + ε` (never a guessed constant)
   - Bulk props (crates/wagon): AABB overlap minFrac above a small threshold → fail
   - Circulation: openings (fence gaps) placed **before** continuous rails across a path
   - Ground modules: no wing fully inside mega-mass; avoid “more boxes = better”
   - 2D characters: ground the sprite on its **art** bounds, not the cell — see the
     texture-measurement gotcha in Workflow H
5. **Prove reachability with a walkability map** before trusting any screenshot. Raycast down on a
   1 m grid and print the surface height as ASCII — it answers *"can the player actually get from
   A to B?"*, which no render can:
   ```csharp
   for (float z = maxZ; z >= minZ; z -= 1f) {
     for (float x = minX; x <= maxX; x += 1f) {
       if (Physics.Raycast(new Vector3(x, 20f, z), Vector3.down, out var hit, 40f)) {
         float y = hit.point.y;
         if (y < waterY) { sb.Append('.'); continue; }
         sb.Append((char)('0' + Mathf.Clamp(Mathf.RoundToInt((y - minY) * bandScale), 0, 9)));
       } else sb.Append('.');
     }
     sb.AppendLine();
   }
   ```
   Solid runs of one digit are flat terraces; the **boundaries** are what matters — intermediate
   digits between two tiers are the step treads, and their presence is the proof that levels are
   *climbable rather than merely adjacent*. A terrace walled in by `.` or by a multi-band jump with
   nothing between is an unreachable island, and you see it in seconds without loading the scene.
   Caveat: it samples the surface only — it cannot tell you a ramp is within the slope limit, that
   the capsule fits a gap, or that a railing does not block the route. Those still need Play Mode.
6. **Screenshot dual evidence** to a **stable repo path** (not only session scratch):
   ```bash
   # Re-frame Main Camera / SceneView first when the subject changed
   unity command screenshot --view Game --output Assets/Screenshots/…-game.png --width 1920 --height 1080
   unity command screenshot --view Scene --output Assets/Screenshots/…-scene.png --width 1920 --height 1080
   ```
   - **Game**: hero framing of the vignette
   - **Scene close-up**: edge, underside, stair junction, prop pile — where bugs hide
7. **Promote regressions**: every user-caught visual bug becomes a Verify check or Python structural test so it cannot silently return.

### Composition principles (field lessons)

| Principle | Practice |
|-----------|----------|
| Measure the job first | Height delta, span, thickness → then pick mesh or prim |
| Structure vs decoration | Thick deck + posts + joists; thin Floor_* only as skin on top |
| Contact constraints | Write equalities (post/deck, stack Y, path ∩ fence = empty) |
| Circulation is geometry | Fence gaps / stair bays first; rails around openings |
| Density ≠ interpenetration | More clear instances, not deeper overlapping piles |
| Hero PNG is not enough | Close Scene + bounds dump after platform/stair/prop changes |
| **Declare a zone once, derive the rest** | One rect per area; bedrock, floor and rails all computed from it |
| **Compute insets, never type them** | `RailEdge(zone, Side.South)` decides the inward direction itself |
| **Floor, don't round, when tiling** | `FloorToInt` — rounding up tiles *past* the rect and overhangs the ground |

#### Single source of truth (the bug this prevents)

The most expensive layout errors of a real session were both the same mistake: **a coordinate
that had to agree in three places, typed three times.**

- Six terrace bedrock volumes were each authored ad-hoc. One ended up 5 cm *above* its floor
  (a lip the controller catches when stepping off a stair — reported by the user as
  *"the stairs are too low to reach the platform"*), two were exactly coplanar with their floor
  (z-fighting), one was 5 cm below (correct).
- Twelve fence lines were each given a hand-typed inset from their zone edge. Where the interior
  happened to lie in the direction subtracted, they looked right; on one platform the sign was
  inverted and the whole railing sat 0.1 m *outside* the rock, floating.

Neither zone was "written more carefully" than the other — the sign just happened to be right.
With ~12 independent chances to invert it, being wrong somewhere is close to certain. The fix is
structural, not vigilance:

```csharp
readonly struct Zone { float MinX, MaxX, MinZ, MaxZ, FloorY; }

TerraceMass(ground, "MassLookout", ZLookout, depth);      // top = FloorY - 0.05, always
FloorTiles(lookout, ZLookout, "Floor_Brick", mat);        // tiled inside the same rect
RailEdge(props, ZLookout, Side.South);                    // inset computed inward
```

Refactoring this way immediately surfaced a *further* latent bug (a floor overhanging its rock by
0.6 m from `RoundToInt`), which is the usual sign the abstraction was the right one.

### Anti-patterns (composition)

- Guessing crate height (`y + 0.5`) or wagon size from the name  
- Continuous fence then a stair mesh through it  
- Nested cliff cubes for “grounding” without a continuous silhouette  
- Declaring layout done after a wide Game capture only  
- Re-typing a zone's edge coordinate for its mass, its paving and its railing  
- A stair whose run is on the wrong **axis**: it can reach the correct height and still arrive
  alongside the platform facing open air (measure the top step's rect against the target's rect,
  not just its Y)  
- Coplanar tops between a slab and the volume under it — z-fighting; sink one by ~5 cm  
- Modelling a wellhead / ring / archway as a **solid** primitive: there is no bore, so anything
  "inside" it is invisible and intersecting. Ring it out of parts instead  

## Workflow H — Shader / render look-dev (custom shaders, post FX, lighting)

Goal: iterate on how the game **looks** — hand-written shaders, full-screen passes, lighting —
where the compiler cannot tell you that the result is wrong.

### The defining constraint

**Every genuine look bug compiles cleanly.** A shader that reports `isSupported=True` with zero
messages can still flood the screen black, crush all shadows, or amplify hue into neon. The
screenshot is not evidence *supporting* the change — it **is** the test. Never report a visual
outcome you have not looked at.

### Loop (write → compile-check → capture → read the image → fix)

1. **Write the shader/material/light change** on disk, then `AssetDatabase.Refresh()` and poll
   `recompile_status`.
2. **Compile-check properly** — the console will *not* show shader errors:
   ```csharp
   // eval: console logs are silent on shader compilation
   var s = AssetDatabase.LoadAssetAtPath<Shader>("Assets/Shaders/X.shader");
   var msgs = UnityEditor.ShaderUtil.GetShaderMessages(s);   // severity, line, message
   return s.isSupported + " msgs=" + msgs.Length;
   ```
   `Shader.Find(name) != null` is **not** proof of compilation — a broken shader still resolves.
3. **Rebuild / apply**, then **capture and actually read the frame**:
   ```bash
   unity command capture_game_view --width 1600 --height 900 \
     --save_path "Assets/Screenshots/lookdev-vN.png"
   ```
   `capture_game_view` **rejects any path outside the project root** — write under
   `Assets/…` and copy to a share/media folder afterwards.
4. **Zoom by cropping, not by moving the camera.** To inspect a small subject, capture at
   high resolution and crop around it — do *not* reposition the camera or disable a follow
   script (see the anti-pattern below). Map world→image via **normalized** coordinates:
   `capture_game_view` renders at the width/height you ask for, but `WorldToScreenPoint`
   returns pixels in the *Game view's own* resolution, which is usually different. Divide by
   `Screen.width/height` first, then multiply by the captured image size, and remember the
   image origin is top-left while Unity's is bottom-left:
   ```csharp
   // eval: report normalized position, then crop the PNG offline
   var sp = Camera.main.WorldToScreenPoint(target.position);
   return (sp.x / Screen.width) + "," + (sp.y / Screen.height);
   ```
4. **Name the defect before changing anything.** "Too dark" is not a diagnosis; "the darkest
   quantization band maps to exactly 0" is. Screenshot-driven guessing burns iterations.
5. **Re-capture from the angle the user complained about**, not the convenient hero angle.

### Probe the installed API — do not trust memorized paths

Render pipeline internals move between versions. Before writing editor/shader code against them:

```bash
# Where does an include actually live in THIS project's package cache?
find <project>/Library/PackageCache -name "Blit.hlsl" -path "*render-pipelines*"

# What shape is this API really? (nested enums, field names, types)
unity command eval "var t = System.Type.GetType(\"UnityEngine.Rendering.Universal.FullScreenPassRendererFeature, Unity.RenderPipelines.Universal.Runtime\");
  foreach (var f in t.GetFields()) sb.Append(f.Name + \":\" + f.FieldType.Name);"
```

Real drift found this way in URP 17.5 / Unity 6: `Blit.hlsl` moved out of URP's `ShaderLibrary`
into **SRP core's `Runtime/Utilities`**; `InjectionPoint` is nested **inside**
`FullScreenPassRendererFeature`; `ApplyShadowBias()` returns a **world** position that still
needs `TransformWorldToHClip()`.

### Play Mode is a partial gate — use it

Scene-mutating calls throw in Play Mode (`EditorSceneManager.NewScene` → *"This cannot be used
during play mode"*), and `editor_stop` may not take effect if the user is actively playing.
But **asset edits apply live**:

| Change | Applies during Play Mode? |
|--------|---------------------------|
| Material property / shader asset edit | **Yes** — iterate freely |
| URP asset & renderer feature settings | **Yes** |
| Scene objects (lights, meshes, components) | **No** — needs a rebuild with Play Mode off |

So: iterate on materials and shaders while the user plays, and **batch scene-object changes
into one rebuild** when they stop. Always poll `EditorApplication.isPlaying` rather than
assuming a stop request landed. Note that runtime-created GameObjects vanish on exit — if a
light only exists because you made it live, it is not saved.

**Never disable a gameplay component to freeze state for a test.** Setting
`PlayerController.enabled = false` (or a camera rig's) to hold velocity/framing still across
separate eval calls looks safe — Play Mode toggles normally revert on exit — but it is not: the
agent's own workflow saves the scene (a builder re-run, `SaveOpenScenes`, an edit-mode toggle),
and the disabled state bakes in. The user opens Play Mode to a locked camera and an immobile
player — the game is broken. Prefer reading state without mutating it, or accept a moving target
across frames. If a component genuinely must be toggled, disable **and** restore it inside a
**single** eval call — never split disable and restore across two calls, since a failed or
forgotten follow-up leaves the scene poisoned.

**Always read the output of a restore/cleanup step.** Writing the restore call is not enough —
piping its output to `/dev/null` "to keep things quiet" means a failed restore goes unnoticed. A
cleanup you have not verified is not a cleanup.

`editor_stop` is a **request, not a guarantee** — it can fail to land, and the user may simply
be playing. Poll `EditorApplication.isPlaying` rather than assuming, and do not repeatedly
force-stop to win the Editor: material, shader and URP-asset edits apply live, so keep
iterating on those and batch scene-object changes for when play mode is genuinely off.

**The Editor does not tick frames while unfocused or backgrounded.** `capture_game_view` can
return a frame that is seconds stale, and `Update`/`LateUpdate` may not have run at all since
your last change — easy to misread as a logic bug. Force a deterministic single-frame step
instead: invoke the update method directly via eval (e.g. `anim.SendMessage("LateUpdate")`),
then capture. Values set by that call persist precisely because nothing else is ticking.

### Gotchas that cost real iterations

- `recompile_status` reports **`"completed"`**, not `"idle"` — a poll loop waiting only for
  `idle` spins until timeout.
- A vertex effect doing *nothing* usually means **topology, not math**: a Unity `Plane`
  primitive is 10×10 quads, so scaled to 160 m each quad spans ~16 m and vertex waves have
  nothing to displace. Check the mesh before debugging the shader.
- Any `col *= a / b` in post-process colour math **needs a clamp** — the ratio form silently
  becomes a saturation amplifier at low luminance (a luma-0.01 pixel taking a 3× multiply turns
  brown shadows blood red).
- Edge detection on raw depth fires on every **grazing-angle** surface; compare a pixel to the
  *mean of its neighbours* (a second derivative) so constant slopes cancel.
- ShaderLab `[Tooltip(...)]` rejects free-form sentences — parse error, not a warning.
- **Unity silently strips the `_EMISSION` keyword** whenever a material's
  `globalIlluminationFlags` is left at the default `EmissiveIsBlack`. URP gates the emission
  contribution on that keyword, so the glow dies on the next reserialize with no error. Set
  `MaterialGlobalIlluminationFlags.RealtimeEmissive` (or Baked) when you author an emissive
  material in script.
- **A depth-writing sprite clips anything queued after it.** An alpha-clipped character shader
  at `Queue "AlphaTest"` (2450) with `ZWrite On` will depth-clip a ground decal or blob shadow
  queued at `Transparent-100` (2900), shearing it along the billboard plane. Put ground decals
  at `Geometry+1` so they draw *before* the sprite.
- **Measuring a texture's art needs an import round-trip.** `GetPixels32()` throws
  `UnityException` unless the importer has `isReadable = true` and uncompressed compression —
  set them and `SaveAndReimport()` before scanning. Worth it: sprite sheets carry transparent
  padding below the feet (25–29 px in one pack), and pivoting on the *cell* bottom instead of
  the *art* bottom makes every character hover by exactly that padding.

### Anti-patterns (look-dev)

- Claiming a visual fix without a fresh capture of the failing angle
- Reading `get_console_logs` for shader errors (it is silent) instead of `ShaderUtil`
- Tuning parameters when the defect is structural (mesh topology, wrong formula)
- Mass-swapping pack materials onto a custom shader — prefer additive full-screen passes and
  per-slot materials so the source art survives

## Tiered verification (cheapest first)

A clean Play Mode console is necessary, not sufficient — scale, binding, and visual bugs pass
it. Layer checks:

1. **Structural disk tests** (no Editor, milliseconds): a small script (e.g. Python regex over `.meta`/`.asset` text) asserting GUIDs resolve to existing files, PPU/pixel sizes, world-height budgets. Promote every visually-caught regression into one of these.
2. **Composition / contact audit** (live Editor Verify or eval): prop AABB non-overlap, pier posts meet deck, no mis-scaled sea stairs, ground modules not nested — write a short report under `Assets/Screenshots/` or project evidence path.
3. **Console**: `get_console_logs` shows no new errors after compile/refresh.
4. **Play Mode smoke**: `editor_play` → observe → `editor_stop` (when gameplay matters).
5. **Screenshot artifacts**: Game **and** relevant close Scene views at **stable repo paths** — not only session temp. Screenshots, not asset thumbnails, are the arbiter of visual claims.
6. **User visual review** for style/scale judgments; then commit with the evidence.

## Choosing the right tool

| Need | Prefer |
|------|--------|
| Is Editor up? | `status`, `pipeline list` |
| What can I do? | `command` / `list` (no name) |
| Stable repeated op | Named Pipeline command or `[CliCommand]` |
| One-off API question | `eval` |
| Agent-built vignette / kitbash layout | Workflow G: Build/Verify recipe + dual screenshots |
| Bulk art/audio swap or retarget | Disk-level YAML/GUID edit + refresh (Workflow F) |
| Clean test report on agent | `unity test` |
| Player binary | `unity build` + project `executeMethod` |
| Install tooling | `install` / `install-modules` |
| Auth broken | `auth status`, `doctor` |

## Evidence standards for agents

A claim that "it works" should cite at least one of (and for visual changes, climb the
**Tiered verification** ladder above — console-clean alone is not enough):
- Test command exit code `0` + results path
- Structural disk-test pass (script path + output)
- Composition/contact audit pass (Verify report / `composition-audit.txt` when present)
- `get_console_logs` without new errors after action
- Capture/screenshot artifact at a stable repo path (**Game + close Scene** for layout)
- Structured JSON from `editor_status` / component getters
- Eval return value that answers the hypothesis (especially `bounds` for scale/contact)

When checking a mapping (e.g. movement direction → sprite facing), confirm **every branch**
visually, not a representative one — "the values matched what I expected" is not verification
when the expectation is itself the hypothesis under test.

Review **incidental diffs** before committing — they are evidence, not noise. A stray one-line material diff after a play session turned out to be Unity stripping `_EMISSION`, i.e. a broken light, not churn. If a file changed and you cannot explain why, find out before you commit it.
## Failure playbook

| Symptom | Checks |
|---------|--------|
| `unity: command not found` | `~/.unity/bin` on PATH; source `~/.unity/env` |
| Command seems hung | Hub-backed calls (`editors`, first `install`) can take 25s+ cold — wait ~60s before killing; then `doctor` / `--verbose` |
| Disk-edited asset not visible in Editor | Force import: `import_asset` or eval `AssetDatabase.Refresh()`; check import errors in console |
| References broke after asset swap | A `.meta` was deleted/regenerated (GUID changed) — restore original `.meta` from git, keep GUIDs stable |
| Auth errors on pipeline install | `unity auth login` / CI credentials |
| Pipeline installed, not reachable | Domain reload, compile errors, Safe Mode, restart Editor |
| Command missing | Package version drift; run bare `unity command`; upgrade pipeline |
| Timeout | Raise `--timeout`; poll async `*_status`; avoid huge eval |
| Wrong project | Pass `--project-path`; verify with `status` |
| Module install fails | Editor must be Hub/CLI managed; try `--accept-eula`, `--cm` |
| Build fails | Need real `--execute-method`; read log under `Logs/` |
| Pipeline blocked / hangs on UI | Open Editor with `-automated`; dismiss or avoid modal dialogs |
| Layout “looks fine” then user zooms and finds clips | Run composition audit; recapture close Scene of the junction |
| Domain reload mid-command | Poll `recompile_status`; retry command after idle |
| Shader "works" but renders magenta/black | Console is silent on shaders — `ShaderUtil.GetShaderMessages()`; `Shader.Find() != null` proves nothing |
| `capture_game_view` 400 Bad Request | `save_path` must be **inside the project root**; write to `Assets/…` then copy out |
| Scene build throws "cannot be used during play mode" | Poll `EditorApplication.isPlaying`; `editor_stop` may not land — batch scene edits, keep iterating on material/shader assets which apply live |
| Emissive material stops glowing after a play session | Unity stripped `_EMISSION` because `globalIlluminationFlags` was `EmissiveIsBlack` — set `RealtimeEmissive` where the material is authored |
| Ground decal / blob shadow clipped along one edge | It is queued after a depth-writing sprite; move the decal to `Geometry+1` |
| `GetPixels32()` throws `UnityException` | Importer needs `isReadable = true` + uncompressed, then `SaveAndReimport()` |
| Cropped screenshot lands on the wrong subject | `WorldToScreenPoint` is in Game-view pixels, not capture pixels — normalize by `Screen.width/height` first, and flip Y for image space |
| Play mode opens with locked camera / immobile player | Check for components left disabled in the saved scene by a test harness (e.g. `PlayerController.enabled = false`) — restore them, and restore inside the same eval call next time |
| Recompile poll never finishes | `recompile_status` returns `"completed"`, not `"idle"` |
| Vertex displacement invisible | Mesh topology, not shader math — a scaled `Plane` primitive has metre-scale quads |
| `git status` shows a modified asset but `git diff` is empty | Unity's `SaveAssets()` touches mtimes; the stat cache is stale. `git diff --numstat` to confirm, then `git update-index --refresh` |
| Files flip between modified and clean underneath you | Another agent session shares this working tree (e.g. a fork). Inspect every diff before `git add -A`, or isolate sessions in separate git worktrees |

## Security & safety

- Pipeline is **localhost**; still treat eval as full Editor trust
- Don't enable runtime Pipeline in shipping Players
- Don't log keystore passwords or tokens
- Prefer dry-run/confirm for deletes, settings, package removal
- Don't uninstall Editors or wipe modules without explicit user request

## Composing with other skills

- **Game content / assets**: generate art elsewhere, then import via `import_asset` / project folders
- **Code edit skills**: change C# on disk, then use CLI to compile/test/play
- Keep this skill focused on **Unity execution surface**, not general C# style
