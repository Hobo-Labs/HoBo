------------------------ MODULE WorkflowTreeResume ------------------------
EXTENDS Naturals, FiniteSets
Parents == {"A", "B"}
VARIABLES active, cursor, fact, effects, selected, premature, poisoned, badClose
vars == <<active, cursor, fact, effects, selected, premature, poisoned, badClose>>

Init == /\ active = {} /\ cursor = [p \in Parents |-> 0]
        /\ fact = [p \in Parents |-> FALSE] /\ effects = [p \in Parents |-> 0]
        /\ selected = [p \in Parents |-> "none"] /\ premature = FALSE
        /\ poisoned = FALSE /\ badClose = FALSE

Enter == \E p \in Parents:
         /\ ~poisoned /\ p \notin active /\ active' = active \cup {p}
         /\ cursor' = [cursor EXCEPT ![p] = 0]
         /\ UNCHANGED <<fact, effects, selected, premature, poisoned, badClose>>

Child == \E p \in Parents:
         /\ ~poisoned /\ p \in active /\ cursor[p] = 0
         /\ cursor' = [cursor EXCEPT ![p] = 1]
         /\ effects' = [effects EXCEPT ![p] = IF fact[p] THEN @ ELSE @ + 1]
         /\ fact' = [fact EXCEPT ![p] = TRUE]
         /\ selected' = [selected EXCEPT ![p] = p]
         /\ UNCHANGED <<active, premature, poisoned, badClose>>

Close == \E p \in Parents:
         /\ ~poisoned /\ p \in active /\ cursor[p] = 1 /\ active' = active \ {p}
         /\ premature' = (premature \/ (cursor[p] # 1))
         /\ badClose' = (badClose \/ poisoned)
         /\ UNCHANGED <<cursor, fact, effects, selected, poisoned>>

Crash == \E p \in Parents:
         /\ p \in active /\ active' = active \ {p}
         /\ UNCHANGED <<cursor, fact, effects, selected, premature, poisoned, badClose>>

Diverge == /\ ~poisoned /\ active # {} /\ poisoned' = TRUE
           /\ UNCHANGED <<active, cursor, fact, effects, selected, premature, badClose>>
Abort == /\ poisoned /\ active = {} /\ UNCHANGED vars
Next == Enter \/ Child \/ Close \/ Crash \/ Diverge \/ Abort
Spec == Init /\ [][Next]_vars
TypeOK == /\ active \subseteq Parents /\ cursor \in [Parents -> 0..1]
          /\ fact \in [Parents -> BOOLEAN] /\ effects \in [Parents -> 0..2]
          /\ selected \in [Parents -> (Parents \cup {"none"})] /\ premature \in BOOLEAN
          /\ poisoned \in BOOLEAN /\ badClose \in BOOLEAN
NoRepeatedRecordedEffect == \A p \in Parents: effects[p] <= 1
ParentIsolation == \A p \in Parents: selected[p] \in {"none", p}
NoSkippedChild == ~premature
NoCloseAfterDivergence == ~badClose
=============================================================================
