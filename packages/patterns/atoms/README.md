# Atomic snippets

Git-backed snippet atoms. Each folder is one concept:

- `meta.json` — id, tier, tags, queries, `requires` / `provides`, params
- `body/` — literal `{{param}}` files
- `acceptance.json` — deterministic fill fixture

The catalog loader treats these as first-class patterns: `searchPatterns`
finds them and `renderPattern` fills them with zero LLM calls, like the rest
of the catalog. Applying Yard patterns to the same file merges literal network
and Camp entries, preserves a single provider, and rejects conflicting or dynamic
Yard definitions.

The `http.api.trainable` pattern serves a greeting through Hono and registers a
working trainable baseline; it does not require a generated model to respond.
