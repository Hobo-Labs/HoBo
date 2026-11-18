-------------------------- MODULE WorkflowResumeContext --------------------------
\* A record with one context defect, before either execution or terminal reuse.
CONSTANTS CheckInput, CheckName, CheckSeed
VARIABLES phase, version, defect, terminal, outcome
vars == <<phase, version, defect, terminal, outcome>>
Defects == {"none", "missing-input", "missing-name", "missing-seed", "bad-name", "bad-seed"}
Init == /\ phase = "received" /\ version \in {"old", "v3"}
        /\ defect \in Defects /\ terminal \in BOOLEAN /\ outcome = "none"
Check == /\ phase = "received"
         /\ LET badInput == version = "v3" /\ defect = "missing-input"
                badName == defect = "bad-name" \/ (version = "v3" /\ defect = "missing-name")
                badSeed == defect = "bad-seed" \/ (version = "v3" /\ defect = "missing-seed")
                allowed == /\ (~CheckInput \/ ~badInput)
                           /\ (~CheckName \/ ~badName)
                           /\ (~CheckSeed \/ ~badSeed)
            IN phase' = IF allowed THEN "checked" ELSE "refused"
         /\ UNCHANGED <<version, defect, terminal, outcome>>
Continue == /\ phase = "checked" /\ phase' = "done"
            /\ outcome' = IF terminal THEN "reused" ELSE "executed"
            /\ UNCHANGED <<version, defect, terminal>>
Done == /\ phase \in {"done", "refused"} /\ UNCHANGED vars
Next == Check \/ Continue \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"received", "checked", "refused", "done"}
          /\ version \in {"old", "v3"} /\ defect \in Defects
          /\ terminal \in BOOLEAN /\ outcome \in {"none", "reused", "executed"}
SafeOutcome == outcome # "none" =>
  /\ ~(version = "v3" /\ defect \in {"missing-input", "missing-name", "missing-seed"})
  /\ defect \notin {"bad-name", "bad-seed"}
=============================================================================
