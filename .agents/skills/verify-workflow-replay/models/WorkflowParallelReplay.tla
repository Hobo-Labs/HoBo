-------------------- MODULE WorkflowParallelReplay --------------------
EXTENDS Naturals
CONSTANTS EnforceSchedule, EnforceName, ReuseLater
VARIABLES scheduled, sameName, phase, earlierCalls, laterCalls
vars == <<scheduled, sameName, phase, earlierCalls, laterCalls>>

Init == /\ scheduled \in BOOLEAN
        /\ sameName \in BOOLEAN
        /\ phase = "checking"
        /\ earlierCalls = 0
        /\ laterCalls = 0

Check == /\ phase = "checking"
         /\ phase' = IF EnforceSchedule /\ ~scheduled THEN "rejected" ELSE "running"
         /\ UNCHANGED <<scheduled, sameName, earlierCalls, laterCalls>>

ResumeEarlier == /\ phase = "running"
                 /\ IF EnforceName /\ ~sameName
                       THEN /\ phase' = "rejected"
                            /\ UNCHANGED earlierCalls
                       ELSE /\ phase' = "replaying-later"
                            /\ earlierCalls' = earlierCalls + 1
                 /\ UNCHANGED <<scheduled, sameName, laterCalls>>

ResumeLater == /\ phase = "replaying-later"
               /\ laterCalls' = IF ReuseLater THEN laterCalls ELSE laterCalls + 1
               /\ phase' = "completed"
               /\ UNCHANGED <<scheduled, sameName, earlierCalls>>

Done == UNCHANGED vars
Next == Check \/ ResumeEarlier \/ ResumeLater \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ scheduled \in BOOLEAN /\ sameName \in BOOLEAN
          /\ phase \in {"checking", "running", "replaying-later", "completed", "rejected"}
          /\ earlierCalls \in 0..1 /\ laterCalls \in 0..1
NoUnscheduledEffect == ~scheduled => earlierCalls = 0
NoDifferentNameEffect == ~sameName => earlierCalls = 0
NoRecordedEffectRepeated == laterCalls = 0
NoValidRecovery == ~(phase = "completed" /\ scheduled /\ sameName
                     /\ earlierCalls = 1 /\ laterCalls = 0)
=============================================================================
