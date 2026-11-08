# Dispatcher wire evidence

`dispatch.proto` owns the wire vocabulary; `dispatch.cue` constrains its
records. Runtime semantics (CAS, final settlement, dwell evidence and expiry)
are also checked by the package tests. Account money uses one declared currency;
these records do not provide currency conversion.

The account and reservation fixtures exercise paid exposure and the running
state with real CUE validation. From the repository root:

```sh
.tools/cue/v0.14.0/cue vet -c packages/dispatcher/data-models/dispatch.cue packages/dispatcher/data-models/fixtures/valid/credit-account.json -d '#CreditAccountRecord'
.tools/cue/v0.14.0/cue vet -c packages/dispatcher/data-models/dispatch.cue packages/dispatcher/data-models/fixtures/valid/reservation.json -d '#ReservationRecord'
```

The same commands with `fixtures/invalid` must fail: negative reserved money
and an invented cancellation/refund state cannot cross the wire boundary.
This package remains outside generated runtime codegen until it explicitly
opts into a Buf module; schema compilation alone is not fixture validation.
