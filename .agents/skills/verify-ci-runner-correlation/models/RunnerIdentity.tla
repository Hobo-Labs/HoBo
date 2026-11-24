-------------------------- MODULE RunnerIdentity --------------------------
EXTENDS Naturals
VARIABLES leaseId, jobId, namesMatch, phase, matched, transfer
vars == <<leaseId, jobId, namesMatch, phase, matched, transfer>>
HasIds == leaseId > 0 /\ jobId > 0
SameRunner == IF HasIds THEN leaseId = jobId ELSE namesMatch
Init == /\ leaseId \in 0..2 /\ jobId \in 0..2 /\ namesMatch \in BOOLEAN
        /\ phase = "observed" /\ matched = FALSE /\ transfer = FALSE
Correlate == /\ phase = "observed" /\ phase' = "decided" /\ matched' = SameRunner
             /\ transfer' = SameRunner /\ UNCHANGED <<leaseId, jobId, namesMatch>>
Done == /\ phase = "decided" /\ UNCHANGED vars
Next == Correlate \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ leaseId \in 0..2 /\ jobId \in 0..2 /\ namesMatch \in BOOLEAN
          /\ phase \in {"observed", "decided"} /\ matched \in BOOLEAN /\ transfer \in BOOLEAN
NoConflictingIdTransfer == phase = "decided" /\ HasIds /\ leaseId # jobId => ~transfer /\ ~matched
EqualIdsMatch == phase = "decided" /\ HasIds /\ leaseId = jobId => matched
MissingIdUsesName == phase = "decided" /\ ~HasIds => (matched = namesMatch)
=============================================================================
