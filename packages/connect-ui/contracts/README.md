# @hobo/connect-ui contracts

`pacts/connect-page.pact.json` is the boundary between the browser client
(`src/client/main.tsx`, the consumer) and the loopback connect page server
(`startConnectPage`, the provider). It covers:

1. **View**: `GET view` returns the current step's composed, validated view
   (`ConnectViewRecord` in `data-models/connect_ui.proto`).
2. **Action**: `POST action` with a catalog action moves the step only through
   the flow, and the response is the next view.
3. **Refusal**: an action outside the catalog is a `400` that never reaches
   the flow.

`test/connect-page.pact.test.ts` verifies the provider against these
interactions: it starts a real server per interaction, replays the request
under the session path, and checks the status and the response body's
declared fields.
