---
name: draft
description: Implement and verify behavior in existing HoBo draft proof packages and their owning implementations.
---

# Draft

Follow `AGENTS.md`. Inspect the existing implementation, contracts, and tests. Complete the requested behavior in the package that owns it, and update affected consumers and executable checks. Do not create planning documents, ADRs, placeholder proofs, or synthetic evidence.

Draft packages are grouped under `src/draft/technical-proofs/`, `src/draft/exp-proofs/<type>/`, `src/draft/epic-proofs/`, and `src/draft/projects/`. Use `git mv` for tracked moves. Keep boundary fixtures deterministic and avoid live external services in default tests.

A proof manifest records its layer and actual dependencies. Run its examples and package tests; use the artifact and cascade gates for affected packages. A reason in `proof.json` may identify an inapplicable requirement, but must not defer unfinished behavior.

Use the relevant reference for [technical proofs](references/technical-proofs/process.md), [experience proofs](references/exp-proofs/process.md), [epic proofs](references/epic-proofs/process.md), or [projects](references/projects/process.md).
