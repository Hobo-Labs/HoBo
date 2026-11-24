--------------------- MODULE WorkflowSleepCompletion ---------------------
EXTENDS Naturals
CONSTANT Deadline, MaxTime
VARIABLES now, phase, fact, writes, returned
vars == <<now, phase, fact, writes, returned>>

Init == /\ now = 0 /\ phase = "waiting" /\ fact = FALSE
        /\ writes = 0 /\ returned = FALSE

Advance == /\ now < MaxTime /\ now' = now + 1
           /\ UNCHANGED <<phase, fact, writes, returned>>

Write == /\ phase = "waiting" /\ now >= Deadline /\ ~fact
         /\ fact' = TRUE /\ writes' = writes + 1
         /\ phase' \in {"waiting", "crashed"}
         /\ UNCHANGED <<now, returned>>

Crash == /\ phase = "waiting" /\ phase' = "crashed"
         /\ UNCHANGED <<now, fact, writes, returned>>

Resume == /\ phase = "crashed" /\ phase' = "waiting"
          /\ UNCHANGED <<now, fact, writes, returned>>

Return == /\ phase = "waiting" /\ fact /\ ~returned
          /\ returned' = TRUE /\ phase' = "done"
          /\ UNCHANGED <<now, fact, writes>>

Done == /\ phase = "done" /\ UNCHANGED vars
Next == Advance \/ Write \/ Crash \/ Resume \/ Return \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ now \in 0..MaxTime /\ phase \in {"waiting", "crashed", "done"}
          /\ fact \in BOOLEAN /\ returned \in BOOLEAN /\ writes \in 0..2
AtMostOneCompletion == writes <= 1
NoEarlyCompletion == fact => now >= Deadline
ReturnRequiresFact == returned => fact
=============================================================================
