---
name: design-md
description: Apply the implemented visual tokens and verify rendered UI contrast without creating design documents.
---

# Visual quality

Use the owning surface's CSS tokens and shared components. Run `pnpm run
design:lint` and the affected package's rendered-surface tests after UI changes.
The common repository rules prohibit creating design documents, even when a
plugin suggests them.
