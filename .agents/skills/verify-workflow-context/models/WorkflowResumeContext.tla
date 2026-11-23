-------------------------- MODULE WorkflowResumeContext --------------------------
\* A record with one context defect, before either execution or terminal reuse.
CONSTANTS CheckInput, CheckName, CheckSeed
VARIABLES phase, defect, terminal, outcome
vars == <<phase, defect, terminal, outcome>>
Defects == {"none", "missing-input", "missing-name", "missing-seed", "bad-name", "bad-seed"}
Init == /\ phase = "received"
        /\ defect \in Defects /\ terminal \in BOOLEAN /\ outcome = "none"
Check == /\ phase = "received"
         /\ LET badInput == defect = "missing-input"
                badName == defect \in {"missing-name", "bad-name"}
                badSeed == defect \in {"missing-seed", "bad-seed"}
                allowed == /\ (~CheckInput \/ ~badInput)
                           /\ (~CheckName \/ ~badName)
                           /\ (~CheckSeed \/ ~badSeed)
            IN phase' = IF allowed THEN "checked" ELSE "refused"
         /\ UNCHANGED <<defect, terminal, outcome>>
Continue == /\ phase = "checked" /\ phase' = "done"
            /\ outcome' = IF terminal THEN "reused" ELSE "executed"
            /\ UNCHANGED <<defect, terminal>>
Done == /\ phase \in {"done", "refused"} /\ UNCHANGED vars
Next == Check \/ Continue \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "checked", "refused", "done"}
          /\ defect \in Defects
          /\ terminal \in BOOLEAN /\ outcome \in {"none", "reused", "executed"}
SafeOutcome == outcome # "none" => defect = "none"
=============================================================================
