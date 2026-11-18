# `@hobo/swe-shared`

The shared SWE runner is used by the Claude, Codex, Copilot, Cursor, Gemini,
and Grok adapters. Every task receives the repository's self-documenting code
rules before the agent starts.

The task workspace must be a Git repository with an initial commit. Before a
task can report completion, the runner checks both the working tree and commits
created during the task with the common source policy. It reports an error when
the policy cannot run or detects prohibited comments or planning artifacts.
