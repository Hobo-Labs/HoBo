# Simulation

Run:

```powershell
npm.cmd --prefix src\draft\epic-proofs\v1-vibe-example-gap-closure run simulate
```

The simulation evaluates the deterministic HOBO-539 child backlog fixture and corrected DX backbone
graph, then emits:

- total child issue count;
- DX backbone issue, phase distribution, label coverage, and quickstart consumer count;
- phase and project distribution;
- mocked Pact-style boundaries covered by tests;
- the downstream unblock condition; and
- scope-creep denials for production CLI/API/SDK/UI, live customer data, and unsupported launch
  claims.
