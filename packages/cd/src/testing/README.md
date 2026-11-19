# CD testing doubles

`@hobo/cd/testing` provides small, in-process implementations of CD boundary
ports. `createRecordingCdEventSink` implements the same `CdEventSink` used by
the real CDEvents webhook boundary, so a test can exercise the real CD
notification port or relay without sending a network request.

Each sink records copies of events in delivery order. Its `events` property
returns a fresh snapshot, and `clear()` removes the recorded history. A caller
can supply a `delivery` result to exercise a dead-letter result. The double does
not persist dead letters or model retries, HTTP, credentials, or a remote
notification provider.

## Runbook

- If an expected notification is absent, await the notification port's
  `drain()` before inspecting `sink.events` and check that its channel maps
  to the sink.
- Create a new sink for each test, or call `clear()` between scenarios.
- Use the real webhook sink and a protocol-level test when transport,
  signatures, retries, or provider compatibility are the behavior under test.
