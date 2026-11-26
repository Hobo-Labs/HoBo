# Deployment Reference

Use this reference when deploying a Colyseus backend for a web game, especially when the frontend is hosted on Vercel.

## Philosophy: Frontend Host and Realtime Host Are Different Jobs

A static or serverless web host is optimized for delivering frontend assets and request-scoped logic. An authoritative Colyseus server is an always-on realtime backend with long-lived websocket connections and in-memory room state.

Treat them as separate services unless you have infrastructure that explicitly supports both shapes well.

## Recommended Topology

For a browser game:

- **Frontend**: Vercel
- **Realtime backend**: Colyseus Cloud or another always-on Node host
- **Optional REST/API backend**: same service as Colyseus or a separate app, depending on auth and account needs

Example domains:

- `game.example.com` for the web client
- `rt.example.com` for the Colyseus server
- `api.example.com` if you keep account APIs separate

## Strong Default Recommendation

Use:

- Vercel for the frontend
- Colyseus Cloud for the Colyseus server

This is the shortest path to production with the least infrastructure work.

## Alternatives

If not using Colyseus Cloud, host the Colyseus server on infrastructure meant for long-lived Node processes, such as:

- Fly.io
- Railway
- Render
- DigitalOcean
- Vultr
- AWS or GCP on your own stack

The important requirement is not the vendor. It is support for long-lived websocket connections and an always-on process model.

## Self-Host Requirements

If you self-host, be explicit about the operational pieces Colyseus expects:

- TLS and secure websocket transport in production
- graceful shutdown behavior during deploys and restarts
- sticky-session or equivalent websocket-friendly load-balancing behavior when multiple upstream processes exist
- shared presence/driver infrastructure when scaling beyond one process
- protected monitoring and logs

## Why Not Vercel for the Colyseus Server

Vercel is a good fit for the web client, not the authoritative Colyseus process. The mismatch is architectural:

- Colyseus rooms keep state in memory across time.
- Websocket sessions are long-lived.
- Match simulation expects an always-on process and controlled shutdown behavior.
- Serverless or request-scoped execution is the wrong primitive for room-hosted multiplayer.

Use Vercel for the frontend. Point it at a separate Colyseus origin.

## Client Configuration

Keep the Colyseus URL explicit in the frontend environment.

```ts
import { Client } from "@colyseus/sdk";

const client = new Client(import.meta.env.VITE_COLYSEUS_URL);
```

Example Vercel environment variables:

```env
VITE_COLYSEUS_URL=https://rt.example.com
VITE_API_URL=https://api.example.com
```

Use `https://` for production browser clients.

## Auth Transport

When frontend and realtime backend are on different subdomains, token-based auth is usually simpler than cookie-coupled assumptions.

Typical pattern:

1. User signs in through your app.
2. Frontend receives a token or session artifact.
3. Frontend sets `client.auth.token` or passes the token during join.
4. Room `onAuth()` validates the token and returns user data.

Keep auth validation deterministic and fast. The room should receive trusted identity data, not perform UI-centric auth flows.

## CORS and TLS

Production checklist:

- Serve the frontend over HTTPS.
- Serve the Colyseus backend over HTTPS and websocket-secure transport.
- Allow the frontend origin in backend CORS where relevant.
- Do not rely on redirect hops for websocket upgrades.
- Keep local development URLs and production URLs clearly separated.

If you run behind a load balancer with multiple Colyseus processes, make sure reconnect traffic lands correctly for your architecture. Realtime deployments need more care here than a normal request/response API.

## Suggested Environment Variables

Backend:

```env
PORT=2567
NODE_ENV=production
CLIENT_ORIGIN=https://game.example.com
JWT_SECRET=replace-me
AUTH_SALT=replace-me-if-using-colyseus-auth
SESSION_SECRET=replace-me-if-using-oauth-flow
```

Frontend:

```env
VITE_COLYSEUS_URL=https://rt.example.com
```

Add game-specific variables as needed for analytics, storage, or external APIs.

## Scaling Thoughts

Prototype and early access:

- one Colyseus process
- one region
- simple room definitions

Production growth:

- shared presence/driver where needed
- explicit process and region strategy
- observability on room counts, CCU, errors, reconnects, and join failures

Do not add distributed complexity before you need it. But do avoid single-process assumptions in the code shape if scale is clearly coming.

## Rollout Checklist

- Frontend deployed separately from the Colyseus backend
- Secure Colyseus URL exposed to the web client via env var
- Auth flow chosen and validated
- Join, leave, reconnect, and invalid token paths tested
- Graceful shutdown behavior verified
- Logs or monitoring in place for join errors and room crashes
- One staging environment that mirrors production topology
- Monitoring endpoints protected or disabled in production
- Multi-process coordination planned before horizontal scale is enabled

## Deployment Anti-Patterns

- Hardcoding `localhost` URLs in frontend code paths that reach production
- Coupling room state to a platform that scales to zero
- Depending on cookies across subdomains without validating actual browser behavior
- Treating local websocket success as proof that production topology is correct
- Adding multi-region complexity before you can measure latency and operational need
- Exposing live room monitoring publicly
- Scaling to multiple processes without shared infrastructure to coordinate them
