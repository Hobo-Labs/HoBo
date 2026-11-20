-------------------- MODULE WorkflowTerminalHistory --------------------
EXTENDS Naturals
CONSTANT RejectDuplicates
VARIABLES facts, phase, calls
vars == <<facts, phase, calls>>
Init == /\ facts \in 0..2 /\ phase = "checking" /\ calls = 0
Check == /\ phase = "checking"
         /\ phase' = IF facts > 1 /\ RejectDuplicates THEN "rejected"
                      ELSE IF facts > 0 THEN "returned" ELSE "running"
         /\ UNCHANGED <<facts, calls>>
Run == /\ phase = "running" /\ calls = 0 /\ calls' = 1
       /\ UNCHANGED <<facts, phase>>
Done == UNCHANGED vars
Next == Check \/ Run \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ facts \in 0..2 /\ phase \in {"checking", "rejected", "returned", "running"} /\ calls \in 0..1
DuplicateHistoryRefused == facts > 1 => phase # "returned"
NoTerminalExecution == facts > 0 => calls = 0
=============================================================================
