----------------------- MODULE TestingHarnessLifecycle -----------------------
EXTENDS Naturals
CONSTANTS PublishFirst, FenceRedeploy, JoinTeardown
VARIABLES phase, initialStarts, reentered, restartRequested, restartRejected,
          restarted, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce
vars == <<phase, initialStarts, reentered, restartRequested, restartRejected,
          restarted, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce>>
Init == /\ phase = "starting" /\ initialStarts = 1 /\ reentered = FALSE
        /\ restartRequested = FALSE /\ restartRejected = FALSE /\ restarted = FALSE
        /\ secondStopAsked = FALSE /\ secondStopSucceeded = FALSE /\ secondStopRejected = FALSE /\ failedOnce = FALSE
Reenter == /\ phase = "starting" /\ ~reentered
           /\ reentered' = TRUE
           /\ initialStarts' = IF PublishFirst THEN initialStarts ELSE initialStarts + 1
           /\ UNCHANGED <<phase, restartRequested, restartRejected, restarted, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce>>
RequestStop == /\ phase \in {"starting", "running"}
               /\ phase' = IF phase = "starting" THEN "closing-start" ELSE "closing"
               /\ UNCHANGED <<initialStarts, reentered, restartRequested, restartRejected, restarted, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce>>
StartDone == /\ phase \in {"starting", "closing-start"}
             /\ phase' = IF phase = "starting" THEN "running" ELSE "closing"
             /\ UNCHANGED <<initialStarts, reentered, restartRequested, restartRejected, restarted, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce>>
StopAgain == /\ phase \in {"closing-start", "closing"} /\ ~secondStopAsked
             /\ secondStopAsked' = TRUE /\ secondStopSucceeded' = ~JoinTeardown
             /\ UNCHANGED <<phase, initialStarts, reentered, restartRequested, restartRejected, restarted, secondStopRejected, failedOnce>>
RequestRestart == /\ phase \in {"closing-start", "closing", "failed"} /\ ~restartRequested
                  /\ restartRequested' = TRUE
                  /\ restartRejected' = (phase = "failed" /\ FenceRedeploy)
                  /\ restarted' = ~FenceRedeploy
                  /\ UNCHANGED <<phase, initialStarts, reentered, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce>>
CloseFails == /\ phase = "closing" /\ ~failedOnce
              /\ phase' = "failed" /\ failedOnce' = TRUE
              /\ restartRejected' = (restartRejected \/ restartRequested)
              /\ secondStopRejected' = secondStopAsked
              /\ UNCHANGED <<initialStarts, reentered, restartRequested, restarted, secondStopAsked, secondStopSucceeded>>
RetryClose == /\ phase = "failed" /\ phase' = "closing"
              /\ UNCHANGED <<initialStarts, reentered, restartRequested, restartRejected, restarted, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce>>
CloseSucceeds == /\ phase = "closing" /\ phase' = "closed"
                 /\ secondStopSucceeded' = (secondStopAsked /\ ~secondStopRejected)
                 /\ UNCHANGED <<initialStarts, reentered, restartRequested, restartRejected, restarted, secondStopAsked, secondStopRejected, failedOnce>>
Restart == /\ phase = "closed" /\ restartRequested /\ ~restartRejected /\ ~restarted
           /\ phase' = "restarted" /\ restarted' = TRUE
           /\ UNCHANGED <<initialStarts, reentered, restartRequested, restartRejected, secondStopAsked, secondStopSucceeded, secondStopRejected, failedOnce>>
Wait == UNCHANGED vars
Next == Reenter \/ RequestStop \/ StartDone \/ StopAgain \/ RequestRestart \/ CloseFails \/ RetryClose \/ CloseSucceeds \/ Restart \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"starting", "running", "closing-start", "closing", "failed", "closed", "restarted"}
          /\ initialStarts \in 1..2 /\ reentered \in BOOLEAN /\ restartRequested \in BOOLEAN
          /\ restartRejected \in BOOLEAN /\ restarted \in BOOLEAN /\ secondStopAsked \in BOOLEAN
          /\ secondStopSucceeded \in BOOLEAN /\ secondStopRejected \in BOOLEAN /\ failedOnce \in BOOLEAN
OneInitialStart == initialStarts = 1
NoOverlappingStart == ~restarted \/ phase \in {"closed", "restarted"}
NoEarlyDestroySuccess == ~secondStopSucceeded \/ phase \in {"closed", "restarted"}
=============================================================================
