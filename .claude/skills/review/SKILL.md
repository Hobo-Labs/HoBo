---
name: review
description: Review changes for correctness, requirements, regressions, and repository standards.
---

Follow `AGENTS.md`. Compare the changes with the user-specified base, or infer
the appropriate base from the current branch and repository context. Assess
the changed behavior against the user's request, relevant existing contracts,
repository rules, and the affected tests.

Report actionable findings in order of impact with precise file and line
references. State any material gaps in verification. If there are no findings,
say so and identify remaining risks. Do not create planning or design files.
