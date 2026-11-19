----------------------- MODULE BrokerEntitlement -----------------------
EXTENDS Naturals
CONSTANTS PreserveScope, CheckReplayScope, FenceUncertain
VARIABLES phase, claimed, bucketUnit, bucketPeriod, attempted, replay, unusedRelease, claimUnits
vars == <<phase, claimed, bucketUnit, bucketPeriod, attempted, replay, unusedRelease, claimUnits>>
Active == phase \in {"held", "uncertain"}
Usable == phase = "held"
UncertainUsable == phase = "uncertain" /\ FenceUncertain
Matches == bucketUnit = "units" /\ bucketPeriod = "p1"

Init == /\ phase = "new" /\ claimed = FALSE /\ bucketUnit = "units"
        /\ bucketPeriod = "p1" /\ attempted = FALSE /\ replay = "none"
        /\ unusedRelease = FALSE /\ claimUnits = 1

Reserve == /\ phase = "new"
           /\ phase' = "held" /\ claimUnits' = 1
           /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay, unusedRelease>>
Claim == /\ Usable /\ ~claimed /\ claimed' = TRUE
         /\ UNCHANGED <<phase, bucketUnit, bucketPeriod, attempted, replay, unusedRelease, claimUnits>>
RecordZeroUnits == /\ (Usable \/ UncertainUsable) /\ claimed /\ claimUnits = 1
                   /\ claimUnits' = 0
                   /\ UNCHANGED <<phase, claimed, bucketUnit, bucketPeriod, attempted, replay, unusedRelease>>
Uncertain == /\ phase = "held" /\ phase' = "uncertain"
             /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay, unusedRelease, claimUnits>>
ChangeScope == /\ Active /\ ~attempted
               /\ \E unit \in {"units", "other"}, period \in {"p1", "p2"}:
                    /\ unit # "units" \/ period # "p1"
                    /\ attempted' = TRUE
                    /\ IF PreserveScope
                          THEN UNCHANGED <<bucketUnit, bucketPeriod>>
                          ELSE /\ bucketUnit' = unit /\ bucketPeriod' = period
               /\ UNCHANGED <<phase, claimed, replay, unusedRelease, claimUnits>>
ReplayMismatch == /\ Active /\ replay = "none"
                  /\ replay' = IF CheckReplayScope THEN "rejected" ELSE "accepted-invalid"
                  /\ UNCHANGED <<phase, claimed, bucketUnit, bucketPeriod, attempted, unusedRelease, claimUnits>>
Settle == /\ (Usable \/ (phase = "uncertain" /\ claimed)) /\ claimed /\ Matches /\ phase' = "settled"
          /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay, unusedRelease, claimUnits>>
ConfirmUnused == /\ Active /\ ~claimed /\ ~unusedRelease
                 /\ unusedRelease' = TRUE
                 /\ UNCHANGED <<phase, claimed, bucketUnit, bucketPeriod, attempted, replay, claimUnits>>
Release == /\ Active /\ ~claimed /\ unusedRelease
           /\ phase' = "released"
           /\ UNCHANGED <<claimed, bucketUnit, bucketPeriod, attempted, replay, unusedRelease, claimUnits>>
ChangeTerminalScope == /\ phase \in {"settled", "released"} /\ ~attempted /\ claimUnits # 0
                       /\ attempted' = TRUE /\ bucketUnit' = "other" /\ bucketPeriod' = "p2"
                       /\ UNCHANGED <<phase, claimed, replay, unusedRelease, claimUnits>>
Done == /\ phase \in {"settled", "released"} /\ UNCHANGED vars
Next == Reserve \/ Claim \/ RecordZeroUnits \/ Uncertain \/ ChangeScope \/ ReplayMismatch \/ Settle
        \/ ConfirmUnused \/ Release \/ ChangeTerminalScope \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"new", "held", "uncertain", "settled", "released"}
          /\ claimed \in BOOLEAN /\ bucketUnit \in {"units", "other"}
          /\ bucketPeriod \in {"p1", "p2"} /\ attempted \in BOOLEAN
          /\ replay \in {"none", "rejected", "accepted-invalid"}
          /\ unusedRelease \in BOOLEAN /\ claimUnits \in {0, 1}
ActiveClaimKeepsScope == Active => Matches
ReplayRejectsMismatch == replay # "accepted-invalid"
ZeroUnitClaimRetainsScope == claimUnits = 0 => Matches
=============================================================================