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
.tools/cue/v0.14.0/cue vet -c packages/dispatcher/data-models/dispatch.cue packages/dispatcher/data-models/fixtures/valid/credit-ledger-max-sequence.json -d '#CreditLedgerViewRecord'
```

The same commands with `fixtures/invalid` must fail: negative reserved money
and an invented cancellation/refund state cannot cross the wire boundary.
The `credit-ledger-unsafe-sequence.json` invalid fixture must also fail against
`#CreditLedgerViewRecord`: JavaScript ledger sequences stop at the largest safe
integer even though the protobuf field can hold a larger `uint64`.
The `reservation-overconsumption`, `reservation-overrate`, and
`reservation-overslots` invalid fixtures must fail against `#ReservationRecord`.
The runtime additionally validates the credit entries and their combined use.
This package remains outside generated runtime codegen until it explicitly
opts into a Buf module; schema compilation alone is not fixture validation.
