--------------------- MODULE YardResidencyGeneration ---------------------
EXTENDS Naturals
CONSTANT CheckParse
VARIABLES tagValid, phase, hold, effect
vars == <<tagValid, phase, hold, effect>>
Init == /\ tagValid \in BOOLEAN /\ phase = "parse" /\ hold = FALSE /\ effect = FALSE
Parse == /\ phase = "parse"
         /\ phase' = IF ~tagValid /\ CheckParse THEN "refused" ELSE "reserve"
         /\ UNCHANGED <<tagValid, hold, effect>>
Reserve == /\ phase = "reserve" /\ hold' = TRUE /\ phase' = "provision"
           /\ UNCHANGED <<tagValid, effect>>
Provision == /\ phase = "provision" /\ effect' = TRUE /\ phase' = "done"
             /\ UNCHANGED <<tagValid, hold>>
Done == /\ phase \in {"refused", "done"} /\ UNCHANGED vars
Next == Parse \/ Reserve \/ Provision \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ tagValid \in BOOLEAN /\ phase \in {"parse", "refused", "reserve", "provision", "done"}
          /\ hold \in BOOLEAN /\ effect \in BOOLEAN
NoInvalidHold == ~tagValid => ~hold
NoInvalidEffect == ~tagValid => ~effect
EffectHasHold == effect => hold
=============================================================================
