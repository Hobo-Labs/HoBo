# R2 origin contract

`pacts/r2-origin.pact.json` describes the HTTP interactions consumed by the
R2 client. `test/r2-pact.test.ts` replays every response through the actual
client and checks the method, path, condition and body it sends. The in-memory
origin in `test/r2-object.test.ts` exercises the provider-side conditional
semantics, including a committed write whose response is lost. These tests do
not assert that a live R2 deployment has been verified.
