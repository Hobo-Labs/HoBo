---
type: Competitive Reference
title: "shoo.dev — Competitor Reference"
description: "Zero-config Google sign-in broker: origin-derived client_id, mandatory PKCE, and a standards-only ES256/JWKS contract that makes the dependency cheap to leave. Self-described as pre-release."
tags: [hobo, competitors]
competitor:
  slug: shoo
  name: "shoo.dev"
  primary_category: identity-networking-delivery
  categories: [identity-networking-delivery]
  directness: complementary
  role: "zero-config Google sign-in auth broker (PKCE + ES256/JWKS) — identity integration target"
  posture: [integrate, provider-target]
  hobo_surface: [identity-secrets]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://shoo.dev
---

# shoo.dev — Competitor Reference

> Competitive-research notes captured for HoBo (research as of 2026, from `docs.shoo.dev` / `shoo.dev`). The HoBo↔shoo parity tracker lives in the [Primitive mapping](#primitive-mapping) section below.

**shoo.dev** is a **minimal auth broker for Google sign-in** — *"AUTH IN 2LOC"* (auth in two lines of code). It strips the usual Google-OAuth friction (dashboard registration, client config, client-side secret handling) by **auto-deriving the OAuth `client_id` from your app's origin** and enforcing **PKCE (S256) on every flow**. It hands your app a standards-based, **ES256-signed JWT** that any backend can verify with plain JWKS — no proprietary server-side SDK.

- **Category:** zero-config OAuth2 / Google-Sign-In broker — an alternative to standing up your own Google OAuth client, or to Auth0/Clerk/Firebase Auth for the narrow "just let users sign in with Google" case.
- **Status (per the docs):** "SUPER EARLY WIP — USE AT YOUR OWN RISK" (repeated throughout).
- **Model:** **free forever, no sign-up required**; open source ("GitHub coming soon"); SaaS-hosted at `https://shoo.dev` (no self-host documented). Support: `support@ping.gg`.

The three-party shape is: your app runs `@shoojs/auth` (vanilla) or `@shoojs/react`, starts sign-in, and receives a signed `id_token`; **shoo** is the OAuth intermediary to Google, deriving a privacy-preserving identifier and signing the token; **Google** is the underlying IdP; and **your server** must verify the token before trusting it (the browser is untrusted).

```
Your App (browser)  ──@shoojs/auth | @shoojs/react──►  shoo.dev service  ──OAuth──►  Google
   ▲  signed id_token (ES256 JWT)                         │  derives pairwise_sub,
   └─────────────────────────────────────────────────────┘  signs id_token

Your server  ──verify(id_token) against shoo's JWKS──►  trust the pairwise_sub
```

| Dimension | shoo.dev |
|---|---|
| Category | Zero-config Google-sign-in auth broker |
| Auth flow | OAuth 2.0 + **PKCE (S256 mandatory)** |
| Token | **ES256** JWT (`id_token`), verified via JWKS |
| Identity | **domain-scoped `pairwise_sub`** (no cross-site tracking) |
| Config | **auto-registered** `client_id` from origin; no dashboard |
| SDKs | `@shoojs/auth` (vanilla), `@shoojs/react`, `<script src="https://shoo.dev/shoo.js">` |
| Backends | standards-based (any JWKS verifier); **Convex** integration first-class |
| Pricing / hosting | Free; SaaS-only; OSS pending |
| Maturity | "super early WIP" |

## What it is

shoo.dev is a **minimal auth broker for Google sign-in** — "AUTH IN 2LOC". It removes OAuth setup
friction by auto-deriving the `client_id` from the calling origin and mandating PKCE (S256), then
hands the application a standards-based ES256 JWT any backend can verify with plain JWKS.

- **Product boundary.** End-user sign-in via one identity provider. No user store, no RBAC, no
  organizations, no MFA management.
- **Operating model.** Free, SaaS-only, no self-host documented; open source pending. The
  documentation states **"SUPER EARLY WIP — USE AT YOUR OWN RISK"**, and this capture treats every
  claim accordingly.
- **The differentiator is the removal of configuration**, not the auth itself — the same shape of
  argument [Tailscale](tailscale.md) makes about networking.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Origin-derived `client_id`** | The first request from a new origin auto-registers the client; there is no dashboard |
| **PKCE (S256)** | Mandatory on every flow, with no "plain" fallback |
| **`id_token`** | An ES256-signed JWT, verified through standard JWKS |
| **`pairwise_sub`** | A domain-scoped subject identifier: stable within an app, uncorrelatable across apps |
| **Server verification** | Required, because "the browser is an untrusted environment" |
| **SDKs** | `@shoojs/auth`, `@shoojs/react`, or a plain script tag |

The mental model is **a broker that issues a standard token and then gets out of the way**. Nothing
proprietary is required on the server, which is the property that makes it interesting despite its
maturity.

## Feature surface

### Mechanism — the seven-step flow

The browser auth flow yields a signed `id_token` (ES256 JWT) with shoo sitting as the OAuth intermediary between your app and Google. Because *"the browser auth flow gives the user a signed `id_token`, but the browser is an untrusted environment"*, production apps must verify server-side (see [server verification](#server-verification-required-for-production)). End to end:

1. **Client initiates** — your app calls `startSignIn()`, generating a PKCE bundle: a 64-char random **`code_verifier`** kept in `sessionStorage`, and its SHA-256 **`code_challenge`** sent on the redirect to shoo's `/authorize`.
2. **shoo → Google** — using the **auto-derived `client_id`** (from your origin), shoo requests authentication from Google.
3. **User authenticates** — Google verifies credentials and redirects back to shoo with an authorization code.
4. **shoo derives identity** — exchanges Google's code for identity data and computes a **domain-scoped, stable user identifier** (`pairwise_sub`).
5. **Token signing** — shoo signs the `id_token` with **ES256** and returns it (with an authorization code) to the client.
6. **Client verifies & stores** — the app verifies the token signature against shoo's public keys (`/.well-known/jwks.json`) and stores identity locally.
7. **Session management** — apps should periodically validate via `POST /session/check`, which reports active status or revocation/expiry.

**Auto-registration (zero config).** The `client_id` is derived from the app origin — `"origin:" + new URL(redirect_uri).origin` — and *"first `/authorize` request from a new origin auto-registers the client"*, with no dashboard step.

**PKCE (mandatory S256).** *"Shoo enforces S256 (SHA-256) challenges on every flow. There is no 'plain' challenge option."* PKCE prevents authorization-code interception, critical for browser-based apps; its parts are the random verifier, its SHA-256 challenge, and verification at token exchange.

**Domain-scoped `pairwise_sub`.** A privacy-preserving, per-origin stable identifier, `pairwise_sub = HMAC-SHA256(server_secret, google_sub + client_id)`. The format begins with `ps_` followed by base64url. The same user gets a consistent ID **per origin** but **different IDs across apps** — stable for a given app, no cross-site tracking.

**Token structure (ES256).** Algorithm is **ES256** (ECDSA P-256). Required claims: `iss` (`https://shoo.dev`), `aud` (`origin:{your_app_origin}`), `sub`/`pairwise_sub`, expiration, and a unique JWT ID. Optional **PII** claims — `email`, `name`, `picture` — appear only when the user grants per-origin consent (`startSignIn({ requestPii: true })`).

**Endpoints.**
- `https://shoo.dev/authorize` — start the OAuth flow (PKCE/state auto-applied by the SDK).
- `https://shoo.dev/.well-known/jwks.json` — ES256 public keys (auto key rotation).
- `https://shoo.dev/.well-known/openid-configuration` — OIDC discovery metadata.
- `POST https://shoo.dev/session/check` — session validity / revocation check.
- `https://shoo.dev/me` — user dashboard (sign out / delete account data).

### SDKs & API surface

Three client packages: **`@shoojs/auth`** (framework-agnostic vanilla JS), **`@shoojs/react`** (React hook + the Convex integration), and a **script tag** — `<script src="https://shoo.dev/shoo.js"></script>` — for no-bundler use.

```bash
bun add @shoojs/react   # or: npm install @shoojs/react
```

**React API:**
```typescript
import { useShooAuth } from "@shoojs/react";

const { identity, loading, signIn, clearIdentity } = useShooAuth();
// identity.userId  -> "ps_…" (pairwise_sub) or null
// identity.token   -> signed ES256 JWT
// loading          -> auth-state resolving
// signIn()         -> trigger flow
// clearIdentity()  -> sign out
```
Next.js callback page:
```typescript
// app/auth/callback/page.tsx
"use client";
import { useShooAuth } from "@shoojs/react";
export default function ShooCallback() {
  useShooAuth();
  return <p>Signing in…</p>;
}
```

**Vanilla JS API (`window.Shoo`):**
```javascript
const identity = window.Shoo.getIdentity();           // { userId, token }
window.Shoo.startSignIn();                             // basic
window.Shoo.startSignIn({ returnTo: "/dashboard" });  // post-login redirect
window.Shoo.startSignIn({ requestPii: true });        // request email/name/picture
window.Shoo.clearIdentity();                          // sign out
```
Direct link (the SDK auto-upgrades it with PKCE + state, then handles the `/shoo/callback` exchange):
```html
<a href="https://shoo.dev/authorize?redirect_uri=https://your-app.com/shoo/callback">Sign in</a>
```

**Environment variables** (server verification / Convex):
```
SHOO_BASE_URL = "https://shoo.dev"
SHOO_ISSUER   = "https://shoo.dev"
APP_ORIGIN    = "http://localhost:3000"   # or your production domain
VITE_CONVEX_URL = "https://…"             # Convex integration
```

### Server verification (required for production)

*"The browser auth flow gives the user a signed `id_token`, but the browser is an untrusted environment."* You must verify tokens server-side before authorizing users: *"Always verify the signature, issuer, audience, and expiration on your server."* What is checked:

1. **Issuer** (`iss`) — must equal `https://shoo.dev`.
2. **Audience** (`aud`) — must equal `origin:{your_app_origin}` (the token targets *your* app).
3. **Expiration** (`exp`) — must be a future timestamp.
4. **Signature** — valid **ES256** against shoo's published JWKS keys.
5. **`pairwise_sub`** — must exist as a string (your stable user id).

This blocks forged/tampered tokens, replay (via `exp` + unique JWT id), and use at an unintended origin (audience check); key rotation is automatic at `/.well-known/jwks.json`.

Verification with `jose`:
```bash
bun add jose
```
```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

const SHOO_BASE_URL = "https://shoo.dev";
const SHOO_ISSUER = "https://shoo.dev";
const jwks = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", SHOO_BASE_URL),
);

export async function verifyShooToken(idToken: string, appOrigin: string) {
  const audience = `origin:${new URL(appOrigin).origin}`;
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: SHOO_ISSUER,
    audience,
  });
  if (typeof payload.pairwise_sub !== "string") {
    throw new Error("Shoo token missing pairwise_sub");
  }
  return payload;
}
```

Next.js API route (quoted from the docs):
```typescript
import type { NextApiRequest, NextApiResponse } from "next";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SHOO_BASE_URL = process.env.SHOO_BASE_URL || "https://shoo.dev";
const SHOO_ISSUER = process.env.SHOO_ISSUER || SHOO_BASE_URL;
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:3000";

const jwks = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", SHOO_BASE_URL),
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
  if (!idToken) return res.status(400).json({ error: "Missing idToken" });
  try {
    const audience = `origin:${new URL(APP_ORIGIN).origin}`;
    const { payload } = await jwtVerify(idToken, jwks, { issuer: SHOO_ISSUER, audience });
    if (typeof payload.pairwise_sub !== "string") {
      return res.status(401).json({ error: "Missing pairwise_sub claim" });
    }
    return res.status(200).json({ userId: payload.pairwise_sub, email: payload.email, name: payload.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return res.status(401).json({ error: message });
  }
}
```

Client → server hand-off:
```javascript
const identity = auth.identity;
if (identity.token) {
  const res = await fetch("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: identity.token }),
  });
  const data = await res.json(); // data.userId is now server-verified
}
```

### Convex integration

The only documented backend integration is **Convex** (see the [Convex reference](convex.md) for the backend side — shoo plugs into Convex's **customJwt** auth provider). `@shoojs/react` exposes **`createShooConvexAuth`**, which authenticates Convex queries and mutations with shoo and returns **`useAuth`** (manages auth state + token exchange; yields `isLoading`, `isAuthenticated`, `fetchAccessToken`), **`signIn`** (starts the flow), and **`signOut`** (clears identity and reloads).

```bash
bun add @shoojs/react
```

**1) Tell Convex to trust shoo's tokens** — `convex/auth.config.ts`:
```typescript
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://shoo.dev",
      jwks: "https://shoo.dev/.well-known/jwks.json",
      algorithm: "ES256",
    },
  ],
};
```
> Optional audience validation: add `applicationID: "origin:https://your-app-origin"`.

**2) Create the shoo auth module** — `src/shoo.ts`:
```typescript
import { createShooConvexAuth } from "@shoojs/react";

export const { useAuth, signIn, signOut } = createShooConvexAuth({
  callbackPath: "/shoo/callback",
});
```

**3) Wire it into the Convex provider** — `src/main.tsx`:
```typescript
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { useAuth } from "./shoo";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

function Root() {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
      <App />
    </ConvexProviderWithAuth>
  );
}
```

**4) Sign-in / sign-out:**
```typescript
import { signIn, signOut } from "./shoo";

function AuthButtons() {
  return (
    <div>
      <button onClick={() => signIn()}>Sign in</button>
      <button onClick={signOut}>Sign out</button>
    </div>
  );
}
```

