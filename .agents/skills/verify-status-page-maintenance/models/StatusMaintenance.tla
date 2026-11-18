-------------------------- MODULE StatusMaintenance --------------------------
EXTENDS Integers
CONSTANTS KeepTerminal, KeepPending
States == {"scheduled", "in-progress", "completed", "canceled"}
Terminal == {"completed", "canceled"}
Rank == [s \in States |-> IF s = "scheduled" THEN 0 ELSE IF s = "in-progress" THEN 1 ELSE 2]
VARIABLES scheduled, visible, pending, expected
vars == <<scheduled, visible, pending, expected>>
ActualNext(current, incoming) ==
  IF KeepTerminal /\ current \in Terminal THEN current
  ELSE IF Rank[incoming] >= Rank[current] THEN incoming ELSE current
ExpectedNext(current, incoming) ==
  CASE current = "completed" -> "completed"
    [] current = "canceled" -> "canceled"
    [] current = "in-progress" /\ incoming = "scheduled" -> "in-progress"
    [] OTHER -> incoming
Init == /\ scheduled = FALSE /\ visible = "none" /\ pending = "none"
        /\ expected = "scheduled"
Schedule == /\ ~scheduled /\ scheduled' = TRUE
            /\ visible' = IF pending = "none" THEN "scheduled" ELSE pending
            /\ pending' = "none" /\ UNCHANGED expected
Update(incoming) ==
  /\ incoming \in States
  /\ expected' = ExpectedNext(expected, incoming)
  /\ IF scheduled
        THEN /\ visible' = ActualNext(visible, incoming)
             /\ UNCHANGED <<scheduled, pending>>
        ELSE /\ pending' = IF KeepPending
                    THEN ActualNext(IF pending = "none" THEN "scheduled" ELSE pending, incoming)
                    ELSE pending
             /\ UNCHANGED <<scheduled, visible>>
Wait == UNCHANGED vars
Next == Schedule \/ (\E incoming \in States : Update(incoming)) \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ scheduled \in BOOLEAN /\ visible \in States \cup {"none"}
          /\ pending \in States \cup {"none"} /\ expected \in States
ProjectedHistory == IF scheduled THEN visible = expected
                    ELSE pending = expected \/ (pending = "none" /\ expected = "scheduled")
=============================================================================
