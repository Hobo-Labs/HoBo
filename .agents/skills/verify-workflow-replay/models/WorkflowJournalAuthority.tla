---------------------- MODULE WorkflowJournalAuthority ----------------------
EXTENDS Naturals
VARIABLES attempted, fact, evidence, decision
vars == <<attempted, fact, evidence, decision>>

Init == /\ attempted = FALSE /\ fact = "none" /\ evidence = TRUE
        /\ decision = "unchecked"

AppAttempt == /\ ~attempted /\ fact = "none" /\ attempted' = TRUE
              /\ fact' = fact
              /\ UNCHANGED <<evidence, decision>>
EngineFinish == /\ fact = "none" /\ fact' = "engine"
                /\ UNCHANGED <<attempted, evidence, decision>>
DamageEvidence == /\ fact # "none" /\ evidence /\ decision = "unchecked"
                  /\ evidence' = FALSE /\ UNCHANGED <<attempted, fact, decision>>
Resume == /\ fact # "none" /\ decision = "unchecked"
          /\ decision' = IF evidence THEN "accepted" ELSE "rejected"
          /\ UNCHANGED <<attempted, fact, evidence>>
Done == /\ decision # "unchecked" /\ UNCHANGED vars
Next == AppAttempt \/ EngineFinish \/ DamageEvidence \/ Resume \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ attempted \in BOOLEAN /\ fact \in {"none", "engine", "forged"}
          /\ evidence \in BOOLEAN /\ decision \in {"unchecked", "accepted", "rejected"}
NoForgedTerminal == decision = "accepted" => fact = "engine"
NoUnprovenTerminal == decision = "accepted" => evidence
=============================================================================
