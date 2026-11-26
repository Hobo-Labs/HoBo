# HoBo draft proof packages

`src/draft/` contains executable proof and contract material. Implement requested behavior in its owning package and keep the affected proofs and tests aligned. Do not add planning documents, ADRs, placeholder proofs, or synthetic evidence.

## Taxonomy

- `technical-proofs/<slug>` contains isolated technical behavior and contract checks.
- `exp-proofs/<type>/<slug>` checks developer (`dx`), user (`ux`), customer (`cx`), agent (`ax`), or API (`api`) experiences.
- `epic-proofs/<slug>` integrates technical and experience behavior through executable features.
- `projects/<slug>` integrates project-level behavior and its dependencies.

Run `pnpm run draft:experiences` to list the current experience proofs, or add `--type ux` to select one audience. Use `pnpm --silent run draft:experiences --json` for machine-readable output.

## Validation

Each proof manifest identifies its layer and actual references. The artifact gate (`pnpm run draft:artifacts`) runs examples against committed output and checks the required evidence; the cascade gate (`pnpm run draft:cascade`) identifies affected dependent packages. Both read `_grandfathered.json` and report its packages as advisory only. Run the narrow package tests first, then `pnpm run agent:check -- --staged` for the changed scope. Record a reason only when a requirement does not apply; do not waive unfinished behavior.

Use `git mv` for tracked moves. Keep operator and user documentation tied to behavior that exists, and capture visual evidence from the running interface when needed.
