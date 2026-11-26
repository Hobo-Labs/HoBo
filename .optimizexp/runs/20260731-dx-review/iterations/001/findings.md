### F-1: Shared DX entrypoints require node_modules/tsx before any gate list
- Metrics (judged): friction=4, uncertainty=2–3
- Personas: product-app-developer, product-platform-engineer
- Evidence: narrow-local-validation + cli-help-and-doctor transcripts
- Smallest reduction: Make `doctor` and `agent:check --help` work (or print install-only remediation) without full tsx graph; document `pnpm install` as step 0 in AGENTS/README DX ladder
- Effort: M

### F-2: Evidence harness exit codes can read 0 while body fails
- Metrics: uncertainty+1
- Evidence: capture meta exitCode 0 with ELIFECYCLE 1 in transcript (shell pipelines)
- Smallest reduction: captureCli should not use pipelines that mask status; or use `pipefail`
- Effort: S
