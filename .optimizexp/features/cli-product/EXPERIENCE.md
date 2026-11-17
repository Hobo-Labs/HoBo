# EXPERIENCE: cli-product

- entryCommand: `hobo --help`
- driver: cli
- intent: # Feature seed  A developer or agent runs the real product CLI (`hobo` from `@hobo/cli`) and gets discoverable help, honest JSON

## Rubber-duck (explain to a new teammate)

1. Who is the persona and what are they trying to finish in the next 2 minutes?
   - The product app developer must discover the canonical `hobo` lifecycle verbs and their machine-readable contract without reading source.
2. What exact command / UI path do they take from a clean machine?
   - Build the owning package, then invoke its actual package bin launcher with `hobo --help`; follow with one verb help command and one `--json` failure command.
3. What do they see first? (quote expected chrome, not vibes)
   - `hobo --help` visibly names `Start here:` before `Canonical verbs:`.
4. What would make them think they opened the wrong product?
   - Third-party branding, a generic monorepo script help page, or help that omits the documented canonical verbs.
5. Happy path: step-by-step (Given/When/Then in prose first).
   - Given the package bin is built, when the persona invokes the real binary help and a documented subcommand, then it exits zero and prints the concrete verbs/flags; when `--json` is requested, stdout is a stable JSON envelope.
6. Failure path: how do they break it, what must the product say?
   - An unknown verb or flag must exit non-zero and return a stable machine code plus a non-empty remediation array; no stack trace, silent acceptance, or mutation is permitted.
7. What evidence will prove a human/agent actually ran this? (driver + command)
   - The CLI driver records the complete real launcher invocation as `primary.cast`, preserves `terminal.txt`, command, screen size, exit code, and hashes in `meta.json`, and an independent review verifies every named output claim.
8. What is deliberately out of scope for this feature folder?
   - Rich bare-TTY chat interaction, deployment side effects, live provider calls, auth credentials, and GUI/mobile surfaces; those require their own scoped features and evidence.

## Adversarial critique (must check all)

- [x] Did not skip default entry because a secondary verb is easier to automate
- [x] Not testing a monorepo script instead of the product binary
- [x] No When-step is only “exercise the surface” without a real command
- [x] Scores cannot be invented without reading stdout/TUI
- [x] Persona vocabulary/asserts considered for shared paths
- [x] Security: secrets, destructive promote, network—fail-closed
- [x] Cognitive load: journey stays within persona thresholds
- [x] Confusion twin: stock UI / wrong binary / wrong verb—covered
- [x] If this feature were the only one we ship, the persona would not still be lost

## Verdict

- accept
- primaryCommand: `hobo --help`
- driver: cli
- scenarios: help discoverability, verb-specific help, a stable JSON envelope, and actionable unknown verb/flag recovery for the product binary
