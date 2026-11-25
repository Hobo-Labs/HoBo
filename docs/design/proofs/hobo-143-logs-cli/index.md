# HOBO-143 Logs CLI Proof

HOBO-143 is proven by the focused POC at
[`src/draft/technical-proofs/hobo-logs-cli-contract`](../../../../src/draft/technical-proofs/hobo-logs-cli-contract/README.md).

## Acceptance Evidence

- `logs --follow` renders live output from the Camp runtime Streamer.
- `<resource>` filters scope the stream to a single resource.
- `--tail <n>` returns a bounded recent window and exits without `--follow`.
- `--json` emits one structured object per line.
- The command uses the Streamer source, not the Yard read path; the focused test
  keeps working with a deliberately unreachable Yard stub.

## Adversarial Evidence

- Unknown resources fail with an explicit error and do not leave a
  subscription open.
- Dropped transport and subscriber backpressure render visible gap markers.
- Ctrl-C/abort tears down the follow subscription cleanly.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-logs-cli-contract test
```
