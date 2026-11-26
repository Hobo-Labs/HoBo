# CI performance findings

A new finding is a new file `docs/ci/findings/NNNN-slug.md`. Pick the next free number, check open PRs for claims on that number, and use a lowercase ASCII kebab-case slug derived from the title. The file's level-one heading is `# Finding N: title`, with OKF frontmatter like the existing findings.

Do not edit `docs/ci/performance.md` for a new finding. Its finding list is generated between `findings-index` markers, so adding a finding does not append to a shared document.

Whoever next updates `docs/ci/performance.md`, or the docs maintainer, regenerates the index with:

```sh
pnpm run docs:findings
```

Validate finding files and existing index links with `pnpm run docs:findings -- --check`. A new finding that is not indexed yet produces a notice, not a failure.
