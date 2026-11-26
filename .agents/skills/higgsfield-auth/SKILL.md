---
name: higgsfield-auth
description: Authenticate or re-authenticate the Higgsfield MCP server, and refresh its access token when generation starts failing with 401. Use when Higgsfield tools are missing, when `claude mcp list` shows higgsfield as "Needs authentication" or "Failed to connect", when an image/video generation call returns 401 or "unauthorized", when the user says the Higgsfield token expired, or when setting Higgsfield up for the first time. Also use before a long art-generation session, since the access token lasts only one hour.
---

# Higgsfield MCP auth

Higgsfield's access token lasts **one hour**. This skill mints and rotates it.

## Commands

```sh
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs ensure    # default: refresh if due, then keep it fresh
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs status    # token + daemon state
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs start     # background refresher
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs stop      # stop it
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs refresh   # force one rotation
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs login     # device flow (needs the user)
```

**Reach for `ensure`.** It refreshes if the token is due, then starts the
background refresher if it is not already running — so one call leaves the
session self-sustaining. `status` exits `0` healthy, `2` refresh due, `1` no
token.

## The background refresher

`start` spawns a detached loop that wakes shortly before expiry (5-minute skew),
refreshes, rewrites `~/.claude.json`, and verifies with a real `initialize`
call. It logs to `~/.higgsfield/daemon.log` and prints nothing — refreshing is
supposed to be invisible.

Because refresh tokens roll their own 7-day window on every use, a daemon that
keeps running makes a single `login` effectively permanent.

**Single-instance, enforced with an O_EXCL lock.** This is not tidiness: refresh
tokens rotate, so two loops would each consume the other's freshly minted token
and the second refresh of the pair would 401 — breaking the chain and forcing an
interactive login. `start` refuses when a live holder exists, and takes over only
a lock whose holder is gone.

The lock stores a **uid, not just a pid**, and the daemon **heartbeats** it every
iteration. A pid alone is not identity: pids get recycled, so a dead daemon's pid
can reappear as an unrelated process and `kill(pid, 0)` would report the lock
live forever — wedging `start` until someone ran `stop` by hand. `EPERM` (holder
owned by another user) had the same effect. A lock whose mtime has not advanced
in 45 minutes is therefore treated as abandoned regardless of what its pid says,
which is safe because a live holder never sleeps longer than 15 minutes.

Takeover is also confirmed rather than assumed: two starters recovering from the
same abandoned lock can both see it unheld and both delete it, the second
erasing the first's valid lock. After taking over, each re-reads and checks its
own uid survived. Last writer wins, the other backs off, exactly one runs.

Sleeps are capped at 15 minutes, so a suspended laptop wakes to a fresh check
rather than oversleeping past expiry.

It exits — rather than spinning — when the refresh token is dead or missing,
because no amount of retrying fixes that. Transient failures (network, 5xx) back
off 60s and retry. Check `~/.higgsfield/daemon.log` and `status` if generation
starts 401ing.

## Which command to run

| Symptom | Command |
|---|---|
| First-time setup, or no token stored | `login` |
| 401 / "unauthorized" from a generation call | `refresh` |
| About to generate a batch of assets | `ensure` |
| `claude mcp list` shows *Needs authentication* | `login` |
| Refresh itself is rejected | `login` (the refresh token expired too) |

After `login` or a `refresh` that changed the header, **Claude Code must be
restarted** for the MCP tools to pick up the new credential.

## Why the normal OAuth flow does not work

Higgsfield advertises two flows in
`https://mcp.higgsfield.ai/.well-known/oauth-protected-resource`, chosen
`client_capability_based`:

- **`authorization_code_pkce`** — for clients that *can* receive a redirect.
  `claude-code` is in their `potential_clients`, so Claude Code picks it.
- **`device_code`** — for clients that *cannot*, served by
  `fnf-device-auth.higgsfield.ai`.

The PKCE path needs `http://localhost:<port>/callback` pre-registered with
Higgsfield's Clerk tenant, and it is not. Both `clerk.higgsfield.ai` and
Higgsfield's own `/oauth2/authorize` proxy therefore reject it:

> `invalid_request` — *"The 'redirect_uri' parameter does not match any of the
> OAuth 2.0 Client's pre-registered redirect urls."*

Running `/mcp` in Claude Code will reproduce that error, not fix it. This skill
uses the device flow instead and installs the result as a plain
`Authorization: Bearer` header, which bypasses the handshake entirely.

The device endpoints are **not discoverable** — `fnf-device-auth.higgsfield.ai`
serves no `.well-known/oauth-authorization-server`. They are only in its
OpenAPI document: `POST /authorize` (no body) → `{device_code,
verification_uri, expires_in, interval}`, then `POST /token {device_code}`,
and `POST /refresh {refresh_token}`.

## The rotation hazard

**Every refresh returns a new `refresh_token` and invalidates the old one.**
Lose the new one and the only recovery is a full `login` with user interaction.

The script therefore writes `~/.higgsfield/token.json` **atomically** (temp file
+ rename, mode `0600`) and persists *before* wiring the header, so a crash costs
a rerun rather than a re-login. Do not hand-edit that file, and do not call
`/refresh` with curl during a session — that silently consumes the stored token
and the next `ensure` will fail.

The new token is **merged over** the stored one, never substituted for it. A
`/refresh` response that omits `refresh_token` — the ordinary shape for a server
that is *not* rotating — would otherwise delete the stored one, and the next
daemon tick would exit `no refresh token — login required`. Keeping the old value
when the server sends none is correct whether or not rotation is happening.

Rename is atomic against process death, which is the realistic failure. It is not
atomic against power loss: without an `fsync` the file can still come back empty
after a hard cut. That residual is accepted — the cost is one `login`.

## Where the credential lives

| Path | Contents |
|---|---|
| `~/.higgsfield/token.json` | access + refresh token, `0600`, outside any repo |
| `~/.claude.json` | `mcpServers.higgsfield.headers.Authorization` (user scope) |

**Never in `.mcp.json`.** That file is committed; the project entry there stays
OAuth-based for teammates. A bearer token in it would be a published credential.

## Verification

Both `login` and `refresh` finish by calling `initialize` against
`https://mcp.higgsfield.ai/mcp` with the new token and printing the HTTP status.
**200 means it genuinely works** — a token that parses but does not
authenticate is caught here rather than at the first generation call. Anything
else is a real failure; report the status rather than assuming success.
