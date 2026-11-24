-------------------------- MODULE WorkflowTimers --------------------------
EXTENDS Naturals, Sequences
CONSTANT MaxCalls

Delays == {0, 1}
Histories == UNION { [1..n -> Delays] : n \in 0..MaxCalls }
VARIABLES journal, requested, cursor, phase
vars == <<journal, requested, cursor, phase>>

Init == /\ journal \in Histories
        /\ requested \in Histories
        /\ cursor = 0
        /\ phase = "checking"

Consume == /\ phase = "checking"
           /\ cursor < Len(requested)
           /\ IF cursor < Len(journal) /\ journal[cursor + 1] = requested[cursor + 1]
                 THEN /\ cursor' = cursor + 1 /\ phase' = phase
                 ELSE /\ cursor' = cursor /\ phase' = "rejected"
           /\ UNCHANGED <<journal, requested>>

Finish == /\ phase = "checking" /\ cursor = Len(requested)
          /\ phase' = IF cursor = Len(journal) THEN "accepted" ELSE "rejected"
          /\ UNCHANGED <<journal, requested, cursor>>

Done == /\ phase \in {"accepted", "rejected"} /\ UNCHANGED vars
Next == Consume \/ Finish \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ journal \in Histories /\ requested \in Histories
          /\ cursor \in 0..MaxCalls
          /\ phase \in {"checking", "accepted", "rejected"}
MatchedPrefix == \A i \in 1..cursor : journal[i] = requested[i]
AcceptedExact == phase = "accepted" => journal = requested
=============================================================================
