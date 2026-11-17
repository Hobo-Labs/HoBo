--------------------------- MODULE FleetDelivery ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Limit
ASSUME Limit > 0
VARIABLES phase, fence, active, expired, accepted, acceptedToken, dispatchFence
vars == <<phase, fence, active, expired, accepted, acceptedToken, dispatchFence>>
Init == /\ phase = "planned" /\ fence = 0 /\ active = 0 /\ expired = {}
        /\ accepted = FALSE /\ acceptedToken = 0 /\ dispatchFence = 0
Issue == /\ phase = "planned" /\ active = 0 /\ fence < Limit
         /\ fence' = fence + 1 /\ active' = fence + 1 /\ accepted' = FALSE
         /\ UNCHANGED <<phase, expired, acceptedToken, dispatchFence>>
ExpirePlanned == /\ phase = "planned" /\ active # 0
                 /\ expired' = expired \cup {active} /\ active' = 0
                 /\ accepted' = FALSE
                 /\ UNCHANGED <<phase, fence, acceptedToken, dispatchFence>>
Dispatch == /\ phase = "planned" /\ active # 0 /\ phase' = "dispatching"
            /\ dispatchFence' = fence /\ accepted' = FALSE
            /\ UNCHANGED <<fence, active, expired, acceptedToken>>
ExpireDispatch == /\ phase = "dispatching" /\ active # 0
                  /\ expired' = expired \cup {active} /\ active' = 0
                  /\ accepted' = FALSE
                  /\ UNCHANGED <<phase, fence, acceptedToken, dispatchFence>>
AttemptAck(token) == /\ accepted' = (phase = "dispatching" /\ active # 0 /\ token = active)
                     /\ acceptedToken' = token
                     /\ IF accepted' THEN /\ phase' = "confirmed" /\ active' = 0
                                     ELSE /\ UNCHANGED <<phase, active>>
                     /\ UNCHANGED <<fence, expired, dispatchFence>>
Attempts == \E token \in 1..Limit : AttemptAck(token)
Next == Issue \/ ExpirePlanned \/ Dispatch \/ ExpireDispatch \/ Attempts
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"planned", "dispatching", "confirmed"}
          /\ fence \in Nat /\ active \in 0..Limit /\ expired \subseteq 1..Limit
          /\ accepted \in BOOLEAN /\ acceptedToken \in 0..Limit /\ dispatchFence \in 0..Limit
BoundedFence == fence <= Limit
NoReusedToken == active = 0 \/ active \notin expired
NoStaleAcknowledgement == accepted => acceptedToken \notin expired
NoReissueAfterDispatch == phase \in {"dispatching", "confirmed"} => fence = dispatchFence
=============================================================================
