# Security policy

HoBo is not a shipped product yet, but this repository contains security-relevant design material, executable draft contracts, agent tooling, CI workflows, and dependency manifests. Treat vulnerabilities in those surfaces seriously.

## Supported versions

Only the default branch and active pull requests are supported. Archived requirements and historical planning material are retained for context and are not supported runtime artifacts.

## What to report

Please report:

- Secrets, tokens, credentials, or private keys committed to the repo.
- CI workflow changes that could exfiltrate secrets or run untrusted code unsafely.
- Agent-tooling configuration that causes unexpected data egress or unsafe command execution.
- Draft contract code that contradicts documented deny-by-default, secretless, tenant-isolation, provenance, or no-egress claims.
- Dependency or script behavior that materially changes the trust boundary documented in `docs/agent-tooling.md`.

## How to report (public repository)

Prefer **private** disclosure. Do not open a public GitHub issue for an active vulnerability if a private channel exists.

1. **GitHub private vulnerability reporting** (preferred when enabled on this repo): use the repository **Security** tab → **Report a vulnerability** (or `https://github.com/<owner>/<repo>/security/advisories/new` for the canonical remote). This keeps the report confidential until maintainers publish or dismiss it.
2. **If private reporting is unavailable:** contact the repository owner / maintainers through the GitHub account that owns the repo (or the contact listed in the GitHub org profile) **before** filing a public issue. Ask for a secure channel; do not paste exploit details into public issues, discussions, or PRs.
3. **Public issues** are only for already-fixed, non-exploitable hygiene (for example docs that misstate a deny-by-default rule) after maintainers agree the issue is safe to discuss openly.

Do not include live secrets, exploitable credentials, private tenant data, or full exploit chains in public issues, pull requests, commit messages, logs, or screenshots. Redact tokens and rotate anything that may have leaked.

This policy does **not** publish maintainer email addresses or API tokens. Residual ship/security process blockers that require humans (counsel, production OIDC, staffed support) are tracked in [`docs/design/instances/residual-human-blockers-2026-07-30.md`](./docs/design/instances/residual-human-blockers-2026-07-30.md) — that ledger is not a vulnerability inbox.

## Disclosure expectations

Maintainers should acknowledge security reports, confirm the affected repo surface, and fix or document the issue before public disclosure. Security fixes should include a regression test, docs update, or explicit explanation when neither applies.
