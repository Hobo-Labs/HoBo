------------------------ MODULE YardResidencyDirect ------------------------
EXTENDS Naturals
CONSTANTS CheckPlanner, CheckSaga
VARIABLES tagValid, viaPlanner, phase, planned, effect
vars == <<tagValid, viaPlanner, phase, planned, effect>>
Init == /\ tagValid \in BOOLEAN /\ viaPlanner \in BOOLEAN
        /\ phase = IF viaPlanner THEN "plan" ELSE "run"
        /\ planned = FALSE /\ effect = FALSE
Plan == /\ phase = "plan"
        /\ phase' = IF ~tagValid /\ CheckPlanner THEN "refused" ELSE "run"
        /\ planned' = (tagValid \/ ~CheckPlanner)
        /\ UNCHANGED <<tagValid, viaPlanner, effect>>
Run == /\ phase = "run"
       /\ phase' = IF ~tagValid /\ CheckSaga THEN "refused" ELSE "done"
       /\ effect' = (tagValid \/ ~CheckSaga)
       /\ UNCHANGED <<tagValid, viaPlanner, planned>>
Done == /\ phase \in {"refused", "done"} /\ UNCHANGED vars
Next == Plan \/ Run \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ tagValid \in BOOLEAN /\ viaPlanner \in BOOLEAN
          /\ phase \in {"plan", "run", "refused", "done"}
          /\ planned \in BOOLEAN /\ effect \in BOOLEAN
NoInvalidPlan == planned => tagValid
NoInvalidEffect == effect => tagValid
=============================================================================
