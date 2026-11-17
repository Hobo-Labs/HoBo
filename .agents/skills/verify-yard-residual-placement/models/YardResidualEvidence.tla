------------------------ MODULE YardResidualEvidence -------------------------
EXTENDS Naturals
CONSTANTS RequireFull, RequireRegion, RequireProvider, CheckSnapshot
VARIABLES capability, region, provider, stable, phase
facts == <<capability, region, provider, stable>>
vars == <<capability, region, provider, stable, phase>>
Init == /\ capability \in {"none", "partial", "full"}
        /\ region \in BOOLEAN /\ provider \in BOOLEAN /\ stable \in BOOLEAN
        /\ phase = "checking"
Eligible == /\ (IF RequireFull THEN capability = "full" ELSE TRUE)
            /\ (IF RequireRegion THEN region ELSE TRUE)
            /\ (IF RequireProvider THEN provider ELSE TRUE)
Inspect == /\ phase = "checking"
           /\ phase' = IF Eligible THEN "rechecking" ELSE "rejected"
           /\ UNCHANGED facts
Recheck == /\ phase = "rechecking"
           /\ phase' = IF stable \/ ~CheckSnapshot THEN "selected" ELSE "rejected"
           /\ UNCHANGED facts
Done == /\ phase \in {"selected", "rejected"} /\ UNCHANGED vars
Next == Inspect \/ Recheck \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ capability \in {"none", "partial", "full"}
          /\ region \in BOOLEAN /\ provider \in BOOLEAN /\ stable \in BOOLEAN
          /\ phase \in {"checking", "rechecking", "selected", "rejected"}
CompleteMatch == phase = "selected" => capability = "full"
SupportedRegion == phase = "selected" => region
SelectedProvider == phase = "selected" => provider
StableEvidence == phase = "selected" => stable
=============================================================================