**5) Read identity inside a Convex function** — `convex/users.ts`:
```typescript
import { query } from "./_generated/server";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return {
      userId: identity.subject,
      email: identity.email ?? null,
      name: identity.name ?? null,
    };
  },
});
```

The docs stress *"Always verify Shoo id_tokens on your server before trusting identity claims."* With Convex this is handled by the `customJwt` provider config plus Convex's own token validation — JWKS/issuer/algorithm are checked backend-side, and `ctx.auth.getUserIdentity()` only returns a verified identity.

### Threat model, pricing & limits

**Defends against:** auth-code interception (PKCE S256); cross-site tracking (domain-scoped `pairwise_sub`); token forgery/tampering (ES256 signature verification); replay (`exp` + unique JWT id); unauthorized cross-origin use (server-side `aud` check). On privacy: *"Shoo does not sell personal information"* — optional PII only with per-origin consent, codes/nonces expire and are deleted, and users manage data at `/me`.

**Pricing & hosting:** free forever, no sign-up, no paid tiers documented; open source (repo "coming soon"); SaaS-only at `https://shoo.dev` with **no self-host** documented; status **"SUPER EARLY WIP — USE AT YOUR OWN RISK"**; support `support@ping.gg`.

**Known gaps:** pre-release ("use at your own risk"), with sparse API/SDK/security docs (some pages 404); **Google-only** (no GitHub/Discord, no email/password, no magic links); **no self-host** (depends entirely on shoo's service + Google); narrow scope — an auth *broker*, not an identity platform (no user store, RBAC, orgs, MFA management); and only the **Convex** backend integration is documented (no Supabase/Firebase guides).

## Architecture

- **Three parties** — the app (browser), shoo as the OAuth intermediary, and Google as the underlying
  IdP; the customer's own server verifies the resulting token.
- **Trust model** — shoo signs tokens, so it is trusted to assert identity; it holds no session and
  the customer's server verifies independently against JWKS.
- **Privacy design** — `pairwise_sub` is derived per origin, so the broker's position in the middle
  does not become a cross-site correlation capability. That is a deliberate constraint on its own
  power, and the most creditable design decision in the product.
- **State authority** — Google for identity; shoo for the signing key and the pairwise derivation.
- **Portability boundary** — unusually good for a SaaS: the output is a standard JWT verified by
  standard JWKS, so replacing shoo means changing an issuer URL rather than rewriting integration
  code. The dependency is on availability, not on shape.

## How it competes with HoBo

It does not. shoo answers "how do end users sign in"; HoBo answers "how do workloads and agents prove
identity and obtain scoped credentials".

| Contested HoBo surface | The relationship |
| ---------------------- | ---------------- |
| `identity-secrets` | Adjacent only: human sign-in against workload and agent identity |

They compose — a HoBo-deployed application can use shoo for end-user login while HoBo handles
workload identity and secret brokering underneath.

## Where shoo.dev is stronger

What sets shoo apart from heavier auth platforms:

- **Auto-derived `client_id` from origin** — zero dashboard registration; first request from a new origin auto-registers the client.
- **Two-line integration** — *"AUTH IN 2LOC"*; no client config or client-side secret handling.
- **Standards-only contract** — ES256 JWT verified by plain JWKS, no proprietary server-side SDK; any backend with a JWKS verifier works.
- **Privacy-by-design identity** — domain-scoped `pairwise_sub` is stable per app but uncorrelatable across apps.
- **Mandatory PKCE S256** on every flow — no "plain" challenge escape hatch.
- **Free + (eventually) open** — no paid tiers, OSS pending.

The flip side is deliberate narrowness: Google-only, SaaS-only, pre-release, and broker-not-platform.

## Adversarial critique

- **"Use at your own risk" is the vendor's own assessment**, and it governs everything else in this
  capture. Nothing here should be read as a recommendation to depend on it in production.
- **A signing broker is a trusted third party.** Whoever signs the `id_token` can assert any identity;
  the pairwise design limits correlation, not authority.
- **Origin-derived client registration is elegant and is also an attack surface.** Auto-registering
  any origin that asks means the trust boundary is "controls a domain", which needs to be a
  deliberate decision rather than a convenience.
- **SaaS-only with no self-host** makes it unusable for exactly the sovereign and air-gapped
  deployments this category otherwise serves.
- **Google-only**, so it is a feature rather than an auth layer: the second identity provider a
  product needs is the migration.
- **Sparse documentation with 404s**, which for a security component is a substantive objection
  rather than a polish complaint.
- **No user store, RBAC, organizations or MFA management** — real applications need these, and
  needing them is the exit event.
- **Free with no paid tier** is not a sustainable position, and the absence of a business model is a
  continuity risk for something in an authentication path.

## Primitive mapping

<a id="hobo-mapping"></a>

> How shoo's ideas map onto HoBo's identity/auth model. ✅ = HoBo has an equivalent · ➕ = HoBo goes further · n/a = out of HoBo's scope. HoBo design lives in [`../design/`](../design/index.md). shoo is *adjacent* to HoBo (an end-user auth broker), not a head-on competitor — the interesting overlap is the identity/token model.

| shoo.dev | HoBo equivalent | Status | HoBo doc |
|---|---|---|---|
| Auth broker (intent: "sign-in with ~zero config") | HoBo's identity model is for **workloads + agents**, not human Google sign-in — but the "keyless, zero-config credential" goal is shared | ➕ | [06](../design/ai-native-agent-auth.md#plan-06) |
| ES256 `id_token` + JWKS verification | HoBo principals carry **SVIDs**/OIDC tokens verified the same standards-based way; brokered, short-lived | ➕ | [06](../design/ai-native-agent-auth.md#plan-06), [12](../design/security-networking.md#plan-12) |
| OIDC discovery (`/.well-known/openid-configuration`, JWKS) | HoBo issues/consumes OIDC; agents are first-class **OIDC principals** | ✅ | [06](../design/ai-native-agent-auth.md#plan-06) |
| Domain-scoped `pairwise_sub` (no cross-site tracking) | Tenant/audience-scoped identities; least-privilege, per-scope tokens | ✅ | [12](../design/security-networking.md#plan-12) |
| Mandatory PKCE (S256) | HoBo's agent OAuth/token brokering uses PKCE + audience-scoping | ✅ | [06](../design/ai-native-agent-auth.md#plan-06) |
| Mandatory server-side verification (browser untrusted) | HoBo's invariant: the control plane never trusts client claims; everything is verified + event-logged | ➕ | [12](../design/security-networking.md#plan-12), [11](../design/data-plane.md#plan-11) |
| `customJwt`/JWKS integration into a backend (Convex) | A HoBo app could trust shoo (or any OIDC issuer) for **end-user** auth via the `secrets`/identity ports — orthogonal to HoBo's **workload** identity | ✅ | [21](../design/authoring-resources-wiring.md#plan-21), [06](../design/ai-native-agent-auth.md#plan-06) |

**How they relate (not competitors).** shoo answers **"how do end users sign in"** (human → Google). HoBo answers **"how do workloads and AI agents prove identity and get scoped credentials to clouds"** (machine → infra). They compose: a HoBo-deployed app could use shoo for its end-user login while HoBo handles workload/agent identity + secret brokering underneath. shoo's design choices that HoBo already shares — standards-based tokens (not proprietary SDKs), JWKS verification, PKCE, audience-scoping, mandatory server verification — corroborate HoBo's [Plan 6](../design/ai-native-agent-auth.md#plan-06)/[Plan 12](../design/security-networking.md#plan-12) choices, extended to agents-as-principals and event-sourced auditing.

## Where HoBo is stronger or intentionally different

State labels follow the research contract; this capture predates it, so design intent below reads as **design-only**.


**Where HoBo deliberately differs.** The subject is **machines/agents**, not humans — HoBo's identity exists to let workloads/agents self-provision cloud credentials with zero developer involvement. It is **event-sourced and auditable** — every credential issuance/use is an event ([Plan 11](../design/data-plane.md#plan-11)), where shoo is a stateless token broker. And it is **self-hostable and multi-provider** — HoBo identity isn't tied to one IdP or a single SaaS.

## Better-together / integration posture

- **Integrate** — a HoBo application may trust shoo, or any OIDC issuer, for end-user authentication
  through the identity port; this is orthogonal to HoBo's workload identity.
- **Borrow** — two ideas:
  1. **Standards-only output.** Emitting a token any JWKS verifier can check, with no proprietary
     server SDK, is the right contract shape and is why the integration is cheap to leave.
  2. **Pairwise subjects.** Deriving an audience-scoped identifier so the broker cannot correlate
     across consumers is a constraint HoBo's own identity issuance should copy where it acts as a
     broker.
- Not a provider-target for infrastructure, not a displace or benchmark target.

## Threats and lessons

1. **Removing configuration is a product.** shoo's pitch is that the OAuth dashboard step disappears,
   which is the same argument Tailscale makes about firewall rules and HoBo makes about provider
   selection. The pattern is worth stating explicitly in HoBo's positioning.
2. **A standards-only contract makes a dependency reversible.** Because the output is a plain JWT,
   depending on shoo is cheap to undo — which is precisely the argument HoBo makes about deploying
   through providers' own services rather than owning the runtime.
3. **Maturity labels must be carried forward, not smoothed away.** The vendor says "use at your own
   risk"; a research corpus that quietly upgrades that to "available" would be misleading its own
   readers.
4. **Constraining your own authority earns trust.** Pairwise subjects limit what the broker can do
   with its position — the same instinct as Tailscale's tailnet lock, and a pattern HoBo's control
   plane still lacks.

## Sources

- [shoo.dev](https://shoo.dev) and `docs.shoo.dev` — product documentation, flow description, PKCE/ES256/JWKS contract, pairwise subject design, maturity statement (quoted above)
- Related: [Tailscale](tailscale.md) for the same removal-of-configuration argument, [Convex](convex.md) for the documented backend integration

Pricing durability, open-source timing, self-host plans and the current documentation state were not
verified in this pass and are not asserted.

## Fair use

These files are **competitive-research notes**, not redistribution of shoo.dev's documentation. Source: **`docs.shoo.dev` / `shoo.dev`** (captured 2026). Only **short excerpts are quoted** — shown in quotation marks with attribution — for **commentary, analysis, and parity comparison** (fair use); all rights in the quoted material remain with shoo.dev. Where a passage was paraphrased it is HoBo's own summary. No license over shoo's content is claimed or implied; follow the source links for the authoritative, current text. If a rights-holder objects to any excerpt, we will revise or remove it.
