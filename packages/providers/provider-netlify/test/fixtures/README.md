# Offline fixtures — `@hobo/provider-netlify`

Sanitized captures of the shapes this package parses. Every test in this package
runs offline against these files; nothing here reaches Netlify.

Every identifier and token is **obviously fake** — prefixed `FAKE-`, and no
string is a syntactically valid Netlify credential. If a real capture is ever
added, sanitize it before committing: an anonymous claim URL is bearer authority
over a live site for one hour.

| Fixture | Shape it stands in for |
| --- | --- |
| `deploy.anonymous-success.json` | `netlify deploy --allow-anonymous --json` on success, including the `claim_url` |
| `deploy.no-claim-action.json` | the same command with no claim action — a site nobody could take ownership of, so parsing fails `CLAIM_NOT_VERIFIED` |
| `site.after-claim.json` | `GET /api/v1/sites/{site_id}` after a human claimed it, carrying the `account_id` that is the ownership fact |
