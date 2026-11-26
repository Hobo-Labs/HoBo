---
type: Agent Skill Reference
title: "Search and retrieval"
description: "Use local hybrid retrieval and OKF progressive disclosure before broad reads or cloud indexes."
tags: [hobo, repo, search, retrieval, okf]
timestamp: 2026-06-30T00:00:00Z
---

# Search And Retrieval

Use the cheapest operation that can answer the question. Do not read whole directories, run broad tests, or ask a semantic retriever until exact and structural search have narrowed the candidate set.

## Retrieval Order

1. Read the nearest `index.md` to understand an OKF bundle before opening concept files.
2. Use `tgrep` when available for indexed exact search.
3. Use `rg` for text search and `rg --files` for file discovery.
4. Use `fd` when filename matching is enough.
5. Use `ast-grep` for syntax-aware JavaScript/TypeScript search or refactor candidates.
6. Use `git grep` when you need tracked-file-only search.
7. Use memory or semantic tools only when exact search fails, prior context matters, or the query is conceptual.

## OKF Reading Rules

- Treat OKF as markdown files with YAML frontmatter in git.
- Use `type`, `title`, `description`, `tags`, and links to choose what to read.
- Preserve unknown OKF frontmatter fields.
- Prefer bundle-relative links in new OKF concept docs.
- Do not use Google ingestion, catalog, or query products by default.

## Optional Retrieval Backends

Local hybrid retrieval is the default: OKF index files plus `tgrep`, `rg`, `fd`, `ast-grep`, and memory when relevant. LlamaIndex Index v2 may be used only when explicitly configured or requested; it is a beta cloud service. LlamaCloud self-hosting is heavier because it runs on Kubernetes with Helm and is Enterprise-plan oriented.

# Citations

[1] [Open Knowledge Format v0.1 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
[2] [LlamaIndex Index v2 retrieval](https://developers.llamaindex.ai/llamaparse/cloud-index-v2/retrieval/)
[3] [LlamaIndex Retrieval Harness announcement](https://www.llamaindex.ai/blog/announcing-retrieval-harness)
[4] [LlamaIndex self-hosting documentation](https://developers.llamaindex.ai/llamaparse/self_hosting/)
