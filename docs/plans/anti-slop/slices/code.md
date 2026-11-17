---
type: Plan
title: "anti-slop slice: @hobo/code"
description: "File-complete anti-slop cleanup for packages/code."
tags: [hobo, anti-slop, oxlint, code]
---

# code slice

> Historical slice: `packages/code` has been removed. The check results below
> describe the former package and are not current validation instructions.

Layer `sdlc/anti-slop-28-code`.

`pnpm exec oxlint -c oxlint.config.ts --deny-warnings --no-error-on-unmatched-pattern packages/code` is clean. `@hobo/code` `tsc --noEmit` is clean.

Local `src/json.ts` (`JsonValue` / `JsonObject` / `isJson*` / `parseJson*` / `cloneAsJson`) is the parse boundary. Empty-object spreads use `undefined`. Remaining `as` assertions carry a `SAFETY:` comment on the containing statement. Control sequences in `ansi.ts` / `rubberhose.ts` are built with `String.fromCharCode`, not regex literals. `vi.mock` of the CLI runner is injection (`installHarnessCliRunner`).
