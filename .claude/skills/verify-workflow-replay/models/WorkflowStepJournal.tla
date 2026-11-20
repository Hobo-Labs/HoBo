-------------------- MODULE WorkflowStepJournal --------------------
EXTENDS Integers
CONSTANT EnforceConsumption
VARIABLES maxIndex, failureIndex, consumed, caught, phase
vars == <<maxIndex, failureIndex, consumed, caught, phase>>

Init == /\ maxIndex \in -1..2
        /\ failureIndex \in -1..maxIndex
        /\ consumed = 0
        /\ caught = FALSE
        /\ phase = "running"

ReplayCompleted == /\ phase = "running"
                   /\ consumed <= maxIndex
                   /\ consumed # failureIndex
                   /\ consumed' = consumed + 1
                   /\ UNCHANGED <<maxIndex, failureIndex, caught, phase>>

ReplayFailed == /\ phase = "running"
                /\ consumed = failureIndex
                /\ consumed' = consumed + 1
                /\ phase' = "handling-failure"
                /\ UNCHANGED <<maxIndex, failureIndex, caught>>

CatchFailure == /\ phase = "handling-failure"
                /\ caught' = TRUE
                /\ phase' = "running"
                /\ UNCHANGED <<maxIndex, failureIndex, consumed>>

PropagateFailure == /\ phase = "handling-failure"
                    /\ phase' = "finishing-failure"
                    /\ UNCHANGED <<maxIndex, failureIndex, consumed, caught>>

BodySucceeded == /\ phase = "running"
                 /\ phase' = "finishing-success"
                 /\ UNCHANGED <<maxIndex, failureIndex, consumed, caught>>

BodyFailed == /\ phase = "running"
              /\ phase' = "finishing-failure"
              /\ UNCHANGED <<maxIndex, failureIndex, consumed, caught>>

FinishSucceeded == /\ phase = "finishing-success"
                   /\ phase' = IF EnforceConsumption /\ consumed <= maxIndex
                                THEN "rejected"
                                ELSE "completed"
                   /\ UNCHANGED <<maxIndex, failureIndex, consumed, caught>>

FinishFailed == /\ phase = "finishing-failure"
                /\ phase' = IF EnforceConsumption /\ consumed <= maxIndex
                             THEN "rejected"
                             ELSE "failed"
                /\ UNCHANGED <<maxIndex, failureIndex, consumed, caught>>

Done == UNCHANGED vars
Next == ReplayCompleted \/ ReplayFailed \/ CatchFailure \/ PropagateFailure
        \/ BodySucceeded \/ BodyFailed \/ FinishSucceeded \/ FinishFailed \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ maxIndex \in -1..2
          /\ failureIndex \in -1..maxIndex
          /\ consumed \in 0..3
          /\ caught \in BOOLEAN
          /\ phase \in {"running", "handling-failure", "finishing-success",
                         "finishing-failure", "rejected", "completed", "failed"}
NoUnconsumedTerminal == phase \in {"completed", "failed"} => consumed > maxIndex
CatchRequiresFailure == caught => failureIndex >= 0 /\ consumed > failureIndex
NoCompletionWithUnhandledFailure == phase = "completed" /\ failureIndex >= 0 => caught
NoCompensatedCompletion == ~(phase = "completed" /\ caught /\ failureIndex < maxIndex)
=============================================================================
