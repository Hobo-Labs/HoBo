# Services

This reference implementation does not start real services. The service layer is represented by pure mock providers in `src/harness-reference.ts` and consumer contracts in `contracts/pacts/`.

Real service ownership remains:

- Policy plane: policy decisions and obligations.
- Reliability: SLO snapshot computation.
- Gateway/domain: traffic split realization.
- Data plane: event stream and ruleset sync.
- Harness: orchestration across these boundaries.
