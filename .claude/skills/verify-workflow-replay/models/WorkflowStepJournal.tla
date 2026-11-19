-------------------- MODULE WorkflowStepJournal --------------------
EXTENDS Integers
CONSTANTS EnforceConsumption, RejectPostFailure
VARIABLES maxIndex, failureIndex, consumed, phase
vars == <<maxIndex, failureIndex, consumed, phase>>

Init == /\ maxIndex \in -1..2
        /\ failureIndex \in -1..maxIndex
        /\ consumed = 0
        /\ phase = "checking"

Check == /\ phase = "checking"
         /\ phase' = IF RejectPostFailure
                         /\ failureIndex >= 0
                         /\ failureIndex < maxIndex
                      THEN "rejected"
                      ELSE "running"
         /\ UNCHANGED <<maxIndex, failureIndex, consumed>>

ReplayCompleted == /\ phase = "running"
                   /\ consumed <= maxIndex
                   /\ consumed # failureIndex
                   /\ consumed' = consumed + 1
                   /\ UNCHANGED <<maxIndex, failureIndex, phase>>

ReplayFailed == /\ phase = "running"
                /\ consumed = failureIndex
                /\ consumed' = consumed + 1
                /\ phase' = "finishing-failure"
                /\ UNCHANGED <<maxIndex, failureIndex>>

BodySucceeded == /\ phase = "running"
                 /\ phase' = "finishing-success"
                 /\ UNCHANGED <<maxIndex, failureIndex, consumed>>

BodyFailed == /\ phase = "running"
              /\ phase' = "finishing-failure"
              /\ UNCHANGED <<maxIndex, failureIndex, consumed>>

FinishSucceeded == /\ phase = "finishing-success"
                   /\ phase' = IF EnforceConsumption /\ consumed <= maxIndex
                                THEN "rejected"
                                ELSE "completed"
                   /\ UNCHANGED <<maxIndex, failureIndex, consumed>>

FinishFailed == /\ phase = "finishing-failure"
                /\ phase' = IF EnforceConsumption /\ consumed <= maxIndex
                             THEN "rejected"
                             ELSE "failed"
                /\ UNCHANGED <<maxIndex, failureIndex, consumed>>

Done == UNCHANGED vars
Next == Check \/ ReplayCompleted \/ ReplayFailed \/ BodySucceeded \/ BodyFailed
        \/ FinishSucceeded \/ FinishFailed \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ maxIndex \in -1..2
          /\ failureIndex \in -1..maxIndex
          /\ consumed \in 0..3
          /\ phase \in {"checking", "running", "finishing-success",
                         "finishing-failure", "rejected", "completed", "failed"}
NoUnconsumedTerminal == phase \in {"completed", "failed"} => consumed > maxIndex
PostFailureHistoryRefused == failureIndex >= 0 /\ failureIndex < maxIndex
                             => phase \in {"checking", "rejected"}
NoCompletionAfterStepFailure == failureIndex >= 0 => phase # "completed"
=============================================================================
