# @hobo/hobo-ci contracts

`pacts/github-app-manifest.pact.json` is the boundary between the CI project's
GitHub connection (`createGithubConnectFlow`, the consumer) and GitHub's REST
API (the provider), in the order the flow calls it:

1. **Conversion**: `POST /app-manifests/{code}/conversions` turns the one-time
   manifest code into the App's credentials (once; the code cannot be reused).
2. **Identity**: `GET /app`, signed with the App's own key, must describe the
   same App the conversion did.
3. **Webhook**: `GET /app/hook/config` must point at the reviewed relay URL.

`test/github-connection.test.ts` runs the consumer against these interactions:
its fake GitHub answers from this file (adding the reviewed permissions and
events, and a private key generated per run in place of the placeholder), and
asserts the flow made exactly these requests in this order. The real
`verifyConvertedGithubApp` runs unmodified on the answers.
