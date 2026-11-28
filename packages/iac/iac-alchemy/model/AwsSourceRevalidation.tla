----------------------- MODULE AwsSourceRevalidation -----------------------
EXTENDS Naturals

VARIABLES phase, source, authorized, startedMatched, startedAuthorized,
          dispatched, dispatchMatched, disclosureMatched, disclosureAuthorized
vars == <<phase, source, authorized, startedMatched, startedAuthorized,
          dispatched, dispatchMatched, disclosureMatched, disclosureAuthorized>>

Init ==
  /\ phase = "idle" /\ source = "expected" /\ authorized = TRUE
  /\ startedMatched = FALSE /\ startedAuthorized = FALSE
  /\ dispatched = FALSE /\ dispatchMatched = FALSE
  /\ disclosureMatched = FALSE /\ disclosureAuthorized = FALSE

ChangeSource ==
  /\ source = "expected" /\ source' = "changed"
  /\ UNCHANGED <<phase, authorized, startedMatched, startedAuthorized,
                 dispatched, dispatchMatched, disclosureMatched, disclosureAuthorized>>

Revoke ==
  /\ authorized /\ authorized' = FALSE
  /\ UNCHANGED <<phase, source, startedMatched, startedAuthorized,
                 dispatched, dispatchMatched, disclosureMatched, disclosureAuthorized>>

BeginVerification ==
  /\ phase = "idle" /\ source = "expected" /\ authorized
  /\ phase' = "verifying"
  /\ UNCHANGED <<source, authorized, startedMatched, startedAuthorized,
                 dispatched, dispatchMatched, disclosureMatched, disclosureAuthorized>>

Approve ==
  /\ phase = "verifying" /\ source = "expected" /\ authorized
  /\ phase' = "inflight"
  /\ startedMatched' = (source = "expected") /\ startedAuthorized' = authorized
  /\ UNCHANGED <<source, authorized, dispatched, dispatchMatched,
                 disclosureMatched, disclosureAuthorized>>

RejectBeforeDispatch ==
  /\ phase \in {"idle", "verifying", "inflight"} /\ ~dispatched
  /\ (source # "expected" \/ ~authorized)
  /\ phase' = "rejected"
  /\ UNCHANGED <<source, authorized, startedMatched, startedAuthorized,
                 dispatched, dispatchMatched, disclosureMatched, disclosureAuthorized>>

ProviderDispatch ==
  /\ phase = "inflight" /\ ~dispatched
  /\ dispatched' = TRUE /\ dispatchMatched' = (source = "expected")
  /\ UNCHANGED <<phase, source, authorized, startedMatched, startedAuthorized,
                 disclosureMatched, disclosureAuthorized>>

ReturnResult ==
  /\ phase = "inflight" /\ dispatched /\ source = "expected" /\ authorized
  /\ phase' = "returned"
  /\ disclosureMatched' = (source = "expected") /\ disclosureAuthorized' = authorized
  /\ UNCHANGED <<source, authorized, startedMatched, startedAuthorized,
                 dispatched, dispatchMatched>>

Unknown ==
  /\ phase = "inflight"
  /\ (source # "expected" \/ ~authorized)
  /\ phase' = "unknown"
  /\ UNCHANGED <<source, authorized, startedMatched, startedAuthorized,
                 dispatched, dispatchMatched, disclosureMatched, disclosureAuthorized>>

Spec == Init /\ [][ChangeSource \/ Revoke \/ BeginVerification \/ Approve \/ RejectBeforeDispatch \/ ProviderDispatch \/ ReturnResult \/ Unknown]_vars
TypeOK == /\ phase \in {"idle", "verifying", "inflight", "returned", "rejected", "unknown"}
          /\ source \in {"expected", "changed"} /\ authorized \in BOOLEAN
          /\ startedMatched \in BOOLEAN /\ startedAuthorized \in BOOLEAN
          /\ dispatched \in BOOLEAN /\ dispatchMatched \in BOOLEAN
          /\ disclosureMatched \in BOOLEAN /\ disclosureAuthorized \in BOOLEAN
StartedWithMatchingSource == phase \in {"inflight", "returned", "unknown"} => startedMatched
StartedAuthorized == phase \in {"inflight", "returned", "unknown"} => startedAuthorized
RejectedWithoutDispatch == phase = "rejected" => ~dispatched
ReturnedAfterDispatch == phase = "returned" => dispatched
ReturnedWithMatchingSource == phase = "returned" => disclosureMatched
ReturnedAuthorized == phase = "returned" => disclosureAuthorized
NoChangedSourceDispatch == ~(phase = "unknown" /\ dispatched /\ ~dispatchMatched)
NoUnknownAfterDispatch == ~(phase = "unknown" /\ dispatched)
NoUnknownBeforeDispatch == ~(phase = "unknown" /\ ~dispatched)
NoRejectedOperation == ~(phase = "rejected")
NoReturnedOperation == ~(phase = "returned")
=============================================================================
