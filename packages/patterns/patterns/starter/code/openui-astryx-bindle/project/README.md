# openui-astryx-bindle

OpenUI catalog template — first paint under `public/`.

```text
  1·generate → 2·edit → 3·lock → evidence
  ● done · ▸ current · ○ todo
```

| Layer | What you get |
|---|---|
| Visual | Dark shell + step rail (`public/index.html` + `styles.css`) |
| Flags | Example Gherkin names OpenFeature `app.visual.primary` |
| Evidence | Illustrative scenario; no capture runner is included |
| Platform | FinOps / Harness / Station integration is supplied by the caller |

## Use the template

The catalog's `renderPattern` returns one file for this starter: the default
snippet, or `src/bindle.ts` when the `project` rendering is selected. It does
not render the whole project tree. To obtain that tree, copy the files at
`openUiStarterRoot()` from `@hobo/patterns` into your destination, for example:

```ts
import { cpSync } from "node:fs";
import { openUiStarterRoot } from "@hobo/patterns";

cpSync(openUiStarterRoot(), "./my-app", { recursive: true, force: false, errorOnExist: true });
```

The files are template inputs, not a standalone application. The edit, lock,
and evidence steps need a caller-provided host.

## Tokens

Palette lives in `public/styles.css` so OpenUI lock-ins match the scaffold:

- `--bg` / `--panel` / `--line`
- `--text` / `--muted`
- `--accent` / `--ok`
