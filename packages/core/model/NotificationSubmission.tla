------------------------ MODULE NotificationSubmission ------------------------
EXTENDS Naturals

VARIABLES phase, authorized, dispatched, committed, dispatchAuthorized, disclosureAuthorized
vars == <<phase, authorized, dispatched, committed, dispatchAuthorized, disclosureAuthorized>>

Init ==
  /\ phase = "new"
  /\ authorized = TRUE
  /\ dispatched = FALSE
  /\ committed = FALSE
  /\ dispatchAuthorized = FALSE
  /\ disclosureAuthorized = FALSE

Revoke ==
  /\ authorized
  /\ authorized' = FALSE
  /\ UNCHANGED <<phase, dispatched, committed, dispatchAuthorized, disclosureAuthorized>>

Dispatch ==
  /\ phase = "new" /\ authorized
  /\ phase' = "pending"
  /\ dispatched' = TRUE
  /\ dispatchAuthorized' = authorized
  /\ UNCHANGED <<authorized, committed, disclosureAuthorized>>

ProviderCommit ==
  /\ dispatched /\ ~committed
  /\ committed' = TRUE
  /\ UNCHANGED <<phase, authorized, dispatched, dispatchAuthorized, disclosureAuthorized>>

Accept ==
  /\ phase = "pending" /\ committed /\ authorized
  /\ phase' = "accepted"
  /\ disclosureAuthorized' = authorized
  /\ UNCHANGED <<authorized, dispatched, committed, dispatchAuthorized>>

Reject ==
  /\ phase = "new" /\ ~dispatched
  /\ phase' = "rejected"
  /\ UNCHANGED <<authorized, dispatched, committed, dispatchAuthorized, disclosureAuthorized>>

Unknown ==
  /\ phase = "pending"
  /\ phase' = "unknown"
  /\ UNCHANGED <<authorized, dispatched, committed, dispatchAuthorized, disclosureAuthorized>>

Spec == Init /\ [][Revoke \/ Dispatch \/ ProviderCommit \/ Accept \/ Reject \/ Unknown]_vars
TypeOK == /\ phase \in {"new", "pending", "accepted", "rejected", "unknown"}
          /\ authorized \in BOOLEAN /\ dispatched \in BOOLEAN /\ committed \in BOOLEAN
          /\ dispatchAuthorized \in BOOLEAN /\ disclosureAuthorized \in BOOLEAN
RejectedBeforeDispatch == phase = "rejected" => ~dispatched
AcceptedAfterCommit == phase = "accepted" => committed
DispatchAuthorized == dispatched => dispatchAuthorized
DisclosureAuthorized == phase = "accepted" => disclosureAuthorized
NoUnknownBeforeCommit == ~(phase = "unknown" /\ ~committed)
NoUnknownAfterCommit == ~(phase = "unknown" /\ committed)
=============================================================================
