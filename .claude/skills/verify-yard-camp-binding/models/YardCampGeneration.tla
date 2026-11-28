------------------------- MODULE YardCampGeneration -------------------------
EXTENDS Naturals
CONSTANTS PrecheckCamp, PostcheckCamp, RecordUncertain
VARIABLES expectedMatches, actualMatches, phase, hold, effect, uncertain
vars == <<expectedMatches, actualMatches, phase, hold, effect, uncertain>>

Init == /\ expectedMatches \in BOOLEAN /\ actualMatches \in BOOLEAN
        /\ phase = "preflight" /\ hold = FALSE /\ effect = FALSE
        /\ uncertain = FALSE
Preflight == /\ phase = "preflight"
             /\ phase' = IF ~expectedMatches /\ PrecheckCamp THEN "rejected" ELSE "reserve"
             /\ UNCHANGED <<expectedMatches, actualMatches, hold, effect, uncertain>>
Reserve == /\ phase = "reserve" /\ phase' = "provision" /\ hold' = TRUE
           /\ UNCHANGED <<expectedMatches, actualMatches, effect, uncertain>>
Provision == /\ phase = "provision" /\ phase' = "review" /\ effect' = TRUE
             /\ UNCHANGED <<expectedMatches, actualMatches, hold, uncertain>>
Review == /\ phase = "review"
          /\ phase' = IF ~actualMatches /\ PostcheckCamp THEN "rejected" ELSE "issued"
          /\ uncertain' = (~actualMatches /\ PostcheckCamp /\ RecordUncertain)
          /\ UNCHANGED <<expectedMatches, actualMatches, hold, effect>>
Done == /\ phase \in {"rejected", "issued"} /\ UNCHANGED vars
Next == Preflight \/ Reserve \/ Provision \/ Review \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ expectedMatches \in BOOLEAN /\ actualMatches \in BOOLEAN
          /\ phase \in {"preflight", "reserve", "provision", "review", "rejected", "issued"}
          /\ hold \in BOOLEAN /\ effect \in BOOLEAN /\ uncertain \in BOOLEAN
NoKnownForeignHold == ~expectedMatches => ~hold
NoKnownForeignEffect == ~expectedMatches => ~effect
NoForeignReceipt == phase = "issued" => actualMatches
EffectRetainsHold == effect => hold
MismatchUncertain == phase = "rejected" /\ effect /\ ~actualMatches => uncertain
=============================================================================
