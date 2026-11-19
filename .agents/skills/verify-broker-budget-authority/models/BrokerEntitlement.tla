----------------------- MODULE BrokerEntitlement -----------------------
EXTENDS Naturals
CONSTANTS PreserveScope, CheckReplayScope
VARIABLES phase, claimed, bucketUnit, bucketPeriod, attempted, replay
vars == <<phase, claimed, bucketUnit, bucketPeriod, attempted, replay>>
Active == phase \in {"held", "uncertain"}
Matches == bucketUnit = "units" /\ bucketPeriod = "p1"

Init == /\ phase = "new" /\ claimed = FALSE /\ bucketUnit = "units"
        /\ bucketPeriod = "p1" /\ attempted = FALSE /\ replay = "none"
Reserve == /\ phase = "new" /\ phase' = "held"
           /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay>>
Claim == /\ Active /\ ~claimed /\ claimed' = TRUE
         /\ UNCHANGED <<phase, bucketUnit, bucketPeriod, attempted, replay>>
Uncertain == /\ phase = "held" /\ phase' = "uncertain"
             /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay>>
ChangeScope == /\ Active /\ ~attempted
               /\ \E unit \in {"units", "other"}, period \in {"p1", "p2"}:
                    /\ unit # "units" \/ period # "p1"
                    /\ attempted' = TRUE
                    /\ IF PreserveScope
                          THEN UNCHANGED <<bucketUnit, bucketPeriod>>
                          ELSE /\ bucketUnit' = unit /\ bucketPeriod' = period
               /\ UNCHANGED <<phase, claimed, replay>>
ReplayMismatch == /\ Active /\ replay = "none"
                  /\ replay' = IF CheckReplayScope THEN "rejected" ELSE "accepted-invalid"
                  /\ UNCHANGED <<phase, claimed, bucketUnit, bucketPeriod, attempted>>
Settle == /\ Active /\ Matches /\ phase' = "settled"
          /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay>>
Release == /\ Active /\ ~claimed /\ phase' = "released"
           /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay>>
ChangeTerminalScope == /\ phase \in {"settled", "released"} /\ ~attempted
                       /\ attempted' = TRUE /\ bucketUnit' = "other" /\ bucketPeriod' = "p2"
                       /\ UNCHANGED <<phase, claimed, replay>>
Done == /\ phase \in {"settled", "released"} /\ UNCHANGED vars
Next == Reserve \/ Claim \/ Uncertain \/ ChangeScope \/ ReplayMismatch \/ Settle \/ Release \/ ChangeTerminalScope \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"new", "held", "uncertain", "settled", "released"}
          /\ claimed \in BOOLEAN /\ bucketUnit \in {"units", "other"}
          /\ bucketPeriod \in {"p1", "p2"} /\ attempted \in BOOLEAN
          /\ replay \in {"none", "rejected", "accepted-invalid"}
ActiveClaimKeepsScope == Active => Matches
ReplayRejectsMismatch == replay # "accepted-invalid"
=============================================================================
