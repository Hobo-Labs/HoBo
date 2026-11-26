# HOBO-74 Native Log Projection Proof

This proof backs [PLAN-11](../../data-plane.md#plan-11),
[PLAN-32](../../data-plane.md#plan-32), [ADR-0050](../../adr/03-data-plane.md#adr-0050),
[ADR-0052](../../adr/03-data-plane.md#adr-0052), and
[ADR-0086](../../adr/03-data-plane.md#adr-0086).

The executable POC in
[`src/draft/technical-proofs/native-log-projection-contract`](../../../../src/draft/technical-proofs/native-log-projection-contract)
pins the M1 native projection boundary:

- `projection(name, { key, on })` declares the typed authoring surface and derives the event
  read-set from handler names;
- `projection.Declared` carries the read-model WIT row shape, read-set, index hints, and native
  reactive class;
- the native log-backed standing projection folds fixture streams to the current per-stream `seq`;
- same-key events are folded in deterministic sequence order;
- events outside the read-set are ignored by construction;
- write-capable folds fail before declaration;
- malformed event bodies raise `ProjectionFoldError` for poison-event handling.

Scope kept out: provider sink adapters, Reactor push scheduling, schema mapping, and
rebuild-from-zero scale behavior.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\native-log-projection-contract test
```
