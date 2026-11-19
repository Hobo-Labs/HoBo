---
name: draft
description: Complete and retire existing HoBo draft proofs through their owning implementations.
---

# Draft

Follow `AGENTS.md`. Inspect the existing implementation, contracts, and tests. Complete the behavior in the package that owns it, update affected consumers and executable checks, and remove obsolete proofs and their references. Do not create planning documents, ADRs, duplicate proofs, or synthetic evidence.

Existing draft packages are grouped under `src/draft/technical-proofs/`, `src/draft/exp-proofs/<type>/`, `src/draft/epic-proofs/`, and `src/draft/projects/`. Preserve meaningful behavior in its owning package before deleting its only implementation. Keep default tests independent of live external services.

Update dependent imports, workspace entries, and promotion-ledger references as proofs are retired. Run production tests and the applicable staged artifact and cascade gates. Never waive unfinished behavior.

Use the relevant reference for [technical proofs](references/technical-proofs/process.md), [experience proofs](references/exp-proofs/process.md), [epic proofs](references/epic-proofs/process.md), or [projects](references/projects/process.md).
