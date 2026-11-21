# @hobo/hobo-cd contracts

`pacts/vercel-integration.pact.json` is the boundary between the CD project's
Vercel connection (`createVercelConnectFlow`, the consumer) and Vercel's REST
API (the provider):

1. **Exchange**: `POST /v2/oauth/access_token` (form-encoded `client_id`,
   `client_secret`, `code`, `redirect_uri`) turns the integration's one-time
   code (single use, 30 minutes) into the installation's access token.
2. **Verification**: `GET /v2/user` with that token must name the user the
   exchange named.

`test/vercel-connection.test.ts` runs the consumer against these interactions:
its fake Vercel answers from this file and the test asserts the flow made
exactly these requests in this order.
