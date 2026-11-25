----------------------- MODULE RunnerUnknownStatus -----------------------
EXTENDS Naturals
VARIABLES first, second, mode, phase, selected, incomplete, blocked, transferred
vars == <<first, second, mode, phase, selected, incomplete, blocked, transferred>>
Statuses == {"executing", "unknown", "queued", "completed", "none"}
Rank(s) == CASE s = "executing" -> 4 [] s = "unknown" -> 3
             [] s = "queued" -> 2 [] s = "completed" -> 1 [] OTHER -> 0
Best(a, b) == IF Rank(a) >= Rank(b) THEN a ELSE b
Init == /\ first \in Statuses /\ second \in Statuses
        /\ mode \in {"strict", "force"}
        /\ phase = "start" /\ selected = "none" /\ incomplete = FALSE
        /\ blocked = FALSE /\ transferred = FALSE
ObserveFirst == /\ phase = "start" /\ phase' = "scanning" /\ selected' = first
                /\ UNCHANGED <<first, second, mode, incomplete, blocked, transferred>>
Complete == /\ phase = "scanning" /\ phase' = "observed" /\ selected' = Best(selected, second)
            /\ UNCHANGED <<first, second, mode, incomplete, blocked, transferred>>
Fail == /\ phase = "scanning" /\ phase' = "observed" /\ incomplete' = TRUE
        /\ UNCHANGED <<first, second, mode, selected, blocked, transferred>>
Decide == /\ phase = "observed" /\ phase' = "done"
          /\ blocked' = ((selected \in {"executing", "unknown"}) \/ (incomplete /\ mode = "strict"))
          /\ transferred' = ((selected \in {"executing", "queued", "completed"}) /\ ~incomplete)
          /\ UNCHANGED <<first, second, mode, selected, incomplete>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == ObserveFirst \/ Complete \/ Fail \/ Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ first \in Statuses /\ second \in Statuses /\ selected \in Statuses
          /\ mode \in {"strict", "force"}
          /\ phase \in {"start", "scanning", "observed", "done"}
          /\ incomplete \in BOOLEAN /\ blocked \in BOOLEAN /\ transferred \in BOOLEAN
ObservedUnknownBlocks == phase = "done" /\ selected = "unknown" => blocked
UnknownCannotTransfer == phase = "done" /\ selected = "unknown" => ~transferred
IncompleteCannotTransfer == phase = "done" /\ incomplete => ~transferred
ExecutingWins == phase = "done" /\ ~incomplete /\ (first = "executing" \/ second = "executing") => selected = "executing" /\ blocked
UnknownBeatsQueued == phase = "done" /\ ~incomplete /\ (first = "unknown" \/ second = "unknown") /\ first # "executing" /\ second # "executing" => selected = "unknown" /\ blocked
=============================================================================
