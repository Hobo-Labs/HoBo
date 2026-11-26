# Patterns & Standards Cross-Link Guard

Executable POC for [HOBO-698](https://linear.app/quickdeploy-ai/issue/HOBO-698): REM-031 (GAP-023).

HoBo consolidated `event-model.md` into `data-plane.md` and renamed
`forge-generated-stack.md` to `generated-stack.md`. The patterns and standards
research notes still pointed at the removed paths.

This package pins the remediation:

- `docs/patterns/*.md` and `docs/standards/*.md` must not reference removed design
  filenames;
- every local relative `.md` link under those trees must resolve;
- `#plan-11` and `#plan-23` anchors must still exist on the remapped targets.

Run:

```bash
pnpm --prefix src/draft/technical-proofs/patterns-standards-cross-links test
```
