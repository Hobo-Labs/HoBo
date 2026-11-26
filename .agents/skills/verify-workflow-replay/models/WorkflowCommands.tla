------------------------- MODULE WorkflowCommands -------------------------
EXTENDS Naturals, Sequences
CONSTANT MaxCalls
Commands == {"step-a", "step-b", "sleep"}
Histories == UNION { [1..n -> Commands] : n \in 0..MaxCalls }
VARIABLES recorded, requested, cursor, phase
vars == <<recorded, requested, cursor, phase>>

Init == /\ recorded \in Histories /\ requested \in Histories
        /\ cursor = 0 /\ phase = "checking"

Consume == /\ phase = "checking" /\ cursor < Len(requested)
           /\ IF cursor >= Len(recorded) \/ recorded[cursor + 1] = requested[cursor + 1]
                 THEN /\ cursor' = cursor + 1 /\ phase' = phase
                 ELSE /\ cursor' = cursor /\ phase' = "rejected"
           /\ UNCHANGED <<recorded, requested>>

Finish == /\ phase = "checking" /\ cursor = Len(requested)
          /\ phase' = IF cursor >= Len(recorded) THEN "accepted" ELSE "rejected"
          /\ UNCHANGED <<recorded, requested, cursor>>

Done == /\ phase \in {"accepted", "rejected"} /\ UNCHANGED vars
Next == Consume \/ Finish \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ recorded \in Histories /\ requested \in Histories
          /\ cursor \in 0..MaxCalls /\ phase \in {"checking", "accepted", "rejected"}
MatchedHistory == \A i \in 1..cursor : i <= Len(recorded) => recorded[i] = requested[i]
AcceptedRecordedPrefix == phase = "accepted" =>
                          /\ Len(recorded) <= Len(requested)
                          /\ \A i \in 1..Len(recorded) : recorded[i] = requested[i]
=============================================================================
