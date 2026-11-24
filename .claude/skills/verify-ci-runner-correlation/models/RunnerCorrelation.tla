------------------------- MODULE RunnerCorrelation -------------------------
EXTENDS Naturals
Statuses == {"executing", "queued", "finished"}
VARIABLES reserved, other, selected, stopped
vars == <<reserved, other, selected, stopped>>

Init == /\ reserved \in Statuses /\ other \in Statuses
        /\ selected = "none" /\ stopped = FALSE

Resolve == /\ selected = "none"
           /\ selected' = IF reserved = "executing" THEN "reserved"
                          ELSE IF other = "executing" THEN "other"
                          ELSE IF reserved = "queued" THEN "reserved"
                          ELSE IF other = "queued" THEN "other"
                          ELSE "reserved"
           /\ UNCHANGED <<reserved, other, stopped>>
SelectedStatus == IF selected = "reserved" THEN reserved ELSE other
Teardown == /\ selected # "none" /\ SelectedStatus # "executing"
            /\ ~stopped /\ stopped' = TRUE
            /\ UNCHANGED <<reserved, other, selected>>
Done == /\ selected # "none" /\ UNCHANGED vars
Next == Resolve \/ Teardown \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ reserved \in Statuses /\ other \in Statuses
          /\ selected \in {"none", "reserved", "other"} /\ stopped \in BOOLEAN
ExecutingSelected == selected # "none" /\ (reserved = "executing" \/ other = "executing")
                     => SelectedStatus = "executing"
NoTeardownDuringExecution == stopped => reserved # "executing" /\ other # "executing"
=============================================================================
