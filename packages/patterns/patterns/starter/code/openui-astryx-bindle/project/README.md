# openui-astryx-bindle

OpenUI catalog template — first paint under `public/`.

```text
  1·generate → 2·edit → 3·lock → evidence
  ● done · ▸ current · ○ todo
```

| Layer | What you get |
|---|---|
| Visual | Dark shell + step rail (`public/index.html` + `styles.css`) |
| Flags | Gherkin linked to OpenFeature `app.visual.primary` |
| Evidence | Playwright + recording + screenshots on pass |
| Platform | FinOps / Harness / Station — no parallel control plane |

## Use the template

Load and render `starter.code.openui-astryx-bindle` through the
`@hobo/patterns` catalog API. The files here are template inputs and are not
a standalone `hobo-code` application.

## Tokens

Palette lives in `public/styles.css` so OpenUI lock-ins match the scaffold:

- `--bg` / `--panel` / `--line`
- `--text` / `--muted`
- `--accent` / `--ok`
