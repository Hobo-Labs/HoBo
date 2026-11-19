------------------------ MODULE WorkflowReplay ------------------------
EXTENDS Naturals
CONSTANT MaxCalls
VARIABLES phase, journaled, calls, journaledCalls
vars == <<phase, journaled, calls, journaledCalls>>

Init == /\ phase = "idle"
        /\ journaled = FALSE
        /\ calls = 0
        /\ journaledCalls = 0

Start == /\ phase = "idle"
         /\ phase' = "running"
         /\ UNCHANGED <<journaled, calls, journaledCalls>>

RunStep == /\ phase = "running"
           /\ IF journaled
                 THEN /\ phase' = "done"
                      /\ UNCHANGED <<journaled, calls, journaledCalls>>
                 ELSE /\ calls < MaxCalls
                      /\ phase' = "effect-returned"
                      /\ calls' = calls + 1
                      /\ UNCHANGED <<journaled, journaledCalls>>

JournalResult == /\ phase = "effect-returned"
                 /\ phase' = "recorded"
                 /\ journaled' = TRUE
                 /\ journaledCalls' = calls
                 /\ UNCHANGED calls

Finish == /\ phase = "recorded"
          /\ phase' = "done"
          /\ UNCHANGED <<journaled, calls, journaledCalls>>

Crash == /\ phase \in {"running", "effect-returned", "recorded"}
         /\ phase' = "crashed"
         /\ UNCHANGED <<journaled, calls, journaledCalls>>

Restart == /\ phase = "crashed"
           /\ phase' = "running"
           /\ UNCHANGED <<journaled, calls, journaledCalls>>

Done == /\ phase = "done" /\ UNCHANGED vars
Next == Start \/ RunStep \/ JournalResult \/ Finish \/ Crash \/ Restart \/ Done
Spec == Init /\ [][Next]_vars
NoJournaledReexecution == journaled => calls = journaledCalls
TypeOK == /\ phase \in {"idle", "running", "effect-returned", "recorded", "crashed", "done"}
          /\ journaled \in BOOLEAN
          /\ calls \in 0..MaxCalls
          /\ journaledCalls \in 0..MaxCalls
=============================================================================
