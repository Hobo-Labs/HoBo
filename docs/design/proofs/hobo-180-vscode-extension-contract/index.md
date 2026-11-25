# HOBO-180 VS Code Extension Contract Proof

This proof records the branch-local contract for the optional VS Code extension
slice in Plan 07.

## Acceptance Mapping

| Acceptance | Branch proof |
|---|---|
| Opening a HoBo project shows topology. | `openWorkspace()` renders a windowed `TopologyView` from the existing inspect projection fixture. |
| Selecting a run shows step trace. | `selectRun("run-264")` renders `RunView` steps, timeline, actors, and sagas from the run-inspector projection. |
| "Explain this plan" surfaces the `hobo plan` diff in-editor. | `explainThisPlan({ camp: "prod" })` converts plan preview resources and warnings into inline annotations. |
| Provider-option autocomplete works on `.with(aws...)`. | `completeProviderOptions()` returns completions from `@hobo/aws/provider-options.d.ts`. |
| Extension drives the same handlers as CLI/MCP. | `assertSharedExtensionHandlers()` checks every VS Code command against canonical CLI verbs and MCP tool specs. |
| Graceful no-dev/no-Camp behavior. | Unreachable local dev/Camp returns a `hobo.dev` start prompt, not a stack/error dump. |

## Adversarial Mapping

| Edge case | Branch proof |
|---|---|
| No running `hobo dev` is actionable. | The no-dev test asserts the prompt command is `hobo.dev` and contains no stack/error spew. |
| Large topology does not freeze the editor. | `largeTopologyEvents(1500)` renders only the requested viewport while preserving total counts. |
| Extension never embeds credentials. | Static credential material in the extension manifest throws; normal mode references the CLI SVID store. |
| Out-of-date extension vs CLI surface warns. | Surface-version mismatch returns `surface-warning` with no topology render. |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\vscode-extension-contract test
```
