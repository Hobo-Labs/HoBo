# Atomic snippets

Git-backed snippet atoms. Each folder is one concept:

- `meta.json` — id, tier, tags, queries, `requires` / `provides`, params
- `body/` — literal `{{param}}` files
- `acceptance.json` — deterministic fill fixture

The catalog loader treats these as first-class patterns: `searchPatterns`
finds them and `renderPattern` fills them with zero LLM calls, like the rest
of the catalog. Same-path snippets merge by `@hobo.entity` / `@hobo.slot` /
`@hobo.hole`.
