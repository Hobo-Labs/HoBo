------------------------ MODULE WorkflowReplay ------------------------
EXTENDS Naturals
CONSTANT MaxCalls
VARIABLES phase, journaled, calls, replayedAfterJournal
vars == <<phase, journaled, calls, replayedAfterJournal>>

Init == /\ phase = "idle"
        /\ journaled = FALSE
        /\ calls = 0
        /\ replayedAfterJournal = FALSE

Start == /\ phase = "idle"
         /\ phase' = "running"
         /\ UNCHANGED <<journaled, calls, replayedAfterJournal>>

RunStep == /\ phase = "running"
           /\ IF journaled
                 THEN /\ phase' = "done"
                      /\ UNCHANGED <<journaled, calls, replayedAfterJournal>>
                 ELSE /\ calls < MaxCalls
                      /\ phase' = "effect-returned"
                      /\ calls' = calls + 1
                      /\ replayedAfterJournal' = (replayedAfterJournal \/ journaled)
                      /\ UNCHANGED journaled

JournalResult == /\ phase = "effect-returned"
                 /\ phase' = "recorded"
                 /\ journaled' = TRUE
                 /\ UNCHANGED <<calls, replayedAfterJournal>>

Finish == /\ phase = "recorded"
          /\ phase' = "done"
          /\ UNCHANGED <<journaled, calls, replayedAfterJournal>>

Crash == /\ phase \in {"running", "effect-returned", "recorded"}
         /\ phase' = "crashed"
         /\ UNCHANGED <<journaled, calls, replayedAfterJournal>>

Restart == /\ phase = "crashed"
           /\ phase' = "running"
           /\ UNCHANGED <<journaled, calls, replayedAfterJournal>>

Done == /\ phase = "done" /\ UNCHANGED vars
Next == Start \/ RunStep \/ JournalResult \/ Finish \/ Crash \/ Restart \/ Done
Spec == Init /\ [][Next]_vars
NoJournaledReexecution == ~replayedAfterJournal
TypeOK == /\ phase \in {"idle", "running", "effect-returned", "recorded", "crashed", "done"}
          /\ journaled \in BOOLEAN
          /\ calls \in 0..MaxCalls
          /\ replayedAfterJournal \in BOOLEAN
=============================================================================
